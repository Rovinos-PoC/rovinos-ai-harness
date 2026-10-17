// SPDX-License-Identifier: Apache-2.0
import { RunConfigSchema, type Event } from "@harness/schemas";
import { describe, expect, it } from "vitest";
import { accountForOpenChildren, BudgetTracker } from "./budgets.js";
import { foldRunState, type RunState } from "./run-state.js";

const runId = "00000000000000000000000000";
const firstSegmentId = "11111111111111111111111111";
const resumedSegmentId = "22222222222222222222222222";
const traceId = "a".repeat(32);
const spanId = "b".repeat(16);
const configHash = "c".repeat(64);
const eventEnvelope = (seq: number, ts: number, segmentId: string) => ({
  runId,
  seq,
  ts,
  v: 1,
  traceId,
  spanId,
  segmentId,
});

function configuredBudgets(budgets: Record<string, unknown>) {
  return RunConfigSchema.parse({ budgets }).budgets;
}

function runState(overrides: Partial<RunState> = {}): RunState {
  return {
    status: "running",
    nextSeq: 2,
    steps: 0,
    usage: { inputTokens: 0, outputTokens: 0, costMicros: 0 },
    pendingToolCalls: new Map(),
    pendingApprovals: new Map(),
    approvalRequests: new Map(),
    resolvedApprovals: new Map(),
    segmentId: "00000000000000000000000000",
    startedAt: 100,
    lastTs: 100,
    suspendedTimeMs: 0,
    ...overrides,
  };
}

describe("BudgetTracker", () => {
  it("allows step usage equal to the limit and rejects one step over", () => {
    const tracker = new BudgetTracker(configuredBudgets({ maxSteps: 2 }));

    expect(tracker.check(runState({ steps: 2 }), 100)).toEqual({ ok: true });
    expect(tracker.check(runState({ steps: 3 }), 100)).toEqual({
      ok: false,
      budget: "steps",
      limit: 2,
      observed: 3,
    });
  });

  it("allows cost equal to the limit and rejects one micro-dollar over", () => {
    const tracker = new BudgetTracker(configuredBudgets({ maxCostUsd: 0.000002 }));

    expect(
      tracker.check(runState({ usage: { inputTokens: 0, outputTokens: 0, costMicros: 2 } }), 100),
    ).toEqual({ ok: true });
    expect(
      tracker.check(runState({ usage: { inputTokens: 0, outputTokens: 0, costMicros: 3 } }), 100),
    ).toEqual({ ok: false, budget: "cost", limit: 2, observed: 3 });
  });

  it("allows wall-clock usage equal to the limit and rejects one millisecond over", () => {
    const tracker = new BudgetTracker(configuredBudgets({ maxWallClockMs: 10 }));

    expect(tracker.deadlineTs(runState())).toBe(110);
    expect(tracker.check(runState(), 110)).toEqual({ ok: true });
    expect(tracker.check(runState(), 111)).toEqual({
      ok: false,
      budget: "wall_clock",
      limit: 10,
      observed: 11,
    });
  });

  it("subtracts completed and ongoing suspension intervals by default", () => {
    const tracker = new BudgetTracker(configuredBudgets({ maxWallClockMs: 10 }));

    expect(tracker.deadlineTs(runState({ suspendedTimeMs: 100 }))).toBe(210);
    expect(tracker.check(runState({ suspendedTimeMs: 100 }), 210)).toEqual({ ok: true });
    expect(tracker.check(runState({ suspendedTimeMs: 100 }), 211)).toMatchObject({
      ok: false,
      budget: "wall_clock",
      observed: 11,
    });
    expect(tracker.check(runState({ suspendedAt: 110 }), 10_000)).toEqual({ ok: true });
  });

  it("counts suspension when configured and treats missing costs as zero usage", () => {
    const tracker = new BudgetTracker(
      configuredBudgets({ maxWallClockMs: 10, maxCostUsd: 0.000001, countSuspendedTime: true }),
    );

    expect(tracker.deadlineTs(runState({ suspendedTimeMs: 100 }))).toBe(110);
    expect(tracker.check(runState({ suspendedTimeMs: 100 }), 210)).toMatchObject({
      ok: false,
      budget: "wall_clock",
      observed: 110,
    });
    expect(tracker.check(runState(), 100)).toEqual({ ok: true });
  });

  it("preserves budgets when folded run history resumes in a new segment", () => {
    const state = foldRunState([
      {
        ...eventEnvelope(0, 100, firstSegmentId),
        type: "run_created",
        configHash,
        policyVersion: "test.policy",
        depth: 0,
      },
      {
        ...eventEnvelope(1, 101, firstSegmentId),
        type: "run_status_changed",
        from: "pending",
        to: "running",
        reason: "start",
      },
      {
        ...eventEnvelope(2, 110, firstSegmentId),
        type: "model_response",
        requestId: runId,
        provider: "test",
        model: "test",
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 1,
        finishReason: "stop",
        latencyMs: 1,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        content: [],
        providerBlobs: null,
      },
      {
        ...eventEnvelope(3, 120, firstSegmentId),
        type: "run_status_changed",
        from: "running",
        to: "suspended",
        reason: "shutdown",
      },
      {
        ...eventEnvelope(4, 420, resumedSegmentId),
        type: "run_status_changed",
        from: "suspended",
        to: "running",
        reason: "resume",
      },
      {
        ...eventEnvelope(5, 430, resumedSegmentId),
        type: "model_response",
        requestId: runId,
        provider: "test",
        model: "test",
        inputTokens: 1,
        outputTokens: 1,
        costMicros: 1,
        finishReason: "stop",
        latencyMs: 1,
        schemaValid: true,
        repairAttempts: 0,
        fallbackDepth: 0,
        content: [],
        providerBlobs: null,
      },
    ] satisfies Event[]);

    expect(state.startedAt).toBe(100);
    expect(state.steps).toBe(2);
    expect(state.usage.costMicros).toBe(2);
    expect(state.suspendedTimeMs).toBe(300);
    expect(state.segmentId).toBe(resumedSegmentId);
    expect(new BudgetTracker(configuredBudgets({ maxSteps: 1 })).check(state, 431)).toMatchObject({
      ok: false,
      budget: "steps",
      observed: 2,
    });
    expect(
      new BudgetTracker(configuredBudgets({ maxCostUsd: 0.000001 })).check(state, 431),
    ).toMatchObject({ ok: false, budget: "cost", observed: 2 });
    expect(
      new BudgetTracker(configuredBudgets({ maxWallClockMs: 25 })).check(state, 431),
    ).toMatchObject({ ok: false, budget: "wall_clock", observed: 31 });
  });

  it("reserves open child allocations in the parent's execution budget", () => {
    const state = runState({
      steps: 1,
      usage: { inputTokens: 0, outputTokens: 0, costMicros: 2 },
    });
    const openChild: Event = {
      ...eventEnvelope(2, 110, firstSegmentId),
      type: "subagent_spawned",
      childRunId: "33333333333333333333333333",
      parentCallId: "44444444444444444444444444",
      role: "worker",
      budgetLimits: configuredBudgets({ maxSteps: 3, maxCostUsd: 0.000003 }),
      budgetDeadlineTs: 500,
    };
    const completedChild: Event = {
      ...eventEnvelope(3, 120, firstSegmentId),
      type: "subagent_spawned",
      childRunId: "55555555555555555555555555",
      parentCallId: "66666666666666666666666666",
      role: "worker",
      budgetLimits: configuredBudgets({ maxSteps: 2, maxCostUsd: 0.000004 }),
      budgetDeadlineTs: 500,
    };
    const history: Event[] = [
      openChild,
      completedChild,
      {
        ...eventEnvelope(4, 130, firstSegmentId),
        type: "subagent_completed",
        childRunId: completedChild.childRunId,
        outcome: "completed",
        inputTokens: 0,
        outputTokens: 0,
        steps: 2,
        costMicros: 4,
      },
    ];

    const accounted = accountForOpenChildren(
      state,
      history,
      configuredBudgets({ maxSteps: 4, maxCostUsd: 0.000005 }),
    );

    expect(accounted.steps).toBe(4);
    expect(accounted.usage.costMicros).toBe(5);
    expect(
      new BudgetTracker(configuredBudgets({ maxSteps: 4, maxCostUsd: 0.000005 })).check(
        accounted,
        110,
      ),
    ).toEqual({ ok: true });
    expect(
      new BudgetTracker(configuredBudgets({ maxSteps: 4 })).check(
        { ...accounted, steps: accounted.steps + 1 },
        110,
      ),
    ).toMatchObject({ ok: false, budget: "steps", observed: 5 });
  });
});
