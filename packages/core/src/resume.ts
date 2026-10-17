// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type Id, type Snapshot } from "@harness/schemas";
import type { Link } from "@opentelemetry/api";
import type { EventStore } from "@harness/store";
import type { WorkspaceSnapshotPort } from "@harness/sandbox";
import { activeRuns } from "@harness/telemetry";
import { applyResolvedApprovals } from "./approvals.js";
import { BudgetTracker } from "./budgets.js";
import { Checkpointer } from "./checkpoint.js";
import { continueRunLoop, type RunLoopExecutionOptions, type RunLoopResult } from "./loop.js";
import { recordBudgetFailureAndCheckpoint } from "./steps/model-preflight.js";
import { LeaseLostError, RunRecorder, type EventPartial } from "./recorder.js";
import { planDanglingIntents, type ResumePolicy } from "./resume-policy.js";
import { CorruptLogError, foldRunState, isTerminalRunState, type RunState } from "./run-state.js";
import { RUN_SPAN } from "./spans.js";
import { applyDanglingIntents } from "./steps/resume-tool-step.js";
import type { RunScopeRegistry } from "./subagent/scope.js";

/** Error raised when attempting to resume a completed, failed, or cancelled run. */
export class RunAlreadyTerminalError extends HarnessError {
  readonly code = "run_already_terminal";

  /** Creates the terminal-run resume error. */
  constructor() {
    super("A terminal run cannot be resumed.");
    this.name = "RunAlreadyTerminalError";
  }
}

/** Error raised when another writer claims the run before this resumer. */
export class ResumeConflictError extends HarnessError {
  readonly code = "resume_conflict";

  /** Creates the concurrent-resume conflict error. */
  constructor() {
    super("Another worker changed the run before it could be resumed.");
    this.name = "ResumeConflictError";
  }
}

/** Error raised when a run is neither interrupted nor suspended. */
export class RunNotResumableError extends HarnessError {
  readonly code = "run_not_resumable";

  /** Creates the invalid run-state resume error. */
  constructor() {
    super("Only running or suspended runs can be resumed.");
    this.name = "RunNotResumableError";
  }
}

/** Error raised when a suspended run is waiting only for unresolved approvals. */
export class RunAwaitingApprovalError extends HarnessError {
  readonly code = "run_awaiting_approval";

  /** Creates the awaiting-approval resume error. */
  constructor() {
    super("The run cannot progress until its pending approval is resolved.");
    this.name = "RunAwaitingApprovalError";
  }
}

/** Inputs for resuming an existing run. */
export interface ResumeRunOptions extends Omit<RunLoopExecutionOptions, "recorder"> {
  readonly store: EventStore;
  readonly runId: Id;
  readonly scopes?: RunScopeRegistry;
  /** Policy for dangling non-idempotent tool intents; defaults to escalation. */
  readonly resumePolicy?: ResumePolicy;
  /** Restores the latest workspace archive even when the workspace still exists. */
  readonly restoreOnResume?: boolean;
  readonly workspaceSnapshotter?: WorkspaceSnapshotPort;
  /** Called immediately after this worker wins the durable resume claim. */
  readonly onClaimed?: () => void;
}

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

interface RunScopeRestoreOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly events: readonly Event[];
  readonly scopes: RunScopeRegistry;
  readonly visited?: Set<Id>;
}

async function registerRunScope(options: RunScopeRestoreOptions): Promise<void> {
  const { store, runId, events, scopes } = options;
  const visited = options.visited ?? new Set<Id>();
  const created = events.find((event) => event.type === "run_created");
  if (created?.type !== "run_created") {
    throw new CorruptLogError();
  }
  if (created.scopeId !== undefined) {
    scopes.register(runId, created.scopeId);
    return;
  }
  if (visited.has(runId)) {
    throw new CorruptLogError();
  }
  visited.add(runId);
  if (created.parentRunId === undefined) {
    scopes.register(runId, runId);
    return;
  }
  const parentEvents = await readEvents(store, created.parentRunId);
  await registerRunScope({
    store,
    runId: created.parentRunId,
    events: parentEvents,
    scopes,
    visited,
  });
  scopes.register(runId, scopes.scopeOf(created.parentRunId));
}

function linkFromTraceparent(traceparent: string): Link | undefined {
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u.exec(traceparent);
  const traceId = match?.[1];
  const spanId = match?.[2];
  const flags = match?.[3];
  if (traceId === undefined || spanId === undefined || flags === undefined) {
    return undefined;
  }
  return {
    context: {
      traceId,
      spanId,
      traceFlags: Number.parseInt(flags, 16),
      isRemote: true,
    },
  };
}

function previousSegmentLink(events: readonly Event[], traceparent?: string): Link {
  const checkpointLink = traceparent === undefined ? undefined : linkFromTraceparent(traceparent);
  if (checkpointLink !== undefined) {
    return checkpointLink;
  }
  const last = events.at(-1);
  if (last === undefined) {
    throw new Error("Expected a prior run event.");
  }
  return {
    context: {
      traceId: last.traceId,
      spanId: last.spanId,
      traceFlags: 1,
      isRemote: true,
    },
  };
}

function withoutApprovalIntents(state: RunState): RunState {
  const approvedCalls = new Set(
    Array.from(state.approvalRequests.values(), (approval) => approval.callId),
  );
  const pendingToolCalls = new Map(
    Array.from(state.pendingToolCalls).filter(([callId]) => !approvedCalls.has(callId)),
  );
  return { ...state, pendingToolCalls };
}

function hasResolvedApprovalToApply(state: RunState): boolean {
  for (const resolution of state.resolvedApprovals.values()) {
    const approval = state.approvalRequests.get(resolution.approvalId);
    const intent = approval === undefined ? undefined : state.pendingToolCalls.get(approval.callId);
    if (approval !== undefined && intent !== undefined && intent.seq < approval.seq) {
      return true;
    }
  }
  return false;
}

function resultForResume(events: readonly Event[], firstNewEvent: number): RunLoopResult {
  const state = foldRunState(events);
  return {
    status: state.status,
    approvalIds: Array.from(state.pendingApprovals.keys()),
    state,
    events: events.slice(firstNewEvent),
  };
}

interface ResumeExecution {
  readonly options: ResumeRunOptions;
  readonly state: RunState;
  readonly events: Event[];
  readonly snapshot: Snapshot | undefined;
  readonly eventsAfterSnapshot: Event[];
  readonly recorder: RunRecorder;
  readonly checkpointer: Checkpointer;
}

async function readResumeHistory(options: ResumeRunOptions): Promise<{
  readonly events: Event[];
  readonly snapshot: Snapshot | undefined;
  readonly state: RunState;
  readonly head: number;
}> {
  const [events, snapshot, head] = await Promise.all([
    readEvents(options.store, options.runId),
    options.store.latestSnapshot(options.runId),
    options.store.head(options.runId),
  ]);
  if (options.scopes !== undefined) {
    await registerRunScope({
      store: options.store,
      runId: options.runId,
      events,
      scopes: options.scopes,
    });
  }
  const state = foldRunState(events);
  if (state.status === "completed" || state.status === "failed" || state.status === "cancelled") {
    throw new RunAlreadyTerminalError();
  }
  if (state.status !== "running" && state.status !== "suspended") {
    throw new RunNotResumableError();
  }
  if (state.nextSeq !== head) {
    throw new ResumeConflictError();
  }
  if (
    state.status === "suspended" &&
    state.pendingApprovals.size > 0 &&
    withoutApprovalIntents(state).pendingToolCalls.size === 0 &&
    !hasResolvedApprovalToApply(state)
  ) {
    throw new RunAwaitingApprovalError();
  }
  return { events, snapshot, state, head };
}

function claimEvents(state: RunState): EventPartial[] {
  if (state.status === "running") {
    return [
      {
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "suspended",
        reason: "interrupted",
      },
      {
        type: "run_status_changed",
        v: 1,
        from: "suspended",
        to: "running",
        reason: "resumed",
      },
    ];
  }
  return [
    {
      type: "run_status_changed",
      v: 1,
      from: "suspended",
      to: "running",
      reason: "resumed",
    },
  ];
}

async function continueClaimedRun(execution: ResumeExecution): Promise<Event> {
  const { options, recorder, events, snapshot, eventsAfterSnapshot, checkpointer } = execution;
  await restoreWorkspace(execution);
  await options.context.restore(snapshot?.context, eventsAfterSnapshot);

  const budgetTracker = new BudgetTracker(options.budgets, undefined, options.deadlineTs);
  const beforeToolExecution = async (): Promise<void> => {
    const violation = budgetTracker.checkWithOpenChildren(events, options.clock.now());
    if (!violation.ok) {
      await recordBudgetFailureAndCheckpoint(recorder, events, violation, checkpointer);
      throw new ResumeBudgetExceededError();
    }
  };
  const danglingState = withoutApprovalIntents(foldRunState(events));
  const actions = planDanglingIntents(
    danglingState,
    options.tool,
    options.resumePolicy ?? "escalate",
  );
  try {
    await applyDanglingIntents(
      {
        recorder,
        tool: options.tool,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        checkpointer,
        clock: options.clock,
        runId: options.runId,
        ids: options.ids,
        signal: options.signal,
        beforeToolExecution,
        onEvents: (recorded) => events.push(...recorded),
      },
      danglingState,
      actions,
    );

    const resumedState = foldRunState(events);
    await applyResolvedApprovals(
      {
        recorder,
        tool: options.tool,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        clock: options.clock,
        runId: options.runId,
        signal: options.signal,
        beforeToolExecution,
        onEvents: (recorded) => events.push(...recorded),
      },
      resumedState,
    );
  } catch (error) {
    if (error instanceof ResumeBudgetExceededError) {
      const failed = events.at(-1);
      if (failed === undefined) {
        throw new Error("Expected the budget failure event.");
      }
      return failed;
    }
    throw error;
  }

  let resumedState = foldRunState(events);
  if (resumedState.pendingApprovals.size > 0 && resumedState.status === "running") {
    events.push(
      await recorder.record({
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "suspended",
        reason: "awaiting_approval",
      }),
    );
    resumedState = foldRunState(events);
  }
  if (resumedState.status === "suspended") {
    const checkpoint = await checkpointer.write(resumedState, "suspended");
    events.push(checkpoint);
    return checkpoint;
  }
  return continueRunLoop({ ...options, recorder }, events, options.runId);
}

async function restoreWorkspace(execution: ResumeExecution): Promise<void> {
  const { options, snapshot } = execution;
  if (snapshot?.workspaceRef === undefined || options.workspaceSnapshotter === undefined) {
    return;
  }
  const workspaceExists = await options.workspaceSnapshotter.hasWorkspace(options.runId);
  if (options.restoreOnResume === true || !workspaceExists) {
    await options.workspaceSnapshotter.restore(options.runId, snapshot.workspaceRef);
  }
}

class ResumeBudgetExceededError extends Error {}

async function claimAndContinue(execution: ResumeExecution): Promise<Event> {
  try {
    execution.events.push(...(await execution.recorder.recordBatch(claimEvents(execution.state))));
    execution.options.onClaimed?.();
  } catch (error) {
    if (error instanceof LeaseLostError) {
      throw new ResumeConflictError();
    }
    throw error;
  }
  return continueClaimedRun(execution);
}

/**
 * Claims an interrupted or suspended run and continues execution from its latest checkpoint.
 *
 * @param options - Store, run identifier, runtime ports, and resume settings.
 * @returns The folded final run state and events appended by this resume attempt.
 * @throws RunAlreadyTerminalError when the run has already finished.
 * @throws ResumeConflictError when another writer wins the resume claim.
 */
export async function resumeRun(options: ResumeRunOptions): Promise<RunLoopResult> {
  const { events, snapshot, state, head } = await readResumeHistory(options);
  const segmentId = options.ids.next();
  const recorder = new RunRecorder(options.store, options.runId, segmentId, head, options.clock);
  const newEventStart = events.length;
  const checkpointer = new Checkpointer({
    recorder,
    runId: options.runId,
    context: options.context,
    ids: options.ids,
    clock: options.clock,
    ...(options.checkpointEveryEvents === undefined
      ? {}
      : { checkpointEveryEvents: options.checkpointEveryEvents }),
    ...(options.snapshotKeep === undefined ? {} : { snapshotKeep: options.snapshotKeep }),
    ...(options.workspaceSnapshotter === undefined
      ? {}
      : { workspaceSnapshotter: options.workspaceSnapshotter }),
  });
  const eventsAfterSnapshot =
    snapshot === undefined ? events.slice() : events.filter((event) => event.seq > snapshot.atSeq);
  const execution: ResumeExecution = {
    options,
    state,
    events,
    snapshot,
    eventsAfterSnapshot,
    recorder,
    checkpointer,
  };
  await activeRuns.track(
    options.runId,
    () =>
      recorder.withStepSpan(RUN_SPAN, {}, () => claimAndContinue(execution), {
        links: [previousSegmentLink(events, snapshot?.traceparent)],
      }),
    () => isTerminalRunState(foldRunState(events)),
  );

  return resultForResume(events, newEventStart);
}
