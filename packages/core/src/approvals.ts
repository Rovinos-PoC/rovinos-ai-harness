// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type Event, type Id, type JsonValue } from "@harness/schemas";
import { SeqConflictError, type EventStore } from "@harness/store";
import {
  ApprovalEditError,
  ApprovalPayloadSchema,
  diffToEdits,
  validateEdits,
} from "@harness/policy";
import type { Checkpointer } from "./checkpoint.js";
import { LeaseLostError, RunRecorder, type Clock, type EventPartial } from "./recorder.js";
import { foldRunState, type RunState } from "./run-state.js";
import { APPROVAL_WAIT_SPAN } from "./spans.js";
import type { ToolPort } from "./ports.js";
import {
  applyApprovalDecision,
  ApprovalEditsRequiredError,
  resolveDanglingIntentApproval,
} from "./steps/resume-tool-step.js";
import type { ResumeToolStepOptions } from "./steps/tool-step.js";
import { prepareToolCall, toolRunContext } from "./steps/prepare-tool.js";

export { ApprovalEditsRequiredError };

/** A human decision supported by an approval resolution. */
export type ApprovalDecision = Extract<Event, { type: "approval_resolved" }>["decision"];

/** Metadata describing who or what resolved an approval. */
export interface ApprovalResolutionMetadata {
  readonly decidedBy: Extract<Event, { type: "approval_resolved" }>["decidedBy"];
  readonly reason?: Code;
}

/** Inputs and checkpoint state required to suspend a run for one approval. */
export interface RequestApprovalOptions {
  readonly approvalId: Id;
  readonly callId: Id;
  readonly payload: JsonValue;
  readonly expiresAt?: number;
  readonly state: RunState;
  readonly checkpointer: Checkpointer;
  readonly intent?: Extract<EventPartial, { type: "tool_intent" }>;
}

/** Result returned after the approval request and suspension checkpoint are durable. */
export interface ApprovalSuspensionResult {
  readonly status: "suspended";
  readonly approvalIds: readonly Id[];
  readonly events: readonly Event[];
}

/** Error raised when an approval id does not exist in the run log. */
export class ApprovalNotFoundError extends HarnessError {
  readonly code = "approval_not_found";

  /** Creates an error for an unknown approval id. */
  constructor() {
    super("Approval was not found.");
    this.name = "ApprovalNotFoundError";
  }
}

/** Error raised when an approval already has a durable decision. */
export class ApprovalAlreadyResolvedError extends HarnessError {
  readonly code = "approval_already_resolved";

  /** Creates an error for an approval that has already been resolved. */
  constructor() {
    super("Approval was already resolved.");
    this.name = "ApprovalAlreadyResolvedError";
  }
}

/** Error raised when an approval is requested for a run that is not suspended. */
export class ApprovalRunNotSuspendedError extends HarnessError {
  readonly code = "approval_run_not_suspended";

  /** Creates an error for a run that cannot accept an approval resolution. */
  constructor() {
    super("Approvals can only be resolved while the run is suspended.");
    this.name = "ApprovalRunNotSuspendedError";
  }
}

/** Error raised when repeated concurrent appends prevent an approval resolution. */
export class ApprovalResolutionConflictError extends HarnessError {
  readonly code = "approval_resolution_conflict";

  /** Creates an error for a resolution that could not append after bounded retries. */
  constructor() {
    super("Approval resolution conflicted with concurrent run events.");
    this.name = "ApprovalResolutionConflictError";
  }
}

/** Error raised when an approval cannot be requested from the current run state. */
export class ApprovalRequestStateError extends HarnessError {
  readonly code = "approval_invalid_state";

  /** Creates an error for an invalid approval request state. */
  constructor() {
    super("Approval requires a fresh id and a running run state.");
    this.name = "ApprovalRequestStateError";
  }
}

class ApprovalEditPreparationError extends HarnessError {
  readonly code = "pii_prepare_failed";

  constructor() {
    super("Approval edits require a PII-aware tool port.");
  }
}

const systemClock: Clock = { now: Date.now };

interface PrepareApprovalEditOptions {
  readonly tool: ToolPort;
  readonly approval: Extract<Event, { type: "approval_requested" }>;
  readonly intent: Extract<Event, { type: "tool_intent" }>;
  readonly edits: JsonValue;
  readonly runId: Id;
  readonly recorder: RunRecorder;
  readonly events: Event[];
}

async function prepareApprovalEdits(options: PrepareApprovalEditOptions): Promise<JsonValue> {
  const { tool, approval, intent, edits, runId, recorder, events } = options;
  const parsedPayload = ApprovalPayloadSchema.safeParse(approval.payload);
  if (
    !parsedPayload.success ||
    parsedPayload.data.callId !== intent.callId ||
    parsedPayload.data.toolId !== intent.toolId
  ) {
    throw new ApprovalEditError("edit_invalid");
  }
  const pointerEdits = diffToEdits(parsedPayload.data.args, edits);
  const context = toolRunContext({ runId, signal: new AbortController().signal }, recorder, events);
  const validateSchema =
    tool.validateInputSchema === undefined
      ? undefined
      : (args: JsonValue, schema: JsonValue) =>
          tool.validateInputSchema?.(intent.toolId, args, schema, context) ??
          Promise.resolve(false);
  return validateEdits(
    parsedPayload.data,
    pointerEdits,
    tool.describe(intent.toolId, intent.args)?.inputSchema,
    {
      tokenize: async (args) => {
        const prepared = await prepareToolCall(
          tool,
          { callId: approval.callId, toolId: intent.toolId, args },
          context,
        );
        if (prepared.errorCode !== undefined) {
          throw new ApprovalEditPreparationError();
        }
        return prepared.call.args;
      },
      ...(validateSchema === undefined ? {} : { validateSchema }),
    },
  );
}

/**
 * Records an approval request, suspends the run, and forces a checkpoint.
 *
 * @param recorder - Recorder for the active run segment.
 * @param options - Approval identifiers and payload, folded state, and checkpointer.
 * @returns The suspended outcome with its approval id and durable events.
 */
export async function requestApproval(
  recorder: RunRecorder,
  options: RequestApprovalOptions,
): Promise<ApprovalSuspensionResult> {
  const hasPendingIntent = options.state.pendingToolCalls.has(options.callId);
  if (
    options.state.status !== "running" ||
    options.state.nextSeq !== recorder.nextSeq ||
    options.state.approvalRequests.has(options.approvalId) ||
    hasPendingIntent === (options.intent !== undefined) ||
    (options.intent !== undefined && options.intent.callId !== options.callId)
  ) {
    throw new ApprovalRequestStateError();
  }

  const events: Event[] = [];
  await recorder.withStepSpan(APPROVAL_WAIT_SPAN, {}, async () => {
    const request = {
      type: "approval_requested" as const,
      v: 1 as const,
      approvalId: options.approvalId,
      callId: options.callId,
      payload: options.payload,
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    };
    const recorded = await recorder.recordBatch([
      ...(options.intent === undefined ? [] : [options.intent]),
      request,
      {
        type: "run_status_changed",
        v: 1,
        from: "running",
        to: "suspended",
        reason: "awaiting_approval",
      },
    ]);
    const requestIndex = options.intent === undefined ? 0 : 1;
    const requestEvent = recorded[requestIndex];
    const suspendedEvent = recorded[requestIndex + 1];
    if (
      requestEvent?.type !== "approval_requested" ||
      suspendedEvent?.type !== "run_status_changed"
    ) {
      throw new ApprovalRequestStateError();
    }
    events.push(...recorded);
    const approvalRequests = new Map(options.state.approvalRequests);
    approvalRequests.set(requestEvent.approvalId, requestEvent);
    const pendingApprovals = new Map(options.state.pendingApprovals);
    pendingApprovals.set(requestEvent.approvalId, requestEvent);
    const pendingToolCalls = new Map(options.state.pendingToolCalls);
    const intentEvent = options.intent === undefined ? undefined : recorded[0];
    if (options.intent !== undefined) {
      if (intentEvent?.type !== "tool_intent") {
        throw new ApprovalRequestStateError();
      }
      pendingToolCalls.set(intentEvent.callId, intentEvent);
    }
    const suspendedState: RunState = {
      ...options.state,
      status: "suspended",
      nextSeq: suspendedEvent.seq + 1,
      pendingToolCalls,
      pendingApprovals,
      approvalRequests,
      segmentId: suspendedEvent.segmentId,
      lastTs: suspendedEvent.ts,
      suspendedAt: suspendedEvent.ts,
    };
    events.push(await options.checkpointer.write(suspendedState, "suspended"));
    const checkpoint = events.at(-1);
    if (checkpoint === undefined) {
      throw new ApprovalRequestStateError();
    }
    return checkpoint;
  });
  return { status: "suspended", approvalIds: [options.approvalId], events };
}

async function readState(
  store: EventStore,
  runId: Id,
): Promise<{
  readonly state: RunState;
  readonly lastEvent: Event;
}> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  const lastEvent = events.at(-1);
  if (lastEvent === undefined) {
    throw new ApprovalNotFoundError();
  }
  return { state: foldRunState(events), lastEvent };
}

async function retryApprovalResolution(options: {
  readonly store: EventStore;
  readonly runId: Id;
  readonly approvalId: Id;
  readonly attempt: number;
  readonly error: unknown;
}): Promise<void> {
  const { store, runId, approvalId, attempt, error } = options;
  if (!(error instanceof LeaseLostError) && !(error instanceof SeqConflictError)) {
    throw error;
  }
  if (attempt < 2) {
    return;
  }
  const { state } = await readState(store, runId);
  pendingApproval(state, approvalId);
  if (state.status !== "suspended") {
    throw new ApprovalRunNotSuspendedError();
  }
  throw new ApprovalResolutionConflictError();
}

/**
 * Resolves a pending approval by appending to the run log without a live loop.
 *
 * @param store - Event store shared with the run.
 * @param runId - Run containing the approval.
 * @param approvalId - Pending approval to resolve.
 * @param decision - Human decision.
 * @param edits - Replacement tool arguments for an edit decision.
 * @param clock - Clock used to timestamp the resolution.
 * @param tool - PII-aware tool port required to resolve edit decisions.
 * @param metadata - Resolver identity and optional machine-readable reason.
 * @returns The durable approval resolution event.
 */
// eslint-disable-next-line max-params -- task 2.9 specifies store, run, approval, decision, and edits; §3.3 requires an injected clock
export async function resolveApproval(
  store: EventStore,
  runId: Id,
  approvalId: Id,
  decision: ApprovalDecision,
  edits?: JsonValue,
  clock: Clock = systemClock,
  tool?: ToolPort,
  metadata: ApprovalResolutionMetadata = { decidedBy: "human" },
): Promise<Extract<Event, { type: "approval_resolved" }>> {
  if (decision === "edit") {
    if (edits === undefined) {
      throw new ApprovalEditsRequiredError();
    }
    if (tool?.prepare === undefined) {
      throw new ApprovalEditPreparationError();
    }
  }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { state, lastEvent } = await readState(store, runId);
    const request = pendingApproval(state, approvalId);
    if (state.status !== "suspended") {
      throw new ApprovalRunNotSuspendedError();
    }

    const resolvedAt = Math.floor(clock.now());
    const recorder = new RunRecorder(store, runId, lastEvent.segmentId, state.nextSeq, {
      now: () => resolvedAt,
    });
    const events: Event[] = [];
    try {
      const event = await recorder.withStepSpan(APPROVAL_WAIT_SPAN, {}, async () => {
        let resolvedEdits = edits;
        if (decision === "edit" && edits !== undefined && tool !== undefined) {
          const intent = state.pendingToolCalls.get(request.callId);
          if (intent === undefined) {
            throw new ApprovalNotFoundError();
          }
          resolvedEdits = await prepareApprovalEdits({
            tool,
            approval: request,
            intent,
            edits,
            runId,
            recorder,
            events,
          });
          if (tool.describe(intent.toolId, intent.args) === undefined) {
            throw new ApprovalEditError("edit_invalid");
          }
        }
        return recorder.record({
          type: "approval_resolved",
          v: 1,
          approvalId,
          decision,
          decidedBy: metadata.decidedBy,
          ...(metadata.reason === undefined ? {} : { reason: metadata.reason }),
          waitMs: Math.max(0, resolvedAt - request.ts),
          ...(resolvedEdits === undefined ? {} : { edits: resolvedEdits }),
        });
      });
      if (event.type !== "approval_resolved") {
        throw new ApprovalNotFoundError();
      }
      return event;
    } catch (error) {
      await retryApprovalResolution({ store, runId, approvalId, attempt, error });
    }
  }
  throw new ApprovalResolutionConflictError();
}

function pendingApproval(
  state: RunState,
  approvalId: Id,
): Extract<Event, { type: "approval_requested" }> {
  if (state.resolvedApprovals.has(approvalId)) {
    throw new ApprovalAlreadyResolvedError();
  }
  if (!state.approvalRequests.has(approvalId)) {
    throw new ApprovalNotFoundError();
  }
  const request = state.pendingApprovals.get(approvalId);
  if (request === undefined) {
    throw new ApprovalNotFoundError();
  }
  return request;
}

/**
 * Applies durable decisions to their pending tool intents during resume.
 *
 * @param options - Tool, recorder, clock, and run context for resumed execution.
 * @param state - Folded run state containing resolved approvals and unresolved intents.
 * @returns Events appended while applying the decisions.
 */
export async function applyResolvedApprovals(
  options: Omit<ResumeToolStepOptions, "ids">,
  state: RunState,
): Promise<readonly Event[]> {
  const events: Event[] = [];
  for (const resolution of state.resolvedApprovals.values()) {
    const approval = state.approvalRequests.get(resolution.approvalId);
    if (approval === undefined) {
      throw new ApprovalNotFoundError();
    }
    const intent = state.pendingToolCalls.get(approval.callId);
    if (intent === undefined || intent.seq >= approval.seq) {
      continue;
    }
    const isResumeAmbiguity =
      typeof approval.payload === "object" &&
      approval.payload !== null &&
      !Array.isArray(approval.payload) &&
      approval.payload.kind === "resume_ambiguity";
    const applied = await (isResumeAmbiguity
      ? resolveDanglingIntentApproval(options, intent, approval, resolution)
      : applyApprovalDecision(options, intent, approval, resolution));
    events.push(...applied);
    options.onEvents?.(applied);
  }
  return events;
}
