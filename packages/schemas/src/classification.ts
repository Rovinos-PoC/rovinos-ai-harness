// SPDX-License-Identifier: Apache-2.0
import { EventSchema, type Event, type EventType, type PayloadKeys } from "./events.js";
import { ContractError } from "./parse.js";

/** Whether an event field is safe metadata or encrypted content. */
export type EventFieldClass = "meta" | "content";

/**
 * Classifies every payload key. New keys default to `content` unless explicitly proven metadata.
 */
export const EVENT_FIELD_CLASS = {
  run_created: {
    configHash: "meta",
    policyVersion: "meta",
    parentRunId: "meta",
    parentCallId: "meta",
    continuationOf: "meta",
    scopeId: "meta",
    depth: "meta",
  },
  run_input: { input: "content", inputKind: "meta" },
  run_status_changed: { from: "meta", to: "meta", reason: "meta" },
  model_request: {
    requestId: "meta",
    provider: "meta",
    model: "meta",
    role: "meta",
    requestHash: "meta",
    schemaHash: "meta",
    messages: "content",
  },
  model_response: {
    requestId: "meta",
    provider: "meta",
    model: "meta",
    inputTokens: "meta",
    outputTokens: "meta",
    cacheReadTokens: "meta",
    cacheWriteTokens: "meta",
    costMicros: "meta",
    finishReason: "meta",
    latencyMs: "meta",
    schemaValid: "meta",
    repairAttempts: "meta",
    rungUsed: "meta",
    fallbackDepth: "meta",
    structuredValue: "content",
    content: "content",
    providerBlobs: "content",
  },
  tool_intent: {
    callId: "meta",
    toolId: "meta",
    idempotent: "meta",
    policyDecision: "meta",
    ruleId: "meta",
    policyReason: "meta",
    policyEditable: "meta",
    policyApprovalTtlMs: "meta",
    policyEscalateAfterMs: "meta",
    argsHash: "meta",
    args: "content",
  },
  tool_result: {
    callId: "meta",
    toolId: "meta",
    outcome: "meta",
    errorCode: "meta",
    latencyMs: "meta",
    executedArgsHash: "meta",
    result: "content",
  },
  approval_requested: { approvalId: "meta", callId: "meta", expiresAt: "meta", payload: "content" },
  approval_resolved: {
    approvalId: "meta",
    decision: "meta",
    decidedBy: "meta",
    reason: "meta",
    waitMs: "meta",
    edits: "content",
  },
  app_content: {
    source: "meta",
    appId: "meta",
    label: "meta",
    kind: "meta",
    content: "content",
  },
  checkpoint_written: {
    checkpointId: "meta",
    atSeq: "meta",
    traceparent: "meta",
    workspaceRef: "meta",
  },
  context_compacted: {
    fromSeq: "meta",
    toSeq: "meta",
    strategy: "meta",
    strategyVersion: "meta",
    summary: "content",
    inputTokens: "meta",
    outputTokens: "meta",
    costMicros: "meta",
  },
  pii_action: { boundary: "meta", action: "meta", toolId: "meta", entities: "meta" },
  budget_exceeded: { budget: "meta", limit: "meta", observed: "meta" },
  subagent_spawned: {
    childRunId: "meta",
    role: "meta",
    parentCallId: "meta",
    budgetLimits: "meta",
    budgetDeadlineTs: "meta",
  },
  subagent_completed: {
    childRunId: "meta",
    outcome: "meta",
    inputTokens: "meta",
    outputTokens: "meta",
    steps: "meta",
    costMicros: "meta",
  },
} satisfies { [T in EventType]: Record<PayloadKeys<T>, EventFieldClass> };

const envelopeKeys = new Set(["runId", "seq", "ts", "type", "v", "traceId", "spanId", "segmentId"]);

function fieldClassFor(type: EventType, key: string): EventFieldClass | undefined {
  return Object.entries(EVENT_FIELD_CLASS[type]).find(([field]) => field === key)?.[1];
}

function isEventType(type: unknown): type is EventType {
  return typeof type === "string" && Object.hasOwn(EVENT_FIELD_CLASS, type);
}

/**
 * Splits an event into its always-meta envelope and classified payloads.
 *
 * @param event - Validated event to split.
 * @returns The meta and content records, omitting absent optional fields.
 */
export function splitEvent(event: Event): {
  meta: Record<string, unknown>;
  content: Record<string, unknown>;
} {
  const meta: Record<string, unknown> = {};
  const content: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (value === undefined) {
      continue;
    }
    if (
      envelopeKeys.has(key) ||
      Object.entries(EVENT_FIELD_CLASS[event.type]).find(([field]) => field === key)?.[1] === "meta"
    ) {
      meta[key] = value;
    } else {
      content[key] = value;
    }
  }
  return { meta, content };
}

/**
 * Reassembles and validates an event from its separately stored parts.
 *
 * @param meta - Event envelope and meta-classified payload.
 * @param content - Content-classified payload.
 * @returns The validated event.
 * @throws ContractError when a field is stored in the wrong part or validation fails.
 */
export function joinEvent(meta: Record<string, unknown>, content: Record<string, unknown>): Event {
  const issues = Object.keys(meta)
    .filter((key) => Object.hasOwn(content, key))
    .map((key) => ({ path: [key], code: "duplicate_field" }));

  if (isEventType(meta.type)) {
    const type = meta.type;
    for (const key of Object.keys(content)) {
      if (fieldClassFor(type, key) !== "content") {
        issues.push({ path: ["content", key], code: "field_classification_mismatch" });
      }
    }
    for (const key of Object.keys(meta)) {
      if (!envelopeKeys.has(key) && fieldClassFor(type, key) !== "meta") {
        issues.push({ path: ["meta", key], code: "field_classification_mismatch" });
      }
    }
  }

  if (issues.length > 0) {
    throw new ContractError(issues);
  }

  const result = EventSchema.safeParse({ ...content, ...meta });
  if (!result.success) {
    throw new ContractError(
      result.error.issues.map(({ path, code }) => ({
        path: path.map((segment) => (typeof segment === "symbol" ? String(segment) : segment)),
        code,
      })),
    );
  }
  return result.data;
}
