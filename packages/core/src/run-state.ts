// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type JsonValue, type RunStatus } from "@harness/schemas";
import { createPlanReducerState, planReducer, type PlanReducerState } from "@harness/context";
import { RUN_TRIGGERS, transition } from "./state-machine.js";
import type { ModelToolCall } from "./ports.js";

/** A tool-intent event that has not yet received a result. */
export type ToolIntentEvent = Extract<Event, { type: "tool_intent" }>;

/** An approval request that has not yet been resolved. */
export type ApprovalRequestedEvent = Extract<Event, { type: "approval_requested" }>;
type CheckpointWrittenEvent = Extract<Event, { type: "checkpoint_written" }>;

/** State derived from the append-only events for one run. */
export interface RunState {
  readonly status: RunStatus;
  readonly nextSeq: number;
  readonly plan?: JsonValue;
  readonly steps: number;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicros: number;
  };
  readonly pendingToolCalls: ReadonlyMap<ToolIntentEvent["callId"], ToolIntentEvent>;
  readonly pendingApprovals: ReadonlyMap<
    ApprovalRequestedEvent["approvalId"],
    ApprovalRequestedEvent
  >;
  readonly approvalRequests: ReadonlyMap<
    ApprovalRequestedEvent["approvalId"],
    ApprovalRequestedEvent
  >;
  readonly resolvedApprovals: ReadonlyMap<
    ApprovalRequestedEvent["approvalId"],
    Extract<Event, { type: "approval_resolved" }>
  >;
  readonly lastCheckpoint?: {
    readonly checkpointId: CheckpointWrittenEvent["checkpointId"];
    readonly atSeq: number;
  };
  readonly segmentId: Event["segmentId"];
  readonly startedAt: number;
  readonly lastTs: number;
  readonly suspendedTimeMs: number;
  readonly suspendedAt?: number;
}

interface MutableRunState {
  status: RunStatus;
  nextSeq: number;
  planState: PlanReducerState;
  steps: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  };
  pendingToolCalls: Map<ToolIntentEvent["callId"], ToolIntentEvent>;
  pendingApprovals: Map<ApprovalRequestedEvent["approvalId"], ApprovalRequestedEvent>;
  approvalRequests: Map<ApprovalRequestedEvent["approvalId"], ApprovalRequestedEvent>;
  resolvedApprovals: Map<
    ApprovalRequestedEvent["approvalId"],
    Extract<Event, { type: "approval_resolved" }>
  >;
  lastCheckpoint?: NonNullable<RunState["lastCheckpoint"]>;
  segmentId: Event["segmentId"];
  startedAt: number;
  lastTs: number;
  suspendedTimeMs: number;
  suspendedAt?: number;
}

/** Error raised when the event log is corrupt. */
export class CorruptLogError extends HarnessError {
  readonly code = "corrupt_log";

  /** Creates an error for a corrupt event log. */
  constructor() {
    super("Run event log is corrupt.");
    this.name = "CorruptLogError";
  }
}

type ModelResponseRecovery =
  | { readonly kind: "none" }
  | { readonly kind: "tool_calls"; readonly calls: readonly ModelToolCall[] }
  | { readonly kind: "final_answer" };

/**
 * Plans recovery from the latest response using durable tool-call parts as the proposal source.
 *
 * @param events - Complete validated event history.
 * @returns Pending proposals to execute, a final-answer decision, or no recovery action.
 */
export function planLastModelResponseRecovery(events: readonly Event[]): ModelResponseRecovery {
  const responseIndex = events.findLastIndex((event) => event.type === "model_response");
  const response = events[responseIndex];
  if (response?.type !== "model_response") {
    return { kind: "none" };
  }
  const eventsAfterResponse = events.slice(responseIndex + 1);
  if (
    eventsAfterResponse.some(
      (event) =>
        event.type === "model_request" ||
        (event.type === "run_status_changed" &&
          (event.to === "completed" || event.to === "failed" || event.to === "cancelled")),
    )
  ) {
    return { kind: "none" };
  }

  const toolCalls = response.content.flatMap((part) =>
    part.type === "tool_call"
      ? [{ callId: part.callId, toolId: part.toolId, args: part.args }]
      : [],
  );
  const recordedCallIds = new Set(
    events.flatMap((event) => (event.type === "tool_intent" ? [event.callId] : [])),
  );
  const unrecordedCalls = toolCalls.filter((call) => !recordedCallIds.has(call.callId));
  if (unrecordedCalls.length > 0) {
    return { kind: "tool_calls", calls: unrecordedCalls };
  }

  const hasToolIntentAfterResponse = eventsAfterResponse.some(
    (event) => event.type === "tool_intent",
  );
  if (toolCalls.length > 0 || hasToolIntentAfterResponse) {
    return { kind: "none" };
  }

  return { kind: "final_answer" };
}

function applyStatusEvent(
  state: MutableRunState,
  event: Extract<Event, { type: "run_status_changed" }>,
): MutableRunState {
  const validFrom = event.from === state.status;
  const validTo = RUN_TRIGGERS.some((trigger) => {
    const result = transition(event.from, trigger);
    return result.ok && result.to === event.to;
  });
  if (!validFrom || !validTo) {
    throw new CorruptLogError();
  }
  if (event.from === "running" && event.to === "suspended") {
    return { ...state, status: event.to, suspendedAt: event.ts };
  }
  if (event.from === "suspended") {
    if (state.suspendedAt === undefined) {
      throw new CorruptLogError();
    }
    const { suspendedAt, ...resumedState } = state;
    return {
      ...resumedState,
      status: event.to,
      suspendedTimeMs: state.suspendedTimeMs + Math.max(0, event.ts - suspendedAt),
    };
  }
  return { ...state, status: event.to };
}

function applyResponseEvent(
  state: MutableRunState,
  event: Extract<Event, { type: "model_response" }>,
): MutableRunState {
  return {
    ...state,
    steps: state.steps + 1,
    usage: {
      inputTokens: state.usage.inputTokens + event.inputTokens,
      outputTokens: state.usage.outputTokens + event.outputTokens,
      costMicros: state.usage.costMicros + (event.costMicros ?? 0),
    },
  };
}

function applyToolIntent(state: MutableRunState, event: ToolIntentEvent): MutableRunState {
  if (state.pendingToolCalls.has(event.callId)) {
    throw new CorruptLogError();
  }
  const pendingToolCalls = new Map(state.pendingToolCalls);
  pendingToolCalls.set(event.callId, event);
  return { ...state, pendingToolCalls };
}

function applyToolResult(
  state: MutableRunState,
  event: Extract<Event, { type: "tool_result" }>,
): MutableRunState {
  if (!state.pendingToolCalls.has(event.callId)) {
    throw new CorruptLogError();
  }
  const pendingToolCalls = new Map(state.pendingToolCalls);
  pendingToolCalls.delete(event.callId);
  return { ...state, pendingToolCalls };
}

function applyToolLifecycle(state: MutableRunState, event: Event): MutableRunState | undefined {
  if (event.type === "tool_intent") {
    return applyToolIntent(state, event);
  }
  if (event.type === "tool_result") {
    return applyToolResult(state, event);
  }
  return undefined;
}

function applyApprovalRequest(
  state: MutableRunState,
  event: ApprovalRequestedEvent,
): MutableRunState {
  if (state.pendingApprovals.has(event.approvalId)) {
    throw new CorruptLogError();
  }
  const pendingApprovals = new Map(state.pendingApprovals);
  pendingApprovals.set(event.approvalId, event);
  const approvalRequests = new Map(state.approvalRequests);
  approvalRequests.set(event.approvalId, event);
  const resolvedApprovals = new Map(state.resolvedApprovals);
  resolvedApprovals.delete(event.approvalId);
  return { ...state, pendingApprovals, approvalRequests, resolvedApprovals };
}

function applyApprovalResolution(
  state: MutableRunState,
  event: Extract<Event, { type: "approval_resolved" }>,
): MutableRunState {
  if (!state.pendingApprovals.has(event.approvalId)) {
    throw new CorruptLogError();
  }
  const pendingApprovals = new Map(state.pendingApprovals);
  pendingApprovals.delete(event.approvalId);
  const resolvedApprovals = new Map(state.resolvedApprovals);
  resolvedApprovals.set(event.approvalId, event);
  return { ...state, pendingApprovals, resolvedApprovals };
}

function applySubagentCompletion(
  state: MutableRunState,
  event: Extract<Event, { type: "subagent_completed" }>,
): MutableRunState {
  return {
    ...state,
    steps: state.steps + (event.steps ?? 0),
    usage: {
      inputTokens: state.usage.inputTokens + event.inputTokens,
      outputTokens: state.usage.outputTokens + event.outputTokens,
      costMicros: state.usage.costMicros + (event.costMicros ?? 0),
    },
  };
}

function applyEvent(state: MutableRunState, event: Event, runId: Event["runId"]): MutableRunState {
  if (event.seq !== state.nextSeq || event.runId !== runId || event.type === "run_created") {
    throw new CorruptLogError();
  }
  const withEnvelope = {
    ...state,
    planState: planReducer(state.planState, event),
    nextSeq: state.nextSeq + 1,
    segmentId: event.segmentId,
    lastTs: event.ts,
  };
  if (event.type === "run_status_changed") {
    return applyStatusEvent(withEnvelope, event);
  }
  if (event.type === "model_response") {
    return applyResponseEvent(withEnvelope, event);
  }
  if (event.type === "context_compacted") {
    return {
      ...withEnvelope,
      usage: {
        inputTokens: withEnvelope.usage.inputTokens + (event.inputTokens ?? 0),
        outputTokens: withEnvelope.usage.outputTokens + (event.outputTokens ?? 0),
        costMicros: withEnvelope.usage.costMicros + (event.costMicros ?? 0),
      },
    };
  }
  if (event.type === "subagent_completed") {
    return applySubagentCompletion(withEnvelope, event);
  }
  const toolLifecycle = applyToolLifecycle(withEnvelope, event);
  if (toolLifecycle !== undefined) {
    return toolLifecycle;
  }
  if (event.type === "approval_requested") {
    return applyApprovalRequest(withEnvelope, event);
  }
  if (event.type === "approval_resolved") {
    return applyApprovalResolution(withEnvelope, event);
  }
  if (event.type === "checkpoint_written") {
    return {
      ...withEnvelope,
      lastCheckpoint: { checkpointId: event.checkpointId, atSeq: event.atSeq },
    };
  }
  return withEnvelope;
}

/**
 * Folds events in log order into a fresh run state without mutating the events.
 *
 * @param events - Validated events in append order.
 * @returns State derived from the events.
 * @throws {@link CorruptLogError} when the log is empty or contains corrupt events.
 */
export function foldRunState(events: Iterable<Event>): RunState {
  const iterator = events[Symbol.iterator]();
  const first = iterator.next();
  if (first.done === true || first.value.type !== "run_created" || first.value.seq !== 0) {
    throw new CorruptLogError();
  }

  const runId = first.value.runId;
  let state: MutableRunState = {
    status: "pending",
    nextSeq: 1,
    planState: createPlanReducerState(),
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    pendingToolCalls: new Map(),
    pendingApprovals: new Map(),
    approvalRequests: new Map(),
    resolvedApprovals: new Map(),
    segmentId: first.value.segmentId,
    startedAt: first.value.ts,
    lastTs: first.value.ts,
    suspendedTimeMs: 0,
  };

  for (;;) {
    const next = iterator.next();
    if (next.done === true) {
      break;
    }
    state = applyEvent(state, next.value, runId);
  }

  const { planState, ...runState } = state;
  return planState.plan === undefined ? runState : { ...runState, plan: planState.plan };
}

/** Whether the folded run has reached a terminal status. */
export function isTerminalRunState(state: RunState): boolean {
  return state.status === "completed" || state.status === "failed" || state.status === "cancelled";
}
