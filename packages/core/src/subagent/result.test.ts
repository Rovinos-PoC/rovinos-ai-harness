// SPDX-License-Identifier: Apache-2.0
import { Event, Id, type JsonValue as JsonValueType } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { finalizeChild } from "./result.js";

const runId = Id.parse("00000000000000000000000000");
const childRunId = Id.parse("11111111111111111111111111");
const envelope = {
  runId,
  ts: 1,
  v: 1,
  traceId: "a".repeat(32),
  spanId: "b".repeat(16),
  segmentId: runId,
};

function response(
  seq: number,
  text: string,
  usage: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly costMicros?: number;
  } = {},
  enforcement: {
    readonly schemaValid?: boolean;
    readonly rungUsed?: string;
    readonly structuredValue?: JsonValueType;
  } = {},
) {
  return Event.parse({
    ...envelope,
    seq,
    type: "model_response",
    requestId: runId,
    provider: "test",
    model: "test",
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(usage.costMicros === undefined ? {} : { costMicros: usage.costMicros }),
    finishReason: "stop",
    latencyMs: 0,
    schemaValid: enforcement.schemaValid ?? true,
    repairAttempts: 0,
    ...(enforcement.rungUsed === undefined ? {} : { rungUsed: enforcement.rungUsed }),
    ...(enforcement.structuredValue === undefined
      ? {}
      : { structuredValue: enforcement.structuredValue }),
    fallbackDepth: 0,
    content: [{ type: "text", text }],
    providerBlobs: null,
  });
}

function status(
  seq: number,
  to: "completed" | "failed" | "cancelled" | "suspended",
  reason: string,
) {
  return Event.parse({
    ...envelope,
    seq,
    type: "run_status_changed",
    from: "running",
    to,
    reason,
  });
}

describe("finalizeChild", () => {
  it("returns a validated structured tokenized value with exact usage totals", () => {
    const result = finalizeChild({
      childRunId,
      status: "completed",
      hasResultSchema: true,
      events: [
        response(1, "working", { inputTokens: 2, outputTokens: 3, costMicros: 4 }),
        response(
          2,
          '{"email":"<EMAIL_1>"}',
          { inputTokens: 5, outputTokens: 7, costMicros: 11 },
          { schemaValid: true, rungUsed: "native" },
        ),
      ],
    });

    expect(result).toEqual({
      childRunId,
      status: "completed",
      value: { email: "<EMAIL_1>" },
      usage: { inputTokens: 7, outputTokens: 10, steps: 2, costMicros: 15 },
    });
    expect(JSON.stringify(result)).not.toContain("alice@example.test");
  });

  it("wraps final text for roles without a result schema", () => {
    expect(
      finalizeChild({
        childRunId,
        status: "completed",
        hasResultSchema: false,
        events: [response(1, "plain answer", { inputTokens: 1, outputTokens: 2 })],
      }),
    ).toEqual({
      childRunId,
      status: "completed",
      value: { text: "plain answer" },
      usage: { inputTokens: 1, outputTokens: 2, steps: 1 },
    });
  });

  it("turns unvalidated or unparsable structured output into a typed failure", () => {
    const missingRung = finalizeChild({
      childRunId,
      status: "completed",
      hasResultSchema: true,
      events: [response(1, '{"ok":true}')],
    });
    const invalidJson = finalizeChild({
      childRunId,
      status: "completed",
      hasResultSchema: true,
      events: [response(1, "not json", {}, { rungUsed: "native" })],
    });

    expect(missingRung).toMatchObject({
      status: "failed",
      errorCode: "subagent_result_invalid",
    });
    expect(invalidJson).toMatchObject({
      status: "failed",
      errorCode: "subagent_result_invalid",
    });
  });

  it.each([
    ["prefixed", 'Here is the result: {"ok":true}'],
    ["fenced", '```json\n{"ok":true}\n```'],
  ])("uses the durable validated value for %s prompt-rung output", (_description, text) => {
    expect(
      finalizeChild({
        childRunId,
        status: "completed",
        hasResultSchema: true,
        events: [
          response(
            1,
            text,
            {},
            {
              rungUsed: "prompt",
              structuredValue: { ok: true },
            },
          ),
        ],
      }),
    ).toMatchObject({
      status: "completed",
      value: { ok: true },
    });
  });

  it("aggregates descendant and failed structured-call usage from the child log", () => {
    const descendant = Event.parse({
      ...envelope,
      seq: 2,
      type: "subagent_completed",
      childRunId,
      outcome: "completed",
      inputTokens: 7,
      outputTokens: 8,
      steps: 2,
      costMicros: 9,
    });
    const invalid = response(
      1,
      "",
      { inputTokens: 2, outputTokens: 3, costMicros: 4 },
      { schemaValid: false },
    );

    expect(
      finalizeChild({
        childRunId,
        status: "failed",
        hasResultSchema: true,
        events: [invalid, descendant],
      }),
    ).toMatchObject({
      status: "failed",
      usage: { inputTokens: 9, outputTokens: 11, steps: 3, costMicros: 13 },
    });
  });

  it("carries grandchild usage through the child result into the root aggregate", () => {
    const grandchildCompleted = Event.parse({
      ...envelope,
      seq: 2,
      type: "subagent_completed",
      childRunId: Id.parse("22222222222222222222222222"),
      outcome: "completed",
      inputTokens: 7,
      outputTokens: 8,
      steps: 2,
      costMicros: 9,
    });
    const childResult = finalizeChild({
      childRunId,
      status: "completed",
      hasResultSchema: false,
      events: [
        response(1, "child answer", { inputTokens: 2, outputTokens: 3, costMicros: 4 }),
        grandchildCompleted,
      ],
    });
    const childCompleted = Event.parse({
      ...envelope,
      seq: 1,
      type: "subagent_completed",
      childRunId,
      outcome: "completed",
      ...childResult.usage,
    });
    const rootResult = finalizeChild({
      childRunId: runId,
      status: "completed",
      hasResultSchema: false,
      events: [childCompleted],
    });

    expect(childResult.usage).toEqual({
      inputTokens: 9,
      outputTokens: 11,
      steps: 3,
      costMicros: 13,
    });
    expect(rootResult.usage).toEqual(childResult.usage);
  });

  it("maps invalid structured output failures and preserves suspended status", () => {
    expect(
      finalizeChild({
        childRunId,
        status: "failed",
        hasResultSchema: true,
        events: [status(1, "failed", "result_invalid")],
      }),
    ).toMatchObject({ status: "failed", errorCode: "subagent_result_invalid" });
    const suspended = finalizeChild({
      childRunId,
      status: "suspended",
      hasResultSchema: true,
      events: [status(1, "suspended", "awaiting_approval")],
    });
    expect(suspended.status).toBe("suspended");
    expect(suspended).not.toHaveProperty("errorCode");
  });

  it("carries other terminal failure codes and tolerates missing usage events", () => {
    expect(
      finalizeChild({
        childRunId,
        status: "cancelled",
        hasResultSchema: false,
        events: [status(1, "cancelled", "run_cancelled")],
      }),
    ).toEqual({
      childRunId,
      status: "cancelled",
      errorCode: "run_cancelled",
      usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
    });
  });
});
