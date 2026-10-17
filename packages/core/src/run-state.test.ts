// SPDX-License-Identifier: Apache-2.0
import { describe, expect, test } from "vitest";
import { HarnessError, type Event, type RunStatus } from "@harness/schemas";
import type { Plan } from "@harness/context";
import { CorruptLogError, foldRunState, RUN_TRIGGERS, transition, type RunState } from "./index.js";
import { planLastModelResponseRecovery } from "./run-state.js";

const id = "00000000000000000000000000";
const otherRunId = "11111111111111111111111111";
const resumedSegmentId = "22222222222222222222222222";
const hash = "a".repeat(64);
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const envelope = (seq: number, ts = seq + 1, currentSegmentId = id) => ({
  runId: id,
  seq,
  ts,
  v: 1,
  traceId,
  spanId,
  segmentId: currentSegmentId,
});

function runCreated(seq: number, ts = seq + 1): Event {
  return {
    ...envelope(seq, ts),
    type: "run_created",
    configHash: hash,
    policyVersion: "test.policy",
    depth: 0,
  };
}

function statusChanged(
  seq: number,
  from: RunStatus,
  to: RunStatus,
  reason: string,
  ts = seq + 1,
  currentSegmentId = id,
): Event {
  return {
    ...envelope(seq, ts, currentSegmentId),
    type: "run_status_changed",
    from,
    to,
    reason,
  };
}

function toolIntent(seq: number, callId = id): Event {
  return {
    ...envelope(seq),
    type: "tool_intent",
    callId,
    toolId: "test.tool",
    idempotent: false,
    policyDecision: "allow",
    argsHash: hash,
    args: {},
  };
}

function toolResult(seq: number, callId = id): Event {
  return {
    ...envelope(seq),
    type: "tool_result",
    callId,
    toolId: "test.tool",
    outcome: "ok",
    latencyMs: 1,
    result: null,
  };
}

function planUpdate(seq: number, plan: Plan, outcome: "ok" | "error"): Event[] {
  const callId = otherRunId;
  return [
    {
      ...envelope(seq),
      type: "tool_intent",
      callId,
      toolId: "update_plan",
      idempotent: true,
      policyDecision: "allow",
      argsHash: hash,
      args: { plan },
    },
    {
      ...envelope(seq + 1),
      type: "tool_result",
      callId,
      toolId: "update_plan",
      outcome,
      ...(outcome === "error" ? { errorCode: "invalid_plan" } : {}),
      latencyMs: 1,
      result: plan,
    },
  ];
}

function approvalRequested(seq: number, approvalId = id): Event {
  return { ...envelope(seq), type: "approval_requested", approvalId, callId: id, payload: {} };
}

function approvalResolved(seq: number, approvalId = id): Event {
  return {
    ...envelope(seq),
    type: "approval_resolved",
    approvalId,
    decision: "approve",
    decidedBy: "human",
    waitMs: 1,
  };
}

function modelResponse(
  seq: number,
  costMicros?: number,
  ts = seq + 1,
  currentSegmentId = id,
): Event {
  return {
    ...envelope(seq, ts, currentSegmentId),
    type: "model_response",
    requestId: id,
    provider: "test",
    model: "test",
    inputTokens: 3,
    outputTokens: 5,
    finishReason: "stop",
    latencyMs: 1,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    content: [],
    providerBlobs: [],
    ...(costMicros === undefined ? {} : { costMicros }),
  };
}

function checkpoint(seq: number): Event {
  return {
    ...envelope(seq),
    type: "checkpoint_written",
    checkpointId: id,
    atSeq: seq,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

function appendEvent(events: Event[], event: Event): void {
  events.push(event);
}

function seededRandom(seed: number): () => number {
  let value = seed;
  return () => {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    return value / 0x1_0000_0000;
  };
}

describe("foldRunState", () => {
  test("removes a pending tool intent when its result arrives", () => {
    const state = foldRunState([runCreated(0), toolIntent(1), toolResult(2)]);

    expect(state.pendingToolCalls.size).toBe(0);
    expect(state.nextSeq).toBe(3);
    expect(state.startedAt).toBe(1);
    expect(state.lastTs).toBe(3);
  });

  test("derives the latest successful plan for checkpoint snapshots", () => {
    const firstPlan: Plan = {
      items: [{ id: "task.first", text: "first", status: "todo" }],
      notes: "",
    };
    const failedPlan: Plan = {
      items: [{ id: "task.failed", text: "failed", status: "done" }],
      notes: "",
    };
    const events = [
      runCreated(0),
      ...planUpdate(1, firstPlan, "ok"),
      ...planUpdate(3, failedPlan, "error"),
    ];

    expect(foldRunState(events).plan).toEqual(firstPlan);
  });

  describe("planLastModelResponseRecovery", () => {
    test("recovers tool-call parts that do not yet have a tool intent", () => {
      const call = { callId: otherRunId, toolId: "test.tool", args: { value: "synthetic" } };
      const response = {
        ...modelResponse(1),
        content: [{ type: "tool_call" as const, ...call }],
      };

      expect(planLastModelResponseRecovery([runCreated(0), response])).toEqual({
        kind: "tool_calls",
        calls: [call],
      });
    });

    test("completes a response with no tool-call parts or terminal status", () => {
      expect(planLastModelResponseRecovery([runCreated(0), modelResponse(1)])).toEqual({
        kind: "final_answer",
      });
    });

    test("does not recover proposals that already have a tool intent", () => {
      const response = {
        ...modelResponse(1),
        content: [
          { type: "tool_call" as const, callId: otherRunId, toolId: "test.tool", args: {} },
        ],
      };

      expect(
        planLastModelResponseRecovery([runCreated(0), response, toolIntent(2, otherRunId)]),
      ).toEqual({ kind: "none" });
      expect(
        planLastModelResponseRecovery([runCreated(0), modelResponse(1), toolIntent(2)]),
      ).toEqual({ kind: "none" });
    });

    test("does not recover a response followed by a new request or terminal status", () => {
      const response = modelResponse(1);
      const request = {
        ...envelope(2),
        type: "model_request" as const,
        requestId: id,
        provider: "test",
        model: "test",
        messages: [],
      };

      expect(planLastModelResponseRecovery([runCreated(0), response, request])).toEqual({
        kind: "none",
      });
      expect(
        planLastModelResponseRecovery([
          runCreated(0),
          response,
          statusChanged(2, "running", "completed", "final_answer"),
        ]),
      ).toEqual({ kind: "none" });
    });

    test("does not recover when the event history has no model response", () => {
      expect(planLastModelResponseRecovery([runCreated(0)])).toEqual({ kind: "none" });
    });
  });

  test("tracks approval lifecycle, model usage, checkpoint, and the current segment", () => {
    const state = foldRunState([
      runCreated(0),
      approvalRequested(1),
      modelResponse(2),
      checkpoint(3),
      approvalResolved(4),
    ]);

    expect(state.pendingApprovals.size).toBe(0);
    expect(state.approvalRequests.size).toBe(1);
    expect(state.resolvedApprovals.size).toBe(1);
    expect(state.steps).toBe(1);
    expect(state.usage).toEqual({ inputTokens: 3, outputTokens: 5, costMicros: 0 });
    expect(state.lastCheckpoint).toEqual({ checkpointId: id, atSeq: 3 });
    expect(state.segmentId).toBe(id);
    expect(state.lastTs).toBe(5);
  });

  test("adds completed child usage and steps once, treating omitted child fields as zero", () => {
    const completed = (
      seq: number,
      inputTokens: number,
      outputTokens: number,
      steps: number,
      costMicros?: number,
    ) => ({
      ...envelope(seq),
      type: "subagent_completed" as const,
      childRunId: otherRunId,
      outcome: "completed" as const,
      inputTokens,
      outputTokens,
      steps,
      ...(costMicros === undefined ? {} : { costMicros }),
    });
    const state = foldRunState([
      runCreated(0),
      modelResponse(1, 2),
      completed(2, 3, 4, 2, 5),
      completed(3, 7, 8, 3),
    ]);

    expect(state.usage).toEqual({ inputTokens: 13, outputTokens: 17, costMicros: 7 });
    expect(state.steps).toBe(6);
  });

  test("accumulates reported costs and suspension time across a resumed segment", () => {
    const state = foldRunState([
      runCreated(0, 100),
      statusChanged(1, "pending", "running", "start", 101),
      modelResponse(2, 4, 110),
      {
        ...envelope(3, 115),
        type: "context_compacted",
        fromSeq: 1,
        toSeq: 2,
        strategy: "summarizing",
        strategyVersion: "v1",
        summary: "summary",
        inputTokens: 7,
        outputTokens: 2,
        costMicros: 9,
      },
      statusChanged(4, "running", "suspended", "shutdown", 120),
      statusChanged(5, "suspended", "running", "resume", 320, resumedSegmentId),
      modelResponse(6, undefined, 330, resumedSegmentId),
    ]);

    expect(state.usage).toEqual({ inputTokens: 13, outputTokens: 12, costMicros: 13 });
    expect(state.steps).toBe(2);
    expect(state.startedAt).toBe(100);
    expect(state.suspendedTimeMs).toBe(200);
    expect(state.suspendedAt).toBeUndefined();
    expect(state.segmentId).toBe(resumedSegmentId);
  });

  test("rejects an illegal status sequence with corrupt_log", () => {
    const error = new CorruptLogError();
    expect(error).toBeInstanceOf(HarnessError);
    expect(error.code).toBe("corrupt_log");
    expect(() => foldRunState([statusChanged(0, "pending", "completed", "complete")])).toThrow(
      CorruptLogError,
    );
    expect(() => foldRunState([statusChanged(0, "running", "suspended", "shutdown")])).toThrow(
      CorruptLogError,
    );
  });

  test("requires run_created as the first event at sequence zero", () => {
    expect(() => foldRunState([])).toThrow(CorruptLogError);
    expect(() => foldRunState([modelResponse(0)])).toThrow(CorruptLogError);
    expect(() => foldRunState([runCreated(1)])).toThrow(CorruptLogError);
  });

  test.each([
    ["a sequence gap", [runCreated(0), modelResponse(2)]],
    ["a repeated sequence", [runCreated(0), modelResponse(1), modelResponse(1)]],
    ["a reordered sequence", [runCreated(0), modelResponse(2), modelResponse(1)]],
  ])("rejects %s", (_description, events) => {
    expect(() => foldRunState(events)).toThrow(CorruptLogError);
  });

  test("rejects events from a different run", () => {
    expect(() => foldRunState([runCreated(0), { ...modelResponse(1), runId: otherRunId }])).toThrow(
      CorruptLogError,
    );
  });

  test("rejects a tool result without a pending intent", () => {
    expect(() => foldRunState([runCreated(0), toolResult(1)])).toThrow(CorruptLogError);
  });

  test("rejects a duplicate pending tool intent", () => {
    expect(() => foldRunState([runCreated(0), toolIntent(1), toolIntent(2)])).toThrow(
      CorruptLogError,
    );
  });

  test("rejects an approval resolution without a pending request", () => {
    expect(() => foldRunState([runCreated(0), approvalResolved(1)])).toThrow(CorruptLogError);
  });

  test("rejects a duplicate pending approval request", () => {
    expect(() => foldRunState([runCreated(0), approvalRequested(1), approvalRequested(2)])).toThrow(
      CorruptLogError,
    );
  });

  test("folding the same events produces the same state without changing the log", () => {
    const events = [
      runCreated(0),
      statusChanged(1, "pending", "running", "start"),
      modelResponse(2),
      toolIntent(3),
      approvalRequested(4),
      checkpoint(5),
    ];
    const before = structuredClone(events);

    const first = foldRunState(events);
    const second = foldRunState(events);

    expect(first).toEqual(second);
    expect(events).toEqual(before);
  });

  test("generated legal event sequences always fold", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const random = seededRandom(seed);
      const events: Event[] = [runCreated(0)];
      let status: RunStatus = "pending";
      let seq = 1;

      for (let step = 0; step < 20; step += 1) {
        const allowed = RUN_TRIGGERS.filter((trigger) => transition(status, trigger).ok);
        if (allowed.length === 0) {
          break;
        }
        const trigger = allowed[Math.floor(random() * allowed.length)];
        if (trigger === undefined) {
          break;
        }
        const result = transition(status, trigger);
        if (!result.ok) {
          break;
        }
        appendEvent(events, statusChanged(seq, status, result.to, trigger));
        seq += 1;
        status = result.to;

        const extraEvent = Math.floor(random() * 5);
        switch (extraEvent) {
          case 0: {
            appendEvent(events, toolIntent(seq));
            seq += 1;
            appendEvent(events, toolResult(seq));
            break;
          }
          case 1: {
            appendEvent(events, approvalRequested(seq));
            seq += 1;
            appendEvent(events, approvalResolved(seq));
            break;
          }
          case 2:
            appendEvent(events, modelResponse(seq));
            break;
          case 3:
            appendEvent(events, checkpoint(seq));
            break;
          default:
            appendEvent(events, modelResponse(seq));
        }
        seq += 1;
      }

      const state: RunState = foldRunState(events);
      expect(state.nextSeq).toBe(seq);
    }
  });
});
