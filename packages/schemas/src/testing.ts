// SPDX-License-Identifier: Apache-2.0
// Fake IDs use a zero timestamp and an incrementing Crockford base32 suffix.

import type { Event } from "./events.js";

const id = "00000000000000000000000000";
const sha256 = "a".repeat(64);
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const traceparent = `00-${traceId}-${spanId}-01`;
const envelope = { runId: id, seq: 0, ts: 1, v: 1, traceId, spanId, segmentId: id };

/** Synthetic valid examples used by event schema and classification tests. */
export const eventSamples = [
  { ...envelope, type: "run_created", configHash: sha256, policyVersion: "policy.v1", depth: 0 },
  { ...envelope, type: "run_input", input: "hello", inputKind: "initial" },
  { ...envelope, type: "run_status_changed", from: "pending", to: "running", reason: "started" },
  {
    ...envelope,
    type: "model_request",
    requestId: id,
    provider: "test",
    model: "test",
    messages: [{ role: "user", parts: [{ type: "text", text: "hello" }] }],
  },
  {
    ...envelope,
    type: "model_response",
    requestId: id,
    provider: "test",
    model: "test",
    inputTokens: 1,
    outputTokens: 2,
    costMicros: 3,
    finishReason: "stop",
    latencyMs: 3,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [{ type: "text", text: "hello" }],
    providerBlobs: [],
  },
  {
    ...envelope,
    type: "tool_intent",
    callId: id,
    toolId: "test.tool",
    idempotent: false,
    policyDecision: "allow",
    argsHash: sha256,
    args: {},
  },
  {
    ...envelope,
    type: "tool_result",
    callId: id,
    toolId: "test.tool",
    outcome: "ok",
    latencyMs: 1,
    result: null,
  },
  { ...envelope, type: "approval_requested", approvalId: id, callId: id, payload: {} },
  {
    ...envelope,
    type: "approval_resolved",
    approvalId: id,
    decision: "approve",
    decidedBy: "human",
    waitMs: 1,
  },
  {
    ...envelope,
    type: "app_content",
    source: "app",
    appId: "test.app",
    label: "App-provided; untrusted",
    kind: "message",
    content: { content: [{ type: "text", text: "app content" }] },
  },
  {
    ...envelope,
    type: "checkpoint_written",
    checkpointId: id,
    atSeq: 1,
    traceparent,
  },
  {
    ...envelope,
    type: "context_compacted",
    fromSeq: 0,
    toSeq: 1,
    strategy: "summary",
    strategyVersion: "v1",
    summary: "compacted",
    inputTokens: 2,
    outputTokens: 1,
    costMicros: 3,
  },
  {
    ...envelope,
    type: "pii_action",
    boundary: "model_input",
    action: "tokenized",
    entities: [{ type: "email", count: 1 }],
  },
  {
    ...envelope,
    type: "pii_action",
    boundary: "telemetry_export",
    action: "blocked",
    entities: [{ type: "email", count: 1 }],
  },
  { ...envelope, type: "budget_exceeded", budget: "steps", limit: 1, observed: 2 },
  {
    ...envelope,
    type: "subagent_spawned",
    childRunId: id,
    role: "researcher",
    budgetLimits: { maxSteps: 10, maxWallClockMs: 1000, countSuspendedTime: false },
    budgetDeadlineTs: 1000,
  },
  {
    ...envelope,
    type: "subagent_completed",
    childRunId: id,
    outcome: "completed",
    inputTokens: 3,
    outputTokens: 2,
    costMicros: 1,
  },
] satisfies Event[];

const CROCKFORD_BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ID_SUFFIX_CAPACITY = 32n ** 16n;

/** A controllable clock for deterministic tests. */
export class FakeClock {
  private currentTime: number;

  /** Creates a fake clock starting at the given epoch millisecond. */
  constructor(initialTime = 0) {
    if (!Number.isSafeInteger(initialTime)) {
      throw new RangeError("Initial time must be a safe integer.");
    }

    this.currentTime = initialTime;
  }

  /** Returns the current fake epoch time in milliseconds. */
  now(): number {
    return this.currentTime;
  }

  /** Advances the clock by a non-negative integer number of milliseconds. */
  advance(milliseconds: number): void {
    const nextTime = this.currentTime + milliseconds;
    if (
      !Number.isSafeInteger(milliseconds) ||
      milliseconds < 0 ||
      !Number.isSafeInteger(nextTime)
    ) {
      throw new RangeError("Advance must be a non-negative safe integer.");
    }

    this.currentTime = nextTime;
  }
}

/** Generates deterministic, ULID-shaped identifiers for tests. */
export class SequentialIdGenerator {
  private counter = 0n;

  /** Returns the next unique 26-character Crockford base32 identifier. */
  next(): string {
    if (this.counter >= ID_SUFFIX_CAPACITY) {
      throw new RangeError("Sequential ID capacity exhausted.");
    }

    let remaining = this.counter;
    let suffix = "";
    for (let digit = 0; digit < 16; digit += 1) {
      suffix = CROCKFORD_BASE32.charAt(Number(remaining % 32n)) + suffix;
      remaining /= 32n;
    }

    this.counter += 1n;
    return `0000000000${suffix}`;
  }
}
