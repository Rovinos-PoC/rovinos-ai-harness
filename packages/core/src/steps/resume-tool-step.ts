// SPDX-License-Identifier: Apache-2.0
import {
  HarnessError,
  JsonValue as JsonValueSchema,
  UNREGISTERED_TOOL_ID,
  type Code,
  type Event,
} from "@harness/schemas";
import {
  ApprovalPayloadSchema,
  approvalEditsAreAllowed,
  buildApprovalPayload,
  diffToEdits,
} from "@harness/policy";
import { SpanStatusCode } from "@opentelemetry/api";
import { setActiveSpanAttribute } from "@harness/telemetry";
import type { EventPartial } from "../recorder.js";
import type { ModelToolCall, PolicyDecision } from "../ports.js";
import { requestPolicyApproval } from "./policy-step.js";
import { APPROVAL_WAIT_SPAN, TOOL_CALL_SPAN } from "../spans.js";
import type { DanglingIntentAction } from "../resume-policy.js";
import type { ApprovalRequestedEvent, RunState, ToolIntentEvent } from "../run-state.js";
import { runToolCall, type ResumeToolStepOptions } from "./tool-step.js";

class ResumeEventMissingError extends HarnessError {
  readonly code = "resume_event_missing";

  constructor() {
    super("Expected a recorded resume event.");
    this.name = "ResumeEventMissingError";
  }
}

/** Error raised when a resume action or approval does not identify its intent. */
export class ResumeActionMismatchError extends HarnessError {
  readonly code = "resume_action_mismatch";

  /** Creates an error for a mismatched resume action or approval. */
  constructor() {
    super("Resume action or approval does not match its intent.");
    this.name = "ResumeActionMismatchError";
  }
}

/** Error raised when an edit decision has no replacement arguments. */
export class ApprovalEditsRequiredError extends HarnessError {
  readonly code = "approval_edits_required";

  /** Creates an error for an edit decision without replacement arguments. */
  constructor() {
    super("An edit approval decision requires replacement arguments.");
    this.name = "ApprovalEditsRequiredError";
  }
}

/** Error raised when an approval edit modifies a field outside the editable pointers. */
export class ApprovalEditNotAllowedError extends HarnessError {
  readonly code = "approval_edit_not_allowed";

  /** Creates an error for an approval edit outside the allowed pointers. */
  constructor() {
    super("Approval edits may only change fields listed as editable.");
    this.name = "ApprovalEditNotAllowedError";
  }
}

function resultToolId(options: Pick<ResumeToolStepOptions, "tool">, intent: ToolIntentEvent): Code {
  return options.tool.describe(intent.toolId, intent.args) === undefined
    ? UNREGISTERED_TOOL_ID
    : intent.toolId;
}

async function recordDanglingFailure(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  code: "unknown_tool" | "resume_ambiguous" | "pii_blocked",
): Promise<readonly Event[]> {
  const events: Event[] = [];
  await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, async (span) => {
    setPolicySpanAttributes(intent);
    const result = await options.recorder.record({
      type: "tool_result",
      v: 1,
      callId: intent.callId,
      toolId: resultToolId(options, intent),
      outcome: "error",
      errorCode: code,
      latencyMs: 0,
      result: null,
    });
    events.push(result);
    span.setStatus({ code: SpanStatusCode.ERROR });
    span.setAttribute("harness.error.code", code);
    return result;
  });
  return events;
}

async function recordPolicyDenied(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  errorCode: string,
): Promise<readonly Event[]> {
  const result = await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, () => {
    setPolicySpanAttributes(intent);
    return options.recorder.record({
      type: "tool_result",
      v: 1,
      callId: intent.callId,
      toolId: resultToolId(options, intent),
      outcome: "denied",
      errorCode,
      latencyMs: 0,
      executedArgsHash: intent.argsHash,
      result: null,
    });
  });
  return [result];
}

function setPolicySpanAttributes(intent: ToolIntentEvent): void {
  setActiveSpanAttribute("harness.policy.decision", intent.policyDecision);
  if (intent.ruleId !== undefined) {
    setActiveSpanAttribute("harness.policy.rule_id", intent.ruleId);
  }
}

function policyDecisionFromIntent(intent: ToolIntentEvent): PolicyDecision {
  return {
    decision: "ask",
    ruleId: intent.ruleId ?? "default",
    reason: intent.policyReason ?? "default_decision",
    editable: intent.policyEditable ?? [],
    ...(intent.policyApprovalTtlMs === undefined
      ? {}
      : { approvalTtlMs: intent.policyApprovalTtlMs }),
    ...(intent.policyEscalateAfterMs === undefined
      ? {}
      : { escalateAfterMs: intent.policyEscalateAfterMs }),
  };
}

async function requestResumeApprovals(
  options: ResumeToolStepOptions,
  intents: readonly ToolIntentEvent[],
): Promise<readonly Event[]> {
  const events: Event[] = [];
  await options.recorder.withStepSpan(APPROVAL_WAIT_SPAN, {}, async () => {
    const now = Math.floor(options.clock.now());
    const batch: EventPartial[] = intents.map((intent) => {
      const payload = buildApprovalPayload({
        kind: "resume_ambiguity",
        call: callFromIntent(intent),
        rule: {
          id: intent.ruleId ?? "default",
          reason: intent.policyReason ?? "resume_ambiguous",
          ...(intent.policyApprovalTtlMs === undefined
            ? {}
            : { approvalTtlMs: intent.policyApprovalTtlMs }),
        },
        now,
      });
      return {
        type: "approval_requested",
        v: 1,
        approvalId: options.ids.next(),
        callId: intent.callId,
        payload: JsonValueSchema.parse(payload),
        ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
      };
    });
    batch.push({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "suspended",
      reason: "resume_ambiguity",
    });
    const recorded = await options.recorder.recordBatch(batch);
    events.push(...recorded);
    const last = recorded.at(-1);
    if (last === undefined) {
      throw new ResumeEventMissingError();
    }
    return last;
  });
  return events;
}

function callFromIntent(intent: ToolIntentEvent): ModelToolCall {
  return { callId: intent.callId, toolId: intent.toolId, args: intent.args };
}

async function applyDanglingIntentAction(
  options: ResumeToolStepOptions,
  state: RunState,
  intent: ToolIntentEvent,
  action: DanglingIntentAction,
): Promise<readonly Event[] | "escalate"> {
  if (action.callId !== intent.callId) {
    throw new ResumeActionMismatchError();
  }
  if (intent.policyDecision === "deny") {
    return recordPolicyDenied(options, intent, intent.policyReason ?? "default_decision");
  }
  if (intent.policyDecision === "ask") {
    if (options.checkpointer === undefined) {
      return recordPolicyDenied(options, intent, "policy_error");
    }
    const approval = await requestPolicyApproval({
      recorder: options.recorder,
      ids: options.ids,
      checkpointer: options.checkpointer,
      state,
      clock: options.clock,
      call: callFromIntent(intent),
      decision: policyDecisionFromIntent(intent),
    });
    return approval.events;
  }
  if (action.kind === "fail") {
    return recordDanglingFailure(options, intent, action.errorCode);
  }
  if (action.kind === "escalate") {
    return "escalate";
  }

  const description = options.tool.describe(intent.toolId, intent.args);
  if (description === undefined) {
    return recordDanglingFailure(options, intent, "unknown_tool");
  }
  if (!intent.idempotent || !description.idempotent) {
    return "escalate";
  }
  await options.beforeToolExecution?.();
  return runToolCall(options, callFromIntent(intent), description, { existingIntent: intent });
}

/** Applies a resolved approval without appending another intent. */
export async function applyApprovalDecision(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  approval: ApprovalRequestedEvent,
  resolution: Extract<Event, { type: "approval_resolved" }>,
): Promise<readonly Event[]> {
  if (approval.callId !== intent.callId || resolution.approvalId !== approval.approvalId) {
    throw new ResumeActionMismatchError();
  }
  if (resolution.decision === "deny") {
    const result = await options.recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      setPolicySpanAttributes(intent);
      return options.recorder.record({
        type: "tool_result",
        v: 1,
        callId: intent.callId,
        toolId: resultToolId(options, intent),
        outcome: "denied",
        errorCode: "approval_denied",
        latencyMs: 0,
        result: null,
      });
    });
    return [result];
  }
  let args = intent.args;
  if (resolution.decision === "edit") {
    if (resolution.edits === undefined) {
      throw new ApprovalEditsRequiredError();
    }
    const payload = ApprovalPayloadSchema.safeParse(approval.payload);
    if (
      !payload.success ||
      payload.data.callId !== intent.callId ||
      !approvalEditsAreAllowed(payload.data, diffToEdits(intent.args, resolution.edits))
    ) {
      throw new ApprovalEditNotAllowedError();
    }
    args = resolution.edits;
  }
  const call: ModelToolCall = { callId: intent.callId, toolId: intent.toolId, args };
  const description = options.tool.describe(intent.toolId, intent.args);
  if (description !== undefined) {
    await options.beforeToolExecution?.();
  }
  return runToolCall(options, call, description, {
    existingIntent: intent,
    ...(resolution.decision === "edit" ? { prepared: { call } } : {}),
    ...(resolution.decision === "edit"
      ? { compareArgsHash: intent.argsHash, checkEditedPolicy: true }
      : {}),
  });
}

/** Applies dangling-intent actions in event order and batches escalations. */
export async function applyDanglingIntents(
  options: ResumeToolStepOptions,
  state: RunState,
  actions: readonly DanglingIntentAction[],
): Promise<readonly Event[]> {
  const events: Event[] = [];
  const escalations: ToolIntentEvent[] = [];
  for (const action of actions) {
    const intent = state.pendingToolCalls.get(action.callId);
    if (intent === undefined) {
      throw new ResumeActionMismatchError();
    }
    const applied = await applyDanglingIntentAction(options, state, intent, action);
    if (applied === "escalate") {
      escalations.push(intent);
    } else {
      events.push(...applied);
      options.onEvents?.(applied);
    }
  }
  if (escalations.length > 0) {
    const approvalEvents = await requestResumeApprovals(options, escalations);
    events.push(...approvalEvents);
    options.onEvents?.(approvalEvents);
  }
  return events;
}

/** Resolves a resume-ambiguity approval without duplicating its intent. */
export async function resolveDanglingIntentApproval(
  options: Omit<ResumeToolStepOptions, "ids">,
  intent: ToolIntentEvent,
  approval: ApprovalRequestedEvent,
  resolution: Extract<Event, { type: "approval_resolved" }>,
): Promise<readonly Event[]> {
  if (approval.callId !== intent.callId || resolution.approvalId !== approval.approvalId) {
    throw new ResumeActionMismatchError();
  }
  if (resolution.decision === "deny") {
    return recordDanglingFailure(options, intent, "resume_ambiguous");
  }
  const description = options.tool.describe(intent.toolId, intent.args);
  if (description === undefined) {
    return recordDanglingFailure(options, intent, "unknown_tool");
  }
  await options.beforeToolExecution?.();
  return runToolCall(options, callFromIntent(intent), description, { existingIntent: intent });
}
