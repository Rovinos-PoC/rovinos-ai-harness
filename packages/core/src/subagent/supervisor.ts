// SPDX-License-Identifier: Apache-2.0
import {
  context as otelContext,
  isSpanContextValid,
  ROOT_CONTEXT,
  trace,
  type Context,
  type Link,
  type SpanContext,
} from "@opentelemetry/api";
import {
  HarnessError,
  type Code,
  type Event,
  type Id,
  type JsonValue,
  type RunConfig,
} from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { IdGenerator, ModelToolCall, RunContext, ToolPort } from "../ports.js";
import type { Clock } from "../recorder.js";
import { foldRunState } from "../run-state.js";
import type { ResolvedRole } from "../roles.js";
import type { RunScopeRegistry } from "./scope.js";
import type { SubagentResult } from "./result.js";
import { aggregateSubagentUsage, finalizeChild } from "./result.js";
import { resolveChildAllocation, withSpawnLock } from "./allocation.js";

/** Stable errors raised before a child run can start. */
export type SubagentErrorCode =
  | "subagent_depth_limit"
  | "subagent_children_limit"
  | "subagent_limit"
  | "subagent_recorder_unavailable"
  | "subagent_parent_span_missing";

/** Safe failure for invalid subagent creation state. */
export class SubagentError extends HarnessError {
  readonly code: SubagentErrorCode;

  constructor(code: SubagentErrorCode) {
    super(`Subagent spawn failed (${code}).`);
    this.code = code;
  }
}

/** Input passed to the child-run callback after the parent announcement is durable. */
export interface SubagentRunRequest {
  readonly runId: Id;
  readonly parentRunId: Id;
  readonly parentCallId: Id;
  readonly depth: number;
  readonly scopeId: Id;
  readonly role: ResolvedRole;
  readonly budgets: RunConfig["budgets"];
  readonly budgetDeadlineTs: number;
  readonly input: JsonValue;
  readonly tools: ToolPort;
  readonly signal: AbortSignal;
  readonly parentSpanContext: SpanContext;
  readonly rootSpanParent: Context;
  readonly rootSpanLinks: readonly Link[];
}

/** Executes an isolated child run and returns its JSON-safe result. */
export type SubagentRunner = (request: SubagentRunRequest) => Promise<SubagentResult>;

/** Request to create and await one child run. */
export interface SubagentSpawnInput {
  readonly role: ResolvedRole;
  readonly goal: string;
  readonly inputs?: JsonValue;
  readonly call: ModelToolCall;
  readonly context: RunContext;
}

/** Dependencies used to announce and execute a child run. */
export interface SubagentSupervisorOptions {
  readonly store: EventStore;
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly runConfig: RunConfig;
  readonly scopes: RunScopeRegistry;
  readonly parentTools: ToolPort;
  readonly runChild: SubagentRunner;
  readonly parentSpanContext?: () => SpanContext | undefined;
}

/** Coordinates the durable announcement and execution of child runs. */
export class SubagentSupervisor {
  private readonly parentSpanContext: () => SpanContext | undefined;

  constructor(private readonly options: SubagentSupervisorOptions) {
    this.parentSpanContext =
      options.parentSpanContext ?? (() => trace.getSpan(otelContext.active())?.spanContext());
  }

  /**
   * Append the parent event before registering or invoking the child runner.
   *
   * @param role - Startup-resolved role for the child.
   * @param goal - Tokenized child goal from the spawn tool.
   * @param inputs - Optional tokenized JSON inputs.
   * @param call - Parent tool invocation.
   * @param context - Parent run context and durable event callback.
   * @returns The JSON-safe child result.
   */
  async spawn({ role, goal, inputs, call, context }: SubagentSpawnInput): Promise<SubagentResult> {
    const depth = (context.depth ?? 0) + 1;
    if (depth > role.maxDepth) {
      throw new SubagentError("subagent_depth_limit");
    }
    if (depth > this.options.runConfig.subagents.maxDepth) {
      throw new SubagentError("subagent_limit");
    }
    const recordSpawned = context.recordSubagentSpawned;
    const recordCompleted = context.recordSubagentCompleted;
    if (recordSpawned === undefined || recordCompleted === undefined) {
      throw new SubagentError("subagent_recorder_unavailable");
    }
    const parentSpanContext = this.parentSpanContext();
    if (parentSpanContext === undefined || !isSpanContextValid(parentSpanContext)) {
      throw new SubagentError("subagent_parent_span_missing");
    }

    const allocation = await withSpawnLock(this.options.store, context.runId, (concurrentSpawns) =>
      resolveChildAllocation({
        store: this.options.store,
        runId: context.runId,
        parentCallId: call.callId,
        role,
        runConfig: this.options.runConfig,
        now: this.options.clock.now(),
        recordSpawned,
        childRunId: this.options.ids.next(),
        concurrentSpawns,
      }),
    );
    if (allocation.completion !== undefined) {
      return this.cachedResult(allocation.completion, role);
    }
    const childRunId = allocation.childRunId;
    const completionRecorded = await this.hasCompletion(context.runId, childRunId);
    if (completionRecorded) {
      const completion = await this.findCompletion(context.runId, childRunId);
      if (completion !== undefined) {
        return this.cachedResult(completion, role);
      }
    }

    const scopeId = this.options.scopes.scopeOf(context.runId);
    this.options.scopes.register(childRunId, scopeId);
    const childTools = restrictToolPort(
      context.toolRegistry ?? this.options.parentTools,
      role.tools,
    );
    const childInput: JsonValue = {
      goal,
      ...(inputs === undefined ? {} : { inputs }),
    };
    return this.executeChild({
      parentRunId: context.runId,
      childRunId,
      completionRecorded,
      recordCompleted,
      request: {
        runId: childRunId,
        parentRunId: context.runId,
        parentCallId: call.callId,
        depth,
        budgets: allocation.allocation.budgets,
        budgetDeadlineTs: allocation.allocation.deadlineTs,
        scopeId,
        role,
        input: childInput,
        tools: childTools,
        signal: context.signal,
        parentSpanContext,
        rootSpanParent: trace.setSpanContext(ROOT_CONTEXT, parentSpanContext),
        rootSpanLinks: [{ context: parentSpanContext }],
      },
    });
  }

  private async executeChild(options: {
    readonly parentRunId: Id;
    readonly childRunId: Id;
    readonly completionRecorded: boolean;
    readonly recordCompleted: NonNullable<RunContext["recordSubagentCompleted"]>;
    readonly request: SubagentRunRequest;
  }): Promise<SubagentResult> {
    const childSignal = deriveChildSignal(options.request.signal);
    let result: SubagentResult;
    try {
      const completion = await this.findCompletion(options.parentRunId, options.childRunId);
      if (completion !== undefined) {
        return await this.cachedResult(completion, options.request.role);
      }
      result = await this.options.runChild({
        ...options.request,
        signal: childSignal.signal,
      });
    } catch (error) {
      await this.recordFailedCompletion(
        options.parentRunId,
        options.childRunId,
        options.completionRecorded,
        options.recordCompleted,
      );
      throw error;
    } finally {
      childSignal.dispose();
    }
    if (result.status !== "suspended" && !options.completionRecorded) {
      const completion = await this.findCompletion(options.parentRunId, options.childRunId);
      if (completion !== undefined) {
        return this.cachedResult(completion, options.request.role);
      }
      const { inputTokens, outputTokens, costMicros, steps } = result.usage;
      await options.recordCompleted({
        childRunId: options.childRunId,
        outcome: result.status,
        inputTokens,
        outputTokens,
        steps: steps ?? 0,
        ...(costMicros === undefined ? {} : { costMicros }),
      });
    }
    return result;
  }

  private async cachedResult(
    completion: Extract<Event, { type: "subagent_completed" }>,
    role: ResolvedRole,
  ): Promise<SubagentResult> {
    const events = await this.childEvents(completion.childRunId);
    if (events.length > 0) {
      const status = foldRunState(events).status;
      if (status === "completed" || status === "failed" || status === "cancelled") {
        return finalizeChild({
          childRunId: completion.childRunId,
          status,
          events,
          hasResultSchema: role.resultSchema !== undefined,
        });
      }
    }
    return {
      childRunId: completion.childRunId,
      status: completion.outcome,
      usage: {
        inputTokens: completion.inputTokens,
        outputTokens: completion.outputTokens,
        ...(completion.steps === undefined ? {} : { steps: completion.steps }),
        ...(completion.costMicros === undefined ? {} : { costMicros: completion.costMicros }),
      },
    };
  }

  private async recordFailedCompletion(
    parentRunId: Id,
    childRunId: Id,
    completionRecorded: boolean,
    recordCompleted: NonNullable<RunContext["recordSubagentCompleted"]>,
  ): Promise<void> {
    if (completionRecorded || (await this.hasCompletion(parentRunId, childRunId))) {
      return;
    }
    try {
      const events = await this.childEvents(childRunId);
      const usage =
        events.length === 0
          ? { inputTokens: 0, outputTokens: 0, steps: 0 }
          : aggregateSubagentUsage(events);
      const outcome =
        events.length > 0 && foldRunState(events).status === "cancelled" ? "cancelled" : "failed";
      await recordCompleted({
        childRunId,
        outcome,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        steps: usage.steps,
        ...(usage.costMicros === undefined ? {} : { costMicros: usage.costMicros }),
      });
    } catch {
      trace
        .getSpan(otelContext.active())
        ?.setAttribute("harness.subagent.completion_record_failed", true);
    }
  }

  private async findSpawned(
    runId: Id,
    parentCallId: Id,
  ): Promise<{ readonly childRunId: Id } | undefined> {
    for await (const event of this.options.store.read(runId)) {
      if (event.type === "subagent_spawned" && event.parentCallId === parentCallId) {
        return { childRunId: event.childRunId };
      }
    }
    return undefined;
  }

  private async hasCompletion(runId: Id, childRunId: Id): Promise<boolean> {
    return (await this.findCompletion(runId, childRunId)) !== undefined;
  }

  private async findCompletion(
    runId: Id,
    childRunId: Id,
  ): Promise<Extract<Event, { type: "subagent_completed" }> | undefined> {
    for await (const event of this.options.store.read(runId)) {
      if (event.type === "subagent_completed" && event.childRunId === childRunId) {
        return event;
      }
    }
    return undefined;
  }

  private async childEvents(runId: Id): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of this.options.store.read(runId)) {
      events.push(event);
    }
    return events;
  }
}

function deriveChildSignal(parentSignal: AbortSignal): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => {
    controller.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) {
    abort();
  } else {
    parentSignal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      parentSignal.removeEventListener("abort", abort);
    },
  };
}

/** Restrict a child to the intersection of the parent registry and its role tools. */
export function restrictToolPort(parent: ToolPort, roleTools: readonly Code[]): ToolPort {
  const allowed = new Set(roleTools.filter((toolId) => parent.describe(toolId) !== undefined));
  return {
    ...(parent.getToolSpecs === undefined
      ? {}
      : {
          getToolSpecs: () =>
            (parent.getToolSpecs?.() ?? []).filter(({ toolId }) => allowed.has(toolId)),
        }),
    describe: (toolId) => (allowed.has(toolId) ? parent.describe(toolId) : undefined),
    prepare: (call, context) =>
      allowed.has(call.toolId)
        ? (parent.prepare?.(call, context) ?? Promise.resolve(call))
        : Promise.resolve(call),
    execute: (call, context) =>
      allowed.has(call.toolId)
        ? parent.execute(call, context)
        : Promise.resolve({ outcome: "error", errorCode: "unknown_tool", result: null }),
  };
}
