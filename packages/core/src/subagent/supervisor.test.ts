// SPDX-License-Identifier: Apache-2.0
import { context as otelContext, trace } from "@opentelemetry/api";
import { ensureTracingFallback } from "@harness/telemetry";
import { FakeClock, Id, JsonValue, RunConfigSchema } from "@harness/schemas";
import type { Event } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { describe, expect, it, vi } from "vitest";
import { RunRecorder } from "../recorder.js";
import type { IdGenerator, ModelToolCall, RunContext, ToolPort } from "../ports.js";
import { RUN_SPAN, TOOL_CALL_SPAN } from "../spans.js";
import { toolRunContext } from "../steps/prepare-tool.js";
import { foldRunState } from "../run-state.js";
import type { ResolvedRole } from "../roles.js";
import { aggregateSubagentUsage, finalizeChild } from "./result.js";
import { RunScopeRegistry } from "./scope.js";
import { restrictToolPort, SubagentError, SubagentSupervisor } from "./supervisor.js";
import type {
  SubagentRunRequest,
  SubagentRunner,
  SubagentSupervisorOptions,
} from "./supervisor.js";

const parentRunId = Id.parse("00000000000000000000000000");
const parentCallId = Id.parse("11111111111111111111111111");
const childRunId = Id.parse("22222222222222222222222222");
const grandchildRunId = Id.parse("44444444444444444444444444");
const segmentId = Id.parse("33333333333333333333333333");
const hash = "a".repeat(64);

const role: ResolvedRole = {
  id: "worker",
  tools: ["fs.read", "fs.missing"],
  maxDepth: 2,
  maxChildren: 2,
};

function idGenerator(): IdGenerator {
  return { next: () => childRunId };
}

function parentTools(): ToolPort {
  return {
    describe: (toolId) =>
      toolId === "fs.read" ? { idempotent: true, timeoutMs: 1_000 } : undefined,
    getToolSpecs: () => [
      { toolId: "fs.read", description: "read", inputSchema: { type: "object" } },
      { toolId: "fs.write", description: "write", inputSchema: { type: "object" } },
    ],
    prepare: vi.fn((call) => Promise.resolve(call)),
    execute: vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: null })),
  };
}

function context(overrides: Partial<RunContext> = {}, tools: ToolPort = parentTools()): RunContext {
  return {
    runId: parentRunId,
    signal: new AbortController().signal,
    toolRegistry: tools,
    depth: 0,
    recordSubagentSpawned: vi.fn(() => Promise.resolve()),
    recordSubagentCompleted: vi.fn(() => Promise.resolve()),
    ...overrides,
  };
}

function toolCall(): ModelToolCall {
  return { callId: parentCallId, toolId: "agent.spawn", args: {} };
}

function supervisorOptions(
  runChild: SubagentRunner,
  options: {
    readonly store?: InMemoryEventStore;
    readonly scopes?: RunScopeRegistry;
    readonly ids?: IdGenerator;
    readonly runConfig?: ReturnType<typeof RunConfigSchema.parse>;
    readonly parentSpanContext?: () => { traceId: string; spanId: string; traceFlags: number };
    readonly tools?: ToolPort;
  } = {},
): SubagentSupervisorOptions {
  return {
    store: options.store ?? new InMemoryEventStore(),
    ids: options.ids ?? idGenerator(),
    clock: new FakeClock(1),
    runConfig: options.runConfig ?? RunConfigSchema.parse({}),
    scopes: options.scopes ?? new RunScopeRegistry(),
    parentTools: options.tools ?? parentTools(),
    runChild,
    ...(options.parentSpanContext === undefined
      ? {}
      : { parentSpanContext: options.parentSpanContext }),
  };
}

async function seedParent(store: InMemoryEventStore): Promise<void> {
  await store.append(
    parentRunId,
    [
      {
        runId: parentRunId,
        type: "run_created",
        v: 1,
        ts: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId,
        configHash: hash,
        policyVersion: "test",
        depth: 0,
      },
    ],
    0,
  );
}

async function eventsOf(store: InMemoryEventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

function ensureTracing(): void {
  ensureTracingFallback(
    RUN_SPAN.start({
      "harness.run.id": parentRunId,
      "harness.segment.id": segmentId,
    }),
  );
}

describe("SubagentSupervisor", () => {
  it("records the parent announcement before starting a linked child run", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    const clock = new FakeClock(1);
    const recorder = new RunRecorder(store, parentRunId, segmentId, 1, clock);
    const scopes = new RunScopeRegistry();
    const appendOrder: { readonly runId: string; readonly types: readonly string[] }[] = [];
    const append = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation((runId, events, expectedSeq) => {
      appendOrder.push({ runId, types: events.map(({ type }) => type) });
      return append(runId, events, expectedSeq);
    });
    let childRequest: SubagentRunRequest | undefined;
    const supervisor = new SubagentSupervisor(
      supervisorOptions(
        async (request) => {
          childRequest = request;
          const parentEvents = [];
          for await (const event of store.read(parentRunId)) {
            parentEvents.push(event);
          }
          expect(parentEvents.some(({ type }) => type === "subagent_spawned")).toBe(true);
          const childRecorder = new RunRecorder(store, childRunId, segmentId, 0, clock);
          await childRecorder.withStepSpan(
            RUN_SPAN,
            {
              "harness.run.parent_id": parentRunId,
              "harness.run.depth": request.depth,
            },
            () =>
              childRecorder
                .recordBatch([
                  {
                    type: "run_created",
                    v: 1,
                    configHash: hash,
                    policyVersion: "test",
                    parentRunId,
                    parentCallId,
                    scopeId: request.scopeId,
                    depth: request.depth,
                  },
                  { type: "run_input", v: 1, input: request.input, inputKind: "initial" },
                  {
                    type: "run_status_changed",
                    v: 1,
                    from: "pending",
                    to: "running",
                    reason: "start",
                  },
                ])
                .then((events) => {
                  const lastEvent = events.at(-1);
                  if (lastEvent === undefined) {
                    throw new Error("Expected child run events.");
                  }
                  return lastEvent;
                }),
            { links: request.rootSpanLinks, parentContext: request.rootSpanParent },
          );
          return {
            childRunId: request.runId,
            status: "completed",
            value: null,
            usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
          };
        },
        {
          store,
          scopes,
          tools: parentTools(),
          parentSpanContext: () => ({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            traceFlags: 1,
          }),
        },
      ),
    );
    await seedParent(store);
    const toolContext = toolRunContext(context({ depth: 0 }), recorder, []);

    let childResult: JsonValue = null;
    await recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      await recorder.record({
        type: "tool_intent",
        v: 1,
        callId: parentCallId,
        toolId: "agent.spawn",
        idempotent: false,
        policyDecision: "allow",
        argsHash: hash,
        args: {},
      });
      childResult = JsonValue.parse(
        await supervisor.spawn({
          role,
          goal: "tokenized goal",
          inputs: { ref: "<EMAIL_1>" },
          call: toolCall(),
          context: toolContext,
        }),
      );
      return recorder.record({
        type: "tool_result",
        v: 1,
        callId: parentCallId,
        toolId: "agent.spawn",
        outcome: "ok",
        latencyMs: 0,
        result: childResult,
      });
    });

    expect(childResult).toEqual({
      childRunId,
      status: "completed",
      value: null,
      usage: { inputTokens: 2, outputTokens: 3, costMicros: 4 },
    });
    expect(childRequest).toMatchObject({
      runId: childRunId,
      parentRunId,
      parentCallId,
      scopeId: parentRunId,
      depth: 1,
      role,
      input: { goal: "tokenized goal", inputs: { ref: "<EMAIL_1>" } },
    });
    expect(childRequest?.rootSpanLinks[0]?.context).toEqual(childRequest?.parentSpanContext);
    expect(scopes.scopeOf(childRunId)).toBe(parentRunId);
    expect(childRequest?.tools.describe("fs.read")).toBeDefined();
    expect(childRequest?.tools.describe("fs.write")).toBeUndefined();
    const childEvents: Event[] = [];
    for await (const event of store.read(childRunId)) {
      childEvents.push(event);
    }
    expect(childEvents[0]).toMatchObject({
      type: "run_created",
      parentRunId,
      parentCallId,
      depth: 1,
    });
    const spawnAppend = appendOrder.findIndex(({ types }) => types.includes("subagent_spawned"));
    const childAppend = appendOrder.findIndex(
      ({ runId: requestedRunId, types }) =>
        requestedRunId === childRunId && types.includes("run_created"),
    );
    expect(spawnAppend).toBeGreaterThanOrEqual(0);
    expect(childAppend).toBeGreaterThan(spawnAppend);
    expect(
      appendOrder.some(
        ({ runId: requestedRunId, types }) =>
          requestedRunId === parentRunId && types.includes("subagent_completed"),
      ),
    ).toBe(true);
  });

  it("enforces role depth and existing-child limits before recording", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    await store.append(
      parentRunId,
      [
        {
          runId: parentRunId,
          type: "subagent_spawned",
          v: 1,
          ts: 2,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId,
          childRunId,
          role: "worker",
          parentCallId: Id.parse("55555555555555555555555555"),
        },
      ],
      1,
    );
    const recordSpawned = vi.fn(() => Promise.resolve());
    const runChild = vi.fn(() =>
      Promise.resolve({
        childRunId,
        status: "completed" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    const supervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    await expect(
      supervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: context({ depth: 2, recordSubagentSpawned: recordSpawned }),
      }),
    ).rejects.toMatchObject({ code: "subagent_depth_limit" });
    await expect(
      supervisor.spawn({
        role: { ...role, maxChildren: 1 },
        goal: "goal",
        call: toolCall(),
        context: context({ recordSubagentSpawned: recordSpawned }),
      }),
    ).rejects.toMatchObject({ code: "subagent_children_limit" });
    expect(recordSpawned).not.toHaveBeenCalled();
    expect(runChild).not.toHaveBeenCalled();
  });

  it("enforces the global depth, total-child, and concurrent-child limits", async () => {
    const runChild = vi.fn();
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recordSpawned = vi.fn(() => Promise.resolve());
    const globalDepthSupervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        runConfig: RunConfigSchema.parse({ subagents: { maxDepth: 0 } }),
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );
    await expect(
      globalDepthSupervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: context({ recordSubagentSpawned: recordSpawned }),
      }),
    ).rejects.toMatchObject({ code: "subagent_limit" });

    await store.append(
      parentRunId,
      [
        {
          runId: parentRunId,
          type: "subagent_spawned",
          v: 1,
          ts: 2,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId,
          childRunId,
          role: "worker",
          parentCallId: Id.parse("55555555555555555555555555"),
        },
      ],
      1,
    );
    const concurrentSupervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        runConfig: RunConfigSchema.parse({ subagents: { maxConcurrentChildren: 1 } }),
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );
    await expect(
      concurrentSupervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: context({ recordSubagentSpawned: recordSpawned }),
      }),
    ).rejects.toMatchObject({ code: "subagent_limit" });
    await store.append(
      parentRunId,
      [
        {
          runId: parentRunId,
          type: "subagent_completed",
          v: 1,
          ts: 3,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId,
          childRunId,
          outcome: "completed",
          inputTokens: 0,
          outputTokens: 0,
        },
      ],
      2,
    );
    const totalChildrenSupervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        runConfig: RunConfigSchema.parse({ subagents: { maxChildrenPerRun: 1 } }),
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );
    await expect(
      totalChildrenSupervisor.spawn({
        role,
        goal: "goal",
        call: { ...toolCall(), callId: Id.parse("77777777777777777777777777") },
        context: context({ recordSubagentSpawned: recordSpawned }),
      }),
    ).rejects.toMatchObject({ code: "subagent_limit" });
    expect(recordSpawned).not.toHaveBeenCalled();
    expect(runChild).not.toHaveBeenCalled();
  });

  it("returns a completed spawn result without re-deriving exhausted parent budgets", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    await seedParent(store);
    const clock = new FakeClock(10);
    const budgets = RunConfigSchema.parse({
      budgets: { maxSteps: 2, maxCostUsd: 0.000002 },
    }).budgets;
    const parentRecorder = new RunRecorder(store, parentRunId, segmentId, 1, clock);
    await parentRecorder.withStepSpan(RUN_SPAN, {}, () =>
      parentRecorder
        .recordBatch([
          {
            type: "subagent_spawned",
            v: 1,
            childRunId,
            role: "worker",
            parentCallId,
            budgetLimits: budgets,
            budgetDeadlineTs: 100,
          },
          {
            type: "subagent_completed",
            v: 1,
            childRunId,
            outcome: "completed",
            inputTokens: 1,
            outputTokens: 1,
            steps: 2,
            costMicros: 2,
          },
        ])
        .then((events) => {
          const last = events.at(-1);
          if (last === undefined) {
            throw new Error("Expected cached completion events.");
          }
          return last;
        }),
    );
    const childRecorder = new RunRecorder(store, childRunId, segmentId, 0, clock);
    await childRecorder.withStepSpan(RUN_SPAN, {}, () =>
      childRecorder
        .recordBatch([
          {
            type: "run_created",
            v: 1,
            configHash: hash,
            policyVersion: "test",
            parentRunId,
            parentCallId,
            scopeId: parentRunId,
            depth: 1,
          },
          { type: "run_input", v: 1, input: { goal: "goal" }, inputKind: "initial" },
          { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
          {
            type: "model_response",
            v: 1,
            requestId: parentCallId,
            provider: "test",
            model: "worker",
            inputTokens: 1,
            outputTokens: 1,
            costMicros: 2,
            finishReason: "stop",
            latencyMs: 1,
            schemaValid: true,
            repairAttempts: 0,
            fallbackDepth: 0,
            content: [{ type: "text", text: "cached answer" }],
            providerBlobs: null,
          },
          {
            type: "run_status_changed",
            v: 1,
            from: "running",
            to: "completed",
            reason: "final_answer",
          },
        ])
        .then((events) => {
          const last = events.at(-1);
          if (last === undefined) {
            throw new Error("Expected cached child events.");
          }
          return last;
        }),
    );
    const runChild = vi.fn();
    const supervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        runConfig: RunConfigSchema.parse({ budgets }),
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    await expect(
      supervisor.spawn({ role, goal: "goal", call: toolCall(), context: context() }),
    ).resolves.toMatchObject({
      childRunId,
      status: "completed",
      value: { text: "cached answer" },
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    expect(runChild).not.toHaveBeenCalled();
  });

  it("does not start an announced child after cancellation recorded its completion", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recorder = new RunRecorder(store, parentRunId, segmentId, 1, new FakeClock(10));
    await recorder.withStepSpan(RUN_SPAN, {}, () =>
      recorder
        .recordBatch([
          {
            type: "subagent_spawned",
            v: 1,
            childRunId,
            role: "worker",
            parentCallId,
            budgetLimits: RunConfigSchema.parse({}).budgets,
            budgetDeadlineTs: 100,
          },
          {
            type: "subagent_completed",
            v: 1,
            childRunId,
            outcome: "cancelled",
            inputTokens: 0,
            outputTokens: 0,
            steps: 0,
            costMicros: 0,
          },
        ])
        .then((events) => {
          const last = events.at(-1);
          if (last === undefined) {
            throw new Error("Expected cancelled child completion.");
          }
          return last;
        }),
    );
    const runChild = vi.fn();
    const supervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    await expect(
      supervisor.spawn({ role, goal: "goal", call: toolCall(), context: context() }),
    ).resolves.toMatchObject({ childRunId, status: "cancelled" });
    expect(runChild).not.toHaveBeenCalled();
  });

  it("propagates parent cancellation to a live child signal", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const controller = new AbortController();
    let childSignal: AbortSignal | undefined;
    let finishChild: ((result: Awaited<ReturnType<SubagentRunner>>) => void) | undefined;
    const supervisor = new SubagentSupervisor(
      supervisorOptions(
        (request) => {
          childSignal = request.signal;
          return new Promise((resolve) => {
            finishChild = resolve;
          });
        },
        {
          store,
          parentSpanContext: () => ({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            traceFlags: 1,
          }),
        },
      ),
    );
    const spawn = supervisor.spawn({
      role,
      goal: "goal",
      call: toolCall(),
      context: context({ signal: controller.signal }),
    });
    await vi.waitFor(() => {
      expect(childSignal).toBeDefined();
    });

    controller.abort("cancel_requested");
    expect(childSignal?.aborted).toBe(true);
    expect(childSignal).not.toBe(controller.signal);
    finishChild?.({
      childRunId,
      status: "completed",
      value: null,
      usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
    });
    await expect(spawn).resolves.toMatchObject({ status: "completed" });
  });

  it("serializes spawn limits with the durable announcement", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recorder = new RunRecorder(store, parentRunId, segmentId, 1, new FakeClock(1));
    const childIds = [childRunId, grandchildRunId];
    let idIndex = 0;
    const ids: IdGenerator = {
      next: () => {
        const id = childIds[idIndex];
        idIndex += 1;
        if (id === undefined) {
          throw new Error("Unexpected child id request.");
        }
        return id;
      },
    };
    let finishChild: ((result: Awaited<ReturnType<SubagentRunner>>) => void) | undefined;
    let admittedBudgets: SubagentRunRequest["budgets"] | undefined;
    const runChild = vi.fn(
      (request: SubagentRunRequest) =>
        new Promise<Awaited<ReturnType<SubagentRunner>>>((resolve) => {
          admittedBudgets = request.budgets;
          finishChild = resolve;
        }),
    );
    const supervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        ids,
        runConfig: RunConfigSchema.parse({
          budgets: { maxSteps: 10, maxCostUsd: 0.00001 },
          subagents: { maxChildrenPerRun: 1, maxConcurrentChildren: 1 },
        }),
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );
    const spawn = (callId: Id) => {
      const events: Event[] = [];
      const runContext = toolRunContext(context(), recorder, events);
      return recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
        await supervisor.spawn({
          role,
          goal: "goal",
          call: { ...toolCall(), callId },
          context: runContext,
        });
        const last = events.at(-1);
        if (last === undefined) {
          throw new Error("Expected a durable spawn event.");
        }
        return last;
      });
    };
    const both = Promise.all([
      spawn(parentCallId),
      spawn(Id.parse("55555555555555555555555555")),
    ]).catch((error: unknown) => error);
    await vi.waitFor(() => {
      expect(runChild).toHaveBeenCalledTimes(1);
    });

    finishChild?.({
      childRunId,
      status: "completed",
      value: null,
      usage: { inputTokens: 0, outputTokens: 0, steps: 0 },
    });
    await expect(both).resolves.toMatchObject({ code: "subagent_limit" });
    expect(admittedBudgets).toMatchObject({ maxSteps: 10, maxCostUsd: 0.00001 });
    expect(
      (await eventsOf(store, parentRunId)).filter((event) => event.type === "subagent_spawned"),
    ).toHaveLength(1);
  });

  it("reserves budget for suspended concurrent children", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recorder = new RunRecorder(store, parentRunId, segmentId, 1, new FakeClock(1));
    const childBudgets: { readonly maxSteps: number; readonly maxCostUsd: number | undefined }[] =
      [];
    let resolveBoth = (): void => undefined;
    const bothRunning = new Promise<void>((resolve) => {
      resolveBoth = resolve;
    });
    const runChild: SubagentRunner = async (request) => {
      childBudgets.push({
        maxSteps: request.budgets.maxSteps,
        maxCostUsd: request.budgets.maxCostUsd,
      });
      if (childBudgets.length === 2) {
        resolveBoth();
      }
      await bothRunning;
      return {
        childRunId: request.runId,
        status: "suspended",
        usage: { inputTokens: 0, outputTokens: 0, steps: 1, costMicros: 5 },
      };
    };
    const supervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        ids: {
          next: () => (childBudgets.length === 0 ? childRunId : grandchildRunId),
        },
        runConfig: RunConfigSchema.parse({
          subagents: { maxChildrenPerRun: 2, maxConcurrentChildren: 2 },
          budgets: { maxSteps: 10, maxCostUsd: 0.00001 },
        }),
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );
    const spawn = (callId: Id) => {
      const events: Event[] = [];
      const runContext = toolRunContext(context(), recorder, events);
      return recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
        await supervisor.spawn({
          role,
          goal: "goal",
          call: { ...toolCall(), callId },
          context: runContext,
        });
        const last = events.at(-1);
        if (last === undefined) {
          throw new Error("Expected a durable spawn event.");
        }
        return last;
      });
    };
    const first = spawn(parentCallId);
    const second = spawn(Id.parse("55555555555555555555555555"));

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(childBudgets).toEqual([
      { maxSteps: 5, maxCostUsd: 0.000005 },
      { maxSteps: 5, maxCostUsd: 0.000005 },
    ]);
    expect(
      (await eventsOf(store, parentRunId)).filter((event) => event.type === "subagent_completed"),
    ).toHaveLength(0);
  });

  it("gives a lone child the full remaining parent budget", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recorder = new RunRecorder(store, parentRunId, segmentId, 1, new FakeClock(1));
    let childBudgets: SubagentRunRequest["budgets"] | undefined;
    const supervisor = new SubagentSupervisor(
      supervisorOptions(
        (request) => {
          childBudgets = request.budgets;
          return Promise.resolve({
            childRunId: request.runId,
            status: "suspended",
            usage: { inputTokens: 0, outputTokens: 0, steps: 1, costMicros: 1 },
          });
        },
        {
          store,
          runConfig: RunConfigSchema.parse({
            subagents: { maxConcurrentChildren: 2 },
            budgets: { maxSteps: 10, maxCostUsd: 0.00001 },
          }),
          parentSpanContext: () => ({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            traceFlags: 1,
          }),
        },
      ),
    );

    const events: Event[] = [];
    const runContext = toolRunContext(context(), recorder, events);
    await recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      await supervisor.spawn({ role, goal: "goal", call: toolCall(), context: runContext });
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected a durable spawn event.");
      }
      return last;
    });

    expect(childBudgets).toMatchObject({ maxSteps: 10, maxCostUsd: 0.00001 });
  });

  it("caps sequential children to the parent's remaining cost without double counting", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recorder = new RunRecorder(store, parentRunId, segmentId, 1, new FakeClock(1));
    const childBudgets: { readonly steps: number; readonly costUsd: number }[] = [];
    let childCount = 0;
    const supervisor = new SubagentSupervisor(
      supervisorOptions(
        (request) => {
          childBudgets.push({
            steps: request.budgets.maxSteps,
            costUsd: request.budgets.maxCostUsd ?? -1,
          });
          childCount += 1;
          return Promise.resolve({
            childRunId: request.runId,
            status: "completed",
            value: null,
            usage: {
              inputTokens: 1,
              outputTokens: 1,
              steps: 5,
              costMicros: 5,
            },
          });
        },
        {
          store,
          ids: {
            next: () => Id.parse(String(childCount + 2).padStart(26, "0")),
          },
          runConfig: RunConfigSchema.parse({ budgets: { maxSteps: 10, maxCostUsd: 0.00001 } }),
          parentSpanContext: () => ({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            traceFlags: 1,
          }),
        },
      ),
    );
    const firstCallId = Id.parse("55555555555555555555555555");
    const secondCallId = Id.parse("66666666666666666666666666");

    await recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      const runContext = toolRunContext(context(), recorder, []);
      await recorder.record({
        type: "tool_intent",
        v: 1,
        callId: firstCallId,
        toolId: "agent.spawn",
        idempotent: false,
        policyDecision: "allow",
        argsHash: hash,
        args: {},
      });
      await supervisor.spawn({
        role: { ...role, budgets: { maxCostUsd: 0.00002 } },
        goal: "first",
        call: { ...toolCall(), callId: firstCallId },
        context: runContext,
      });
      await recorder.record({
        type: "tool_result",
        v: 1,
        callId: firstCallId,
        toolId: "agent.spawn",
        outcome: "ok",
        latencyMs: 0,
        result: null,
      });
      await recorder.record({
        type: "tool_intent",
        v: 1,
        callId: secondCallId,
        toolId: "agent.spawn",
        idempotent: false,
        policyDecision: "allow",
        argsHash: hash,
        args: {},
      });
      await supervisor.spawn({
        role: { ...role, budgets: { maxCostUsd: 0.00002 } },
        goal: "second",
        call: { ...toolCall(), callId: secondCallId },
        context: runContext,
      });
      return recorder.record({
        type: "tool_result",
        v: 1,
        callId: secondCallId,
        toolId: "agent.spawn",
        outcome: "ok",
        latencyMs: 0,
        result: null,
      });
    });

    expect(childBudgets).toEqual([
      { steps: 10, costUsd: 0.00001 },
      { steps: 5, costUsd: 0.000005 },
    ]);
    const state = foldRunState(await eventsOf(store, parentRunId));
    expect(state.usage.costMicros).toBe(10);
    expect(state.steps).toBe(10);
  });

  it("records aggregated usage when a child runner rejects, then rethrows", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recordCompleted = vi.fn(() => Promise.resolve());
    const runChild: SubagentRunner = async (request) => {
      await store.append(
        request.runId,
        [
          {
            runId: request.runId,
            type: "run_created",
            v: 1,
            ts: 1,
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            segmentId,
            configHash: hash,
            policyVersion: "test",
            parentRunId,
            parentCallId,
            scopeId: parentRunId,
            depth: 1,
          },
          {
            runId: request.runId,
            type: "model_response",
            v: 1,
            ts: 2,
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            segmentId,
            requestId: parentCallId,
            provider: "test",
            model: "test",
            inputTokens: 3,
            outputTokens: 5,
            costMicros: 7,
            finishReason: "stop",
            latencyMs: 1,
            schemaValid: true,
            repairAttempts: 0,
            fallbackDepth: 0,
            content: [],
            providerBlobs: null,
          },
        ],
        0,
      );
      throw Object.assign(new Error("conflict"), { code: "seq_conflict" });
    };
    const supervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    await expect(
      supervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: context({ recordSubagentCompleted: recordCompleted }),
      }),
    ).rejects.toMatchObject({ code: "seq_conflict" });
    expect(recordCompleted).toHaveBeenCalledExactlyOnceWith({
      childRunId,
      outcome: "failed",
      inputTokens: 3,
      outputTokens: 5,
      steps: 1,
      costMicros: 7,
    });
  });

  it("records zero-usage failure when the child runner rejects before run creation", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recordCompleted = vi.fn(() => Promise.resolve());
    const runnerError = Object.assign(new Error("startup failed"), { code: "child_start_failed" });
    const supervisor = new SubagentSupervisor(
      supervisorOptions(() => Promise.reject(runnerError), {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    await expect(
      supervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: context({ recordSubagentCompleted: recordCompleted }),
      }),
    ).rejects.toBe(runnerError);
    expect(recordCompleted).toHaveBeenCalledExactlyOnceWith({
      childRunId,
      outcome: "failed",
      inputTokens: 0,
      outputTokens: 0,
      steps: 0,
    });
  });

  it("does not double-record completion when cancellation wins against a live child", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const recordCompleted = vi.fn(() => Promise.resolve());
    const supervisor = new SubagentSupervisor(
      supervisorOptions(
        async () => {
          await store.append(
            parentRunId,
            [
              {
                runId: parentRunId,
                type: "subagent_completed",
                v: 1,
                ts: 2,
                traceId: "a".repeat(32),
                spanId: "b".repeat(16),
                segmentId,
                childRunId,
                outcome: "cancelled",
                inputTokens: 3,
                outputTokens: 5,
                steps: 2,
                costMicros: 7,
              },
            ],
            1,
          );
          throw Object.assign(new Error("parent cancelled"), { code: "run_aborted" });
        },
        {
          store,
          parentSpanContext: () => ({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            traceFlags: 1,
          }),
        },
      ),
    );

    await expect(
      supervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: context({ recordSubagentCompleted: recordCompleted }),
      }),
    ).rejects.toMatchObject({ code: "run_aborted" });
    expect(recordCompleted).not.toHaveBeenCalled();
    expect(
      (await eventsOf(store, parentRunId)).filter((event) => event.type === "subagent_completed"),
    ).toHaveLength(1);
  });

  it("resumes after the spawn announcement without duplicating parent events", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const clock = new FakeClock(1);
    const firstRecorder = new RunRecorder(store, parentRunId, segmentId, 1, clock);
    let attempts = 0;
    const runChild: SubagentRunner = (request) => {
      attempts += 1;
      if (attempts === 1) {
        return Promise.reject(
          Object.assign(new Error("simulated crash after spawn announcement"), {
            code: "seq_conflict",
          }),
        );
      }
      return Promise.resolve({
        childRunId: request.runId,
        status: "completed",
        value: { text: "done" },
        usage: { inputTokens: 3, outputTokens: 5, costMicros: 7 },
      });
    };
    const firstSupervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    const invokeSpawn = async (
      recorder: RunRecorder,
      supervisor: SubagentSupervisor,
      recordSubagentCompleted?: RunContext["recordSubagentCompleted"],
    ) =>
      recorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
        const spawnContext = toolRunContext(context(), recorder, []);
        const result = await supervisor.spawn({
          role,
          goal: "goal",
          call: toolCall(),
          context:
            recordSubagentCompleted === undefined
              ? spawnContext
              : { ...spawnContext, recordSubagentCompleted },
        });
        return recorder.record({
          type: "tool_result",
          v: 1,
          callId: parentCallId,
          toolId: "agent.spawn",
          outcome: "ok",
          latencyMs: 0,
          result: JsonValue.parse(result),
        });
      });

    ensureTracing();
    await expect(
      invokeSpawn(firstRecorder, firstSupervisor, () => Promise.reject(new Error("crash window"))),
    ).rejects.toMatchObject({ code: "seq_conflict" });
    const afterCrash = [];
    for await (const event of store.read(parentRunId)) {
      afterCrash.push(event);
    }
    expect(afterCrash.filter((event) => event.type === "subagent_spawned")).toHaveLength(1);
    expect(afterCrash.filter((event) => event.type === "subagent_completed")).toHaveLength(0);
    const resumedRecorder = new RunRecorder(store, parentRunId, segmentId, 2, clock);
    const resumedSupervisor = new SubagentSupervisor(
      supervisorOptions(runChild, {
        store,
        ids: { next: () => Id.parse("44444444444444444444444444") },
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );
    await invokeSpawn(resumedRecorder, resumedSupervisor);

    const events = [];
    for await (const event of store.read(parentRunId)) {
      events.push(event);
    }
    expect(events.filter((event) => event.type === "subagent_spawned")).toHaveLength(1);
    expect(events.filter((event) => event.type === "subagent_completed")).toHaveLength(1);
    expect(events.find((event) => event.type === "subagent_spawned")).toMatchObject({
      childRunId,
      parentCallId,
    });
    expect(attempts).toBe(2);
  });

  it("records a safe diagnostic when failed-completion recording fails and preserves the runner error", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const runnerError = Object.assign(new Error("runner failed"), { code: "seq_conflict" });
    const supervisor = new SubagentSupervisor(
      supervisorOptions(() => Promise.reject(runnerError), {
        store,
        parentSpanContext: () => ({
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          traceFlags: 1,
        }),
      }),
    );

    const span = TOOL_CALL_SPAN.start({
      "harness.run.id": parentRunId,
    });
    const setAttribute = vi.spyOn(span, "setAttribute");
    const getSpan = vi.spyOn(trace, "getSpan").mockReturnValue(span);
    try {
      await expect(
        otelContext.with(trace.setSpan(otelContext.active(), span), () =>
          supervisor.spawn({
            role,
            goal: "goal",
            call: toolCall(),
            context: context({
              recordSubagentCompleted: () => Promise.reject(new Error("recorder failed")),
            }),
          }),
        ),
      ).rejects.toBe(runnerError);
    } finally {
      getSpan.mockRestore();
      span.end();
    }
    expect(setAttribute).toHaveBeenCalledWith("harness.subagent.completion_record_failed", true);
  });

  it("derives nested budgets from the active child's remaining allocation", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    await seedParent(store);
    const clock = new FakeClock(1);
    const rootRecorder = new RunRecorder(store, parentRunId, segmentId, 1, clock);
    const scopes = new RunScopeRegistry();
    const parentSpanContext = () => ({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    });
    const runConfig = RunConfigSchema.parse({
      subagents: { maxConcurrentChildren: 1 },
      budgets: { maxSteps: 10, maxCostUsd: 0.0001, maxWallClockMs: 2_000 },
    });
    const grandchildBudgets: {
      readonly maxSteps: number;
      readonly maxCostUsd: number | undefined;
      readonly deadlineTs: number;
    }[] = [];
    const grandchildRunner: SubagentRunner = (request) => {
      expect(request.depth).toBe(2);
      grandchildBudgets.push({
        maxSteps: request.budgets.maxSteps,
        maxCostUsd: request.budgets.maxCostUsd,
        deadlineTs: request.budgetDeadlineTs,
      });
      return Promise.resolve({
        childRunId: request.runId,
        status: "completed",
        value: { text: "grandchild answer" },
        usage: { inputTokens: 7, outputTokens: 8, costMicros: 9 },
      });
    };
    const childRunner: SubagentRunner = async (request) => {
      await store.append(
        request.runId,
        [
          {
            runId: request.runId,
            type: "run_created",
            v: 1,
            ts: 1,
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
            segmentId,
            configHash: hash,
            policyVersion: "test",
            parentRunId,
            parentCallId: request.parentCallId,
            scopeId: request.scopeId,
            depth: request.depth,
          },
        ],
        0,
      );
      const childRecorder = new RunRecorder(store, request.runId, segmentId, 1, clock);
      await childRecorder.withStepSpan(TOOL_CALL_SPAN, {}, () =>
        childRecorder.record({
          type: "model_response",
          v: 1,
          requestId: parentCallId,
          provider: "test",
          model: "worker",
          inputTokens: 2,
          outputTokens: 3,
          costMicros: 4,
          finishReason: "stop",
          latencyMs: 1,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          content: [{ type: "text", text: "child answer" }],
          providerBlobs: null,
        }),
      );
      const grandchildSupervisor = new SubagentSupervisor(
        supervisorOptions(grandchildRunner, {
          store,
          scopes,
          ids: { next: () => grandchildRunId },
          parentSpanContext,
          runConfig,
        }),
      );
      const grandchildCallId = Id.parse("55555555555555555555555555");
      await childRecorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
        clock.advance(25);
        const result = await grandchildSupervisor.spawn({
          role,
          goal: "grandchild goal",
          call: {
            callId: grandchildCallId,
            toolId: "agent.spawn",
            args: {},
          },
          context: toolRunContext(
            context({ runId: request.runId, depth: request.depth }),
            childRecorder,
            [],
          ),
        });
        return childRecorder.record({
          type: "tool_result",
          v: 1,
          callId: grandchildCallId,
          toolId: "agent.spawn",
          outcome: "ok",
          latencyMs: 0,
          result: JsonValue.parse(result),
        });
      });
      const childEvents: Event[] = [];
      for await (const event of store.read(request.runId)) {
        childEvents.push(event);
      }
      return finalizeChild({
        childRunId: request.runId,
        status: "completed",
        events: childEvents,
        hasResultSchema: false,
      });
    };
    const rootSupervisor = new SubagentSupervisor(
      supervisorOptions(childRunner, {
        store,
        scopes,
        parentSpanContext,
        runConfig,
      }),
    );

    await rootRecorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      const result = await rootSupervisor.spawn({
        role: { ...role, budgets: { maxSteps: 3, maxCostUsd: 0.00003, maxWallClockMs: 1_000 } },
        goal: "child goal",
        call: toolCall(),
        context: toolRunContext(context(), rootRecorder, []),
      });
      return rootRecorder.record({
        type: "tool_result",
        v: 1,
        callId: parentCallId,
        toolId: "agent.spawn",
        outcome: "ok",
        latencyMs: 0,
        result: JsonValue.parse(result),
      });
    });
    const rootEvents: Event[] = [];
    for await (const event of store.read(parentRunId)) {
      rootEvents.push(event);
    }

    expect(aggregateSubagentUsage(rootEvents)).toEqual({
      inputTokens: 9,
      outputTokens: 11,
      steps: 1,
      costMicros: 13,
    });
    expect(grandchildBudgets).toEqual([{ maxSteps: 2, maxCostUsd: 0.000026, deadlineTs: 1_001 }]);
  });

  it("fails closed when durable recording or a parent span is unavailable", async () => {
    const store = new InMemoryEventStore();
    await seedParent(store);
    const runChild = vi.fn(() =>
      Promise.resolve({
        childRunId,
        status: "completed" as const,
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );
    const supervisor = new SubagentSupervisor(supervisorOptions(runChild, { store }));
    const withoutRecorder: RunContext = {
      runId: parentRunId,
      signal: new AbortController().signal,
    };

    await expect(
      supervisor.spawn({ role, goal: "goal", call: toolCall(), context: withoutRecorder }),
    ).rejects.toBeInstanceOf(SubagentError);
    await expect(
      supervisor.spawn({ role, goal: "goal", call: toolCall(), context: context() }),
    ).rejects.toMatchObject({ code: "subagent_parent_span_missing" });
    await expect(
      supervisor.spawn({
        role,
        goal: "goal",
        call: toolCall(),
        context: {
          runId: parentRunId,
          signal: new AbortController().signal,
          depth: 0,
          recordSubagentSpawned: vi.fn(() => Promise.resolve()),
        },
      }),
    ).rejects.toMatchObject({ code: "subagent_recorder_unavailable" });
    expect(runChild).not.toHaveBeenCalled();
  });

  it("restricts the child registry to existing role tools", async () => {
    const tools = parentTools();
    const restricted = restrictToolPort(tools, ["fs.read", "fs.write"]);

    expect(restricted.getToolSpecs?.().map(({ toolId }) => toolId)).toEqual(["fs.read"]);
    expect(restricted.describe("fs.read")).toBeDefined();
    expect(restricted.describe("fs.write")).toBeUndefined();
    await expect(
      restricted.execute({ ...toolCall(), toolId: "fs.write" }, context({}, tools)),
    ).resolves.toMatchObject({ outcome: "error", errorCode: "unknown_tool" });
  });
});
