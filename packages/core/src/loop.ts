// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  type Code,
  type Event,
  type Id,
  type JsonValue,
  type RunConfig,
} from "@harness/schemas";
import type { Context, Link } from "@opentelemetry/api";
import { activeRuns } from "@harness/telemetry";
import { BudgetTracker, type BudgetViolation } from "./budgets.js";
import { createRunCheckpointer, type Checkpointer } from "./checkpoint.js";
import { foldRunState, isTerminalRunState, planLastModelResponseRecovery } from "./run-state.js";
import type { RunState } from "./run-state.js";
import type { Clock, RunRecorder } from "./recorder.js";
import { withRunStartup } from "./run-startup.js";
import type { ModelStepResult } from "./steps/model-step.js";
import { requestModel } from "./steps/request-model.js";
import { preflightModelBudget, recordBudgetFailureAndCheckpoint } from "./steps/model-preflight.js";
import { toolStep } from "./steps/tool-step.js";
import type { PreparedToolCall } from "./steps/prepare-tool.js";
import { suspendedOutcome } from "./steps/suspended-outcome.js";
import { suspendForShutdown } from "./steps/shutdown.js";
import type {
  ContextPort,
  IdGenerator,
  ModelPort,
  NewRunMetadata,
  PolicyPort,
  RunContinuationMetadata,
  ToolPort,
} from "./ports.js";
import type { WorkspaceSnapshotPort } from "@harness/sandbox";
import { compactBeforeModelCall, type CompactionRuntimeOptions } from "./steps/compaction-step.js";
import { recordRunCompleted, runStructuredFinalOutput } from "./steps/final-output.js";
import type { ValueTransform } from "@harness/models";
import type { z } from "zod";

/** Dependencies and initial input for a new run. */
export interface RunLoopOptions extends NewRunMetadata, RunContinuationMetadata {
  readonly recorder: RunRecorder;
  readonly clock: Clock;
  readonly model: ModelPort;
  readonly tool: ToolPort;
  readonly policy?: PolicyPort;
  readonly context: ContextPort;
  readonly ids: IdGenerator;
  readonly goal: JsonValue;
  readonly signal: AbortSignal;
  /** Called after the initial event batch has been durably appended. */
  readonly onStarted?: () => void;
  /** Checks durable startup preconditions before the first execution step. */
  readonly shouldContinue?: (events: Event[]) => Promise<boolean>;
  /** Per-run limits sourced from the validated run configuration. */
  readonly budgets: RunConfig["budgets"];
  /** Absolute inherited deadline preserved across child startup and resume. */
  readonly deadlineTs?: number;
  /** Optional inherited budget failure to record before executing this run. */
  readonly initialBudgetViolation?: BudgetViolation;
  readonly checkpointEveryEvents?: RunConfig["checkpointEveryEvents"];
  readonly snapshotKeep?: number;
  readonly workspaceSnapshotter?: WorkspaceSnapshotPort;
  readonly role?: Code;
  readonly provider?: Code;
  readonly modelName?: Code;
  /** Optional role result contract enforced on the child's final model call. */
  readonly finalOutputSchema?: z.ZodType;
  /** Token-aware validation hook for the final structured result. */
  readonly valueTransform?: ValueTransform;
  /** Optional summarization compaction, checked before every model call. */
  readonly compaction?: CompactionRuntimeOptions;
  /** Parent context and link for a child run's root span. */
  readonly rootSpanParent?: Context;
  readonly rootSpanLinks?: readonly Link[];
}

/** Execution options shared by new runs and resumptions. */
export type RunLoopExecutionOptions = Omit<RunLoopOptions, "configHash" | "policyVersion">;

/** Final state and ordered events produced by a run. */
export interface RunLoopResult {
  readonly status: RunState["status"];
  readonly approvalIds: readonly Id[];
  readonly state: RunState;
  readonly events: readonly Event[];
}

/** Internal dependencies retained while a run loop continues across model steps. */
export interface RunLoopExecution extends Pick<Event, "runId"> {
  readonly checkpointer: Checkpointer;
  readonly budgetTracker: BudgetTracker;
}

class RunAbortedError extends HarnessError {
  readonly code = "run_aborted";

  constructor() {
    super("Run was aborted.");
  }
}

/**
 * Runs a new model-driven run until a final answer or a configured budget is exceeded.
 *
 * @param options - Ports, recorder, deterministic ID source, and initial run input.
 * @returns The final folded state and all events created by this invocation.
 */
export async function runLoop(options: RunLoopOptions): Promise<RunLoopResult> {
  const events: Event[] = [];
  const budgetTracker = new BudgetTracker(
    options.budgets,
    options.initialBudgetViolation,
    options.deadlineTs,
  );
  await withRunStartup(options, events, async (runId) => {
    await drainSentinelTrips(options.recorder, events);
    return continueRunLoop(options, events, runId, budgetTracker);
  });
  const state = foldRunState(events);
  return {
    status: state.status,
    approvalIds: Array.from(state.pendingApprovals.keys()),
    state,
    events,
  };
}

/**
 * Continues a run from its already-folded event history within the active run span.
 *
 * @param options - Ports and runtime settings for this segment.
 * @param events - Complete validated history, extended in place by the loop.
 * @param runId - Identifier of the existing run.
 * @param budgetTracker - Budget tracker initialized for this run or resume.
 * @returns The final event produced by the continued loop.
 */
export async function continueRunLoop(
  options: RunLoopExecutionOptions,
  events: Event[],
  runId: Id,
  budgetTracker = new BudgetTracker(options.budgets, undefined, options.deadlineTs),
): Promise<Event> {
  const checkpointer = createRunCheckpointer(options, runId);
  const execution = { runId, checkpointer, budgetTracker };
  const isTerminal = () => isTerminalRunState(foldRunState(events));
  return activeRuns.track(runId, () => runLoopSteps(options, events, execution), isTerminal);
}

async function recoverInterruptedModelResponse(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
): Promise<Event | undefined> {
  const recovery = planLastModelResponseRecovery(events);
  if (recovery.kind === "final_answer") {
    const lastResponse = events.findLast((event) => event.type === "model_response");
    if (
      options.finalOutputSchema !== undefined &&
      (lastResponse?.type !== "model_response" || lastResponse.rungUsed === undefined)
    ) {
      return finishStructuredFinalOutput(options, events, execution);
    }
    return recordRunCompleted(options.recorder, events, execution.checkpointer);
  }
  if (recovery.kind === "tool_calls") {
    return runToolCalls(
      options,
      events,
      execution,
      recovery.calls.map((call) => ({ call })),
    );
  }
  return undefined;
}

async function runLoopSteps(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
): Promise<Event> {
  const recovered = await recoverInterruptedModelResponse(options, events, execution);
  if (recovered !== undefined) {
    return recovered;
  }
  for (;;) {
    await drainSentinelTrips(options.recorder, events);
    const aborted = await suspendIfShutdown(options, events, execution);
    if (aborted !== undefined) {
      return aborted;
    }
    const preflight = await preflightModelBudget({
      budgetTracker: execution.budgetTracker,
      checkpointer: execution.checkpointer,
      events,
      budgets: options.budgets,
      now: options.clock.now(),
      recorder: options.recorder,
    });
    if (preflight.event !== undefined) {
      return preflight.event;
    }
    await compactBeforeModelCall({
      recorder: options.recorder,
      events,
      compaction: options.compaction,
      model: options.model,
      ids: options.ids,
      runId: execution.runId,
      signal: options.signal,
      modelRef: {
        provider: options.provider ?? "unknown",
        model: options.modelName ?? "unknown",
      },
      goal: options.goal,
      deadlineTs: preflight.deadlineTs,
    });
    const prepared = await prepareModelStep(options, events, execution);
    if (prepared.event !== undefined) {
      return prepared.event;
    }
    const modelResult = await requestModel(
      {
        recorder: options.recorder,
        model: options.model,
        tool: options.tool,
        ids: options.ids,
        runId: execution.runId,
        messages: prepared.context,
        contextMetadata: prepared.contextMetadata,
        signal: options.signal,
        deadlineTs: prepared.deadlineTs,
        ...(options.role === undefined ? {} : { role: options.role }),
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.modelName === undefined ? {} : { modelName: options.modelName }),
      },
      options.context,
    );
    events.push(...modelResult.events);
    await drainSentinelTrips(options.recorder, events);
    const stoppedAfterModel = await suspendAfterModel(options, events, execution, modelResult);
    if (stoppedAfterModel !== undefined) {
      return stoppedAfterModel;
    }
    const next = await finishModelStep(options, events, execution, modelResult);
    if (next !== undefined) {
      return next;
    }
  }
}

async function finishModelStep(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
  modelResult: ModelStepResult,
): Promise<Event | undefined> {
  const stepState = await checkpointAfterStep(execution.checkpointer, events);
  if (stepState.status === "suspended" || modelResult.outcome === "aborted") {
    return suspendedOutcome(events);
  }
  if (modelResult.outcome === "failed") {
    const failedEvent = modelResult.events.at(-1);
    if (failedEvent === undefined) {
      throw new Error("Expected the model step to record a failure.");
    }
    return failedEvent;
  }
  if (modelResult.preparedCalls.length > 0) {
    return runToolCalls(options, events, execution, modelResult.preparedCalls);
  }
  if (options.finalOutputSchema !== undefined) {
    return finishStructuredFinalOutput(options, events, execution);
  }
  return recordRunCompleted(options.recorder, events, execution.checkpointer);
}

async function finishStructuredFinalOutput(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
): Promise<Event> {
  return runStructuredFinalOutput(options, events, execution);
}

async function prepareModelStep(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
) {
  const builtContext =
    options.previousEventLogs === undefined
      ? await options.context.build(events.slice())
      : await options.context.build(events.slice(), options.previousEventLogs);
  const contextMetadata = builtContext.metadata;
  const preflight = await preflightModelBudget({
    budgetTracker: execution.budgetTracker,
    checkpointer: execution.checkpointer,
    events,
    budgets: options.budgets,
    now: options.clock.now(),
    recorder: options.recorder,
  });
  if (preflight.event !== undefined) {
    return { context: builtContext.messages, contextMetadata, ...preflight };
  }
  const stopped = await suspendIfShutdown(options, events, execution);
  return stopped === undefined
    ? { context: builtContext.messages, contextMetadata, deadlineTs: preflight.deadlineTs }
    : { context: builtContext.messages, contextMetadata, ...preflight, event: stopped };
}

async function runToolCalls(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
  calls: readonly PreparedToolCall[],
): Promise<Event | undefined> {
  for (const prepared of calls) {
    const call = prepared.call;
    const aborted = await suspendIfShutdown(options, events, execution);
    if (aborted !== undefined) {
      return aborted;
    }
    const budget = execution.budgetTracker.checkWithOpenChildren(events, options.clock.now());
    if (!budget.ok) {
      return recordBudgetFailureAndCheckpoint(
        options.recorder,
        events,
        budget,
        execution.checkpointer,
      );
    }
    events.push(
      ...(await toolStep({
        recorder: options.recorder,
        tool: options.tool,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        clock: options.clock,
        runId: execution.runId,
        ids: options.ids,
        checkpointer: execution.checkpointer,
        history: events,
        calls: [call],
        preparedCalls: [prepared],
        signal: options.signal,
        depth: options.depth ?? 0,
      })),
    );
    await drainSentinelTrips(options.recorder, events);
    const stopped = await suspendIfShutdown(options, events, execution);
    if (stopped !== undefined) {
      return stopped;
    }
    const state = await checkpointAfterStep(execution.checkpointer, events);
    if (state.status === "suspended") {
      return suspendedOutcome(events);
    }
  }
  return undefined;
}

async function suspendIfShutdown(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
): Promise<Event | undefined> {
  if (!options.signal.aborted) {
    return undefined;
  }
  if (options.signal.reason !== "shutdown") {
    throw new RunAbortedError();
  }
  return suspendForShutdown(options.recorder, events, execution.checkpointer);
}

async function suspendAfterModel(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
  result: ModelStepResult,
): Promise<Event | undefined> {
  if (result.outcome === "aborted") {
    return suspendForShutdown(options.recorder, events, execution.checkpointer);
  }
  if (result.outcome === "failed") {
    return undefined;
  }
  return suspendIfShutdown(options, events, execution);
}

async function drainSentinelTrips(recorder: RunRecorder, events: Event[]): Promise<void> {
  events.push(...(await recorder.drainTrips()));
}

async function checkpointAfterStep(checkpointer: Checkpointer, events: Event[]): Promise<RunState> {
  const state = foldRunState(events);
  const checkpoint = await checkpointer.maybeCheckpoint(state);
  if (checkpoint !== undefined) {
    events.push(checkpoint);
    return foldRunState(events);
  }
  return state;
}
