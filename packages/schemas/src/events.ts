// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";
import { RunBudgetsSchema } from "./config/run.js";
import { JsonPointerSchema } from "./config/pii.js";
import { JsonValue } from "./json.js";
import { MessageSchema, PartSchema } from "./messages.js";
import { Code, Id, Sha256Hex, SpanId, TraceId, Traceparent, WorkspaceRef } from "./primitives.js";

/** Supported run lifecycle states. */
export const RunStatus = z.enum([
  "pending",
  "running",
  "suspended",
  "completed",
  "failed",
  "cancelled",
]);

/** Inferred run lifecycle status. */
export type RunStatus = z.infer<typeof RunStatus>;

const eventEnvelopeShape = {
  runId: Id,
  seq: z.number().int().nonnegative(),
  ts: z.number().int().nonnegative(),
  v: z.number().int().positive(),
  traceId: TraceId,
  spanId: SpanId,
  segmentId: Id,
};

/** Common event fields; the discriminant and payload are defined by each event type. */
export const EventEnvelopeSchema = z.object(eventEnvelopeShape).strict();

const runCreatedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run_created"),
    configHash: Sha256Hex,
    policyVersion: Code,
    parentRunId: Id.optional(),
    parentCallId: Id.optional(),
    continuationOf: Id.optional(),
    scopeId: Id.optional(),
    depth: z.number().int().nonnegative().default(0),
  })
  .strict();

const runInputEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run_input"),
    input: JsonValue,
    inputKind: z.enum(["initial", "follow_up"]),
  })
  .strict();

const runStatusChangedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("run_status_changed"),
    from: RunStatus,
    to: RunStatus,
    reason: Code,
  })
  .strict();

const modelRequestEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("model_request"),
    requestId: Id,
    provider: Code,
    model: Code,
    role: Code.optional(),
    requestHash: Sha256Hex.optional(),
    schemaHash: Sha256Hex.optional(),
    messages: z.array(MessageSchema),
  })
  .strict();

const modelResponseEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("model_response"),
    requestId: Id,
    provider: Code,
    model: Code,
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    costMicros: z.number().int().nonnegative().optional(),
    finishReason: Code,
    latencyMs: z.number().int().nonnegative(),
    schemaValid: z.boolean(),
    repairAttempts: z.number().int().nonnegative(),
    rungUsed: Code.optional(),
    fallbackDepth: z.number().int().nonnegative().default(0),
    structuredValue: JsonValue.optional(),
    content: z.array(PartSchema),
    providerBlobs: JsonValue,
  })
  .strict();

const toolIntentEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("tool_intent"),
    callId: Id,
    toolId: Code,
    idempotent: z.boolean(),
    policyDecision: z.enum(["allow", "ask", "deny"]),
    ruleId: Code.optional(),
    policyReason: Code.optional(),
    policyEditable: z.array(JsonPointerSchema).optional(),
    policyApprovalTtlMs: z.number().int().positive().optional(),
    policyEscalateAfterMs: z.number().int().positive().optional(),
    argsHash: Sha256Hex,
    args: JsonValue,
  })
  .strict();

const toolResultEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("tool_result"),
    callId: Id,
    toolId: Code,
    outcome: z.enum(["ok", "error", "denied", "timeout"]),
    errorCode: Code.optional(),
    latencyMs: z.number().int().nonnegative(),
    executedArgsHash: Sha256Hex.optional(),
    result: JsonValue,
  })
  .strict();

const approvalRequestedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("approval_requested"),
    approvalId: Id,
    callId: Id,
    expiresAt: z.number().int().nonnegative().optional(),
    payload: JsonValue,
  })
  .strict();

// V1 resolutions predate this field and all represented human choices.
const approvalResolvedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("approval_resolved"),
    approvalId: Id,
    decision: z.enum(["approve", "deny", "edit"]),
    decidedBy: z.enum(["human", "policy", "expiry"]).default("human"),
    reason: Code.optional(),
    waitMs: z.number().int().nonnegative(),
    edits: JsonValue.optional(),
  })
  .strict();

const appContentEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("app_content"),
    source: z.literal("app"),
    appId: Code,
    label: z.literal("App-provided; untrusted"),
    kind: z.enum(["message", "model_context"]),
    content: JsonValue,
  })
  .strict();

const checkpointWrittenEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("checkpoint_written"),
    checkpointId: Id,
    atSeq: z.number().int().nonnegative(),
    traceparent: Traceparent,
    workspaceRef: WorkspaceRef.optional(),
  })
  .strict();

const contextCompactedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("context_compacted"),
    fromSeq: z.number().int().nonnegative(),
    toSeq: z.number().int().nonnegative(),
    strategy: Code,
    strategyVersion: Code,
    summary: JsonValue,
    inputTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
    costMicros: z.number().int().nonnegative().optional(),
  })
  .strict();

const piiActionEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("pii_action"),
    boundary: z.enum([
      "model_input",
      "tool_input",
      "tool_output",
      "storage",
      "ui",
      "telemetry_export",
    ]),
    action: z.enum(["tokenized", "redacted", "blocked", "allowed", "detokenized"]),
    toolId: Code.optional(),
    entities: z.array(z.object({ type: Code, count: z.number().int().nonnegative() }).strict()),
  })
  .strict();

const budgetExceededEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("budget_exceeded"),
    budget: z.enum(["steps", "cost", "wall_clock"]),
    limit: z.number(),
    observed: z.number(),
  })
  .strict();

const subagentSpawnedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("subagent_spawned"),
    childRunId: Id,
    role: Code,
    parentCallId: Id.optional(),
    budgetLimits: RunBudgetsSchema.optional(),
    budgetDeadlineTs: z.number().int().nonnegative().optional(),
  })
  .strict();

const subagentCompletedEvent = z
  .object({
    ...eventEnvelopeShape,
    type: z.literal("subagent_completed"),
    childRunId: Id,
    outcome: z.enum(["completed", "failed", "cancelled"]),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    steps: z.number().int().nonnegative().optional(),
    costMicros: z.number().int().nonnegative().optional(),
  })
  .strict();

/** Strict discriminated union of the canonical event schemas. */
export const EventSchema = z.discriminatedUnion("type", [
  runCreatedEvent,
  runInputEvent,
  runStatusChangedEvent,
  modelRequestEvent,
  modelResponseEvent,
  toolIntentEvent,
  toolResultEvent,
  approvalRequestedEvent,
  approvalResolvedEvent,
  appContentEvent,
  checkpointWrittenEvent,
  contextCompactedEvent,
  piiActionEvent,
  budgetExceededEvent,
  subagentSpawnedEvent,
  subagentCompletedEvent,
]);

/** Runtime schema for canonical, strictly validated events. */
export const Event = EventSchema;

/** A validated event in the append-only run log. */
export type Event = z.infer<typeof Event>;

/** Discriminant values supported by {@link EventSchema}. */
export type EventType = Event["type"];

/** Event payload keys, excluding the common envelope and discriminant. */
export type PayloadKeys<T extends EventType> = Exclude<
  keyof Extract<Event, { type: T }>,
  keyof typeof eventEnvelopeShape | "type"
>;

/** Event input before the store assigns its sequence number. */
type EventInput = z.input<typeof EventSchema>;

/** Event input before sequence assignment, retaining defaults as optional inputs. */
export type NewEvent = EventInput extends infer T
  ? T extends EventInput
    ? Omit<T, "seq">
    : never
  : never;
