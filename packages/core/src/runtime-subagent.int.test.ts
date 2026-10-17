// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  FakeClock,
  Id,
  KeysConfigSchema,
  ModelsConfigSchema,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  type Detection,
  type Event,
  type Id as IdValue,
  type NewEvent,
  type RunConfig,
} from "@harness/schemas";
import type { SandboxBackend } from "@harness/sandbox";
import type { ModelPort, ModelRequest, ModelCompletion, ToolPort } from "./ports.js";
import { InMemoryEventStore, type EventStore } from "@harness/store";
import { InMemoryVault, AuditingVaultResolver, Token } from "@harness/vault";
import { PiiToolPort, Tokenizer } from "@harness/pii";
import { describe, expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";
import type { RuntimeConfig } from "./runtime-config.js";
import type { ShutdownProcessLike } from "./shutdown.js";
import { allowAllPolicy } from "./testing/allow-policy.js";
import { RunScopeRegistry } from "./subagent/scope.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const email = "alice@example.test";
const rootRunId = Id.parse("00000000000000000000000000");
const childRunId = Id.parse("11111111111111111111111111");
const childCallId = Id.parse("22222222222222222222222222");
const makeCallId = Id.parse("33333333333333333333333333");
const spawnCallId = Id.parse("44444444444444444444444444");
const resolveCallId = Id.parse("55555555555555555555555555");
const hash = "a".repeat(64);

function completion(
  parts: ModelCompletion["parts"],
  usage: ModelCompletion["usage"] = { inputTokens: 1, outputTokens: 1 },
): ModelCompletion {
  return {
    parts,
    usage,
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "fake",
    model: "fake",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

async function seedSuspendedBudgetChild(
  store: EventStore,
  budgets: RunConfig["budgets"],
  deadlineTs: number,
  responseCount: number,
  costMicros: number,
): Promise<void> {
  const rootEnvelope = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: rootRunId,
  };
  const childEnvelope = {
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId: childRunId,
  };
  await store.append(
    rootRunId,
    [
      {
        ...rootEnvelope,
        runId: rootRunId,
        ts: 1,
        type: "run_created",
        v: 1,
        configHash: hash,
        policyVersion: "test",
        depth: 0,
      },
      {
        ...rootEnvelope,
        runId: rootRunId,
        ts: 2,
        type: "subagent_spawned",
        v: 1,
        childRunId,
        role: "worker",
        parentCallId: childCallId,
        budgetLimits: budgets,
        budgetDeadlineTs: deadlineTs,
      },
    ] satisfies NewEvent[],
    0,
  );
  const childEvents: NewEvent[] = [
    {
      ...childEnvelope,
      runId: childRunId,
      ts: 1,
      type: "run_created",
      v: 1,
      configHash: hash,
      policyVersion: "test",
      parentRunId: rootRunId,
      parentCallId: childCallId,
      scopeId: rootRunId,
      depth: 1,
    },
    {
      ...childEnvelope,
      runId: childRunId,
      ts: 2,
      type: "run_input",
      v: 1,
      input: { goal: "resume under inherited budget" },
      inputKind: "initial",
    },
    {
      ...childEnvelope,
      runId: childRunId,
      ts: 3,
      type: "run_status_changed",
      v: 1,
      from: "pending",
      to: "running",
      reason: "start",
    },
    ...Array.from({ length: responseCount }, (_, index) => {
      const callId = Id.parse(String(index + 1).padStart(26, "0"));
      const ts = 4 + index * 2;
      return [
        {
          ...childEnvelope,
          runId: childRunId,
          ts,
          type: "model_response" as const,
          v: 1 as const,
          requestId: callId,
          provider: "test",
          model: "test",
          inputTokens: 0,
          outputTokens: 0,
          costMicros,
          finishReason: "tool_calls" as const,
          latencyMs: 1,
          schemaValid: true,
          repairAttempts: 0,
          fallbackDepth: 0,
          content: [
            { type: "tool_call" as const, callId, toolId: Code.parse("test.make"), args: {} },
          ],
          providerBlobs: null,
        },
        {
          ...childEnvelope,
          runId: childRunId,
          ts: ts + 1,
          type: "tool_intent" as const,
          v: 1 as const,
          callId,
          toolId: Code.parse("test.make"),
          idempotent: true,
          policyDecision: "allow" as const,
          argsHash: hash,
          args: {},
        },
      ];
    }).flat(),
    {
      ...childEnvelope,
      runId: childRunId,
      ts: 10,
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "suspended",
      reason: "shutdown",
    },
  ];
  await store.append(childRunId, childEvents, 0);
}

function detector(): { detect(text: string): readonly Detection[] } {
  return {
    detect: (text) => {
      const start = text.indexOf(email);
      return start < 0
        ? []
        : [
            {
              entityType: "email",
              start,
              end: start + email.length,
              confidence: 1,
              detectorId: "test.email",
            },
          ];
    },
  };
}

function piiTool(
  scopes: RunScopeRegistry,
  vault: InMemoryVault,
  resolvedValues: string[],
  sandboxBackend?: SandboxBackend,
): ToolPort {
  const config = PiiConfigSchema.parse({
    defaultAction: "tokenize",
    detokenize: [{ toolId: "test.resolve", args: ["/token"] }],
  });
  const tools: ToolPort = {
    describe: (toolId) =>
      toolId === "test.make" || toolId === "test.resolve"
        ? { idempotent: true, timeoutMs: 10_000 }
        : undefined,
    getToolSpecs: () => [
      {
        toolId: "test.make",
        description: "Create a synthetic token",
        inputSchema: { type: "object" },
      },
      {
        toolId: "test.resolve",
        description: "Resolve a synthetic token",
        inputSchema: { type: "object" },
      },
    ],
    execute: async (call, context) => {
      await sandboxBackend?.exec(
        context.runId,
        {
          argv: ["/bin/true"],
          timeoutMs: 1000,
          limits: { memoryMb: 32, pids: 2, outputBytes: 0, cpuSeconds: 1 },
        },
        context.signal,
      );
      if (call.toolId === "test.make") {
        return { outcome: "ok", result: { value: email } };
      }
      const token =
        call.args !== null && typeof call.args === "object" && !Array.isArray(call.args)
          ? call.args.token
          : undefined;
      if (typeof token !== "string") {
        return {
          outcome: "error",
          errorCode: "test_token_missing",
          result: null,
        };
      }
      resolvedValues.push(token);
      return { outcome: "ok", result: { value: token } };
    },
  };
  return new PiiToolPort(tools, {
    tokenizer: new Tokenizer({
      detectors: detector(),
      policy: config,
      vault,
      scopeOf: scopes.scopeOf,
    }),
    config,
    resolver: new AuditingVaultResolver(vault, () => undefined, scopes.scopeOf),
  });
}

function leaseAwareSandbox(runIds: IdValue[]): SandboxBackend {
  let owner: IdValue | undefined;
  return {
    acquireLease: (runId) => {
      if (owner !== undefined && owner !== runId) {
        return Promise.reject(new Error("synthetic lease conflict"));
      }
      owner = runId;
      return Promise.resolve();
    },
    releaseLease: (runId) => {
      if (owner === runId) {
        owner = undefined;
      }
      return Promise.resolve();
    },
    exec: (runId) => {
      if (owner !== undefined && owner !== runId) {
        return Promise.reject(new Error("synthetic lease conflict"));
      }
      const temporary = owner === undefined;
      owner = runId;
      runIds.push(runId);
      if (temporary) {
        owner = undefined;
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        durationMs: 0,
      });
    },
  };
}

function runtimePiiTool(resolvedValues: string[]): ToolPort {
  return {
    describe: (toolId) =>
      toolId === "test.make" || toolId === "test.resolve"
        ? { idempotent: true, timeoutMs: 10_000 }
        : undefined,
    getToolSpecs: () => [
      {
        toolId: "test.make",
        description: "Create a synthetic token",
        inputSchema: { type: "object" },
      },
      {
        toolId: "test.resolve",
        description: "Resolve a synthetic token",
        inputSchema: { type: "object" },
      },
    ],
    execute: (call) => {
      if (call.toolId === "test.make") {
        return Promise.resolve({ outcome: "ok", result: { value: email } });
      }
      const token =
        call.args !== null && typeof call.args === "object" && !Array.isArray(call.args)
          ? call.args.token
          : undefined;
      if (typeof token !== "string") {
        return Promise.resolve({
          outcome: "error",
          errorCode: "test_token_missing",
          result: null,
        });
      }
      resolvedValues.push(token);
      return Promise.resolve({ outcome: "ok", result: { value: token } });
    },
  };
}

class SpawnModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  private parentCall = 0;
  private childCall = 0;

  complete(request: ModelRequest): Promise<ModelCompletion> {
    this.requests.push(request);
    if (request.role === "worker") {
      this.childCall += 1;
      return Promise.resolve(
        this.childCall === 1
          ? completion([
              {
                type: "tool_call",
                callId: resolveCallId,
                toolId: Code.parse("test.resolve"),
                args: { token: "<EMAIL_1>" },
              },
            ])
          : completion([{ type: "text", text: "child answer" }]),
      );
    }
    this.parentCall += 1;
    switch (this.parentCall) {
      case 1:
        return Promise.resolve(
          completion([
            {
              type: "tool_call",
              callId: makeCallId,
              toolId: Code.parse("test.make"),
              args: {},
            },
          ]),
        );
      case 2:
        return Promise.resolve(
          completion([
            {
              type: "tool_call",
              callId: spawnCallId,
              toolId: Code.parse("agent.spawn"),
              args: {
                role: "worker",
                goal: "inspect the shared token",
                inputs: { token: "<EMAIL_1>" },
              },
            },
          ]),
        );
      default:
        return Promise.resolve(completion([{ type: "text", text: "parent answer" }]));
    }
  }
}

class TwoChildBudgetModel implements ModelPort {
  private parentCalls = 0;
  private childCalls = 0;

  complete(request: ModelRequest): Promise<ModelCompletion> {
    if (request.role === "worker") {
      this.childCalls += 1;
      return Promise.resolve(
        completion([{ type: "text", text: "child answer" }], {
          inputTokens: 1,
          outputTokens: 1,
          costMicros: this.childCalls === 1 ? 6 : 4,
        }),
      );
    }
    this.parentCalls += 1;
    if (this.parentCalls <= 2) {
      const callId = this.parentCalls === 1 ? childCallId : makeCallId;
      return Promise.resolve(
        completion([
          {
            type: "tool_call",
            callId,
            toolId: Code.parse("agent.spawn"),
            args: { role: "worker", goal: `child ${String(this.parentCalls)}` },
          },
        ]),
      );
    }
    return Promise.resolve(completion([{ type: "text", text: "parent answer" }]));
  }
}

async function eventsFor(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

class TestShutdownProcess implements ShutdownProcessLike {
  exitCode: number | undefined;
  private readonly listeners = new Map<"SIGINT" | "SIGTERM", (() => void)[]>();

  on(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.listeners.set(signal, [...(this.listeners.get(signal) ?? []), listener]);
    return this;
  }

  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.listeners.set(
      signal,
      (this.listeners.get(signal) ?? []).filter((registered) => registered !== listener),
    );
    return this;
  }

  exit(): void {
    this.exitCode = 0;
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    for (const listener of this.listeners.get(signal) ?? []) {
      listener();
    }
  }
}

describe("runtime subagent spawning", () => {
  it("caps total parent and child step and cost usage over two children", async () => {
    const store = new InMemoryEventStore();
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({
          budgets: { maxSteps: 10, maxCostUsd: 0.00001 },
        }),
        models: ModelsConfigSchema.parse({
          routing: {
            default: [{ provider: "local", model: "parent" }],
            roles: { worker: [{ provider: "local", model: "worker" }] },
          },
        }),
        roles: [{ id: "worker", route: "worker", tools: [], maxDepth: 2, maxChildren: 2 }],
      },
      {
        store,
        transientVault: true,
        clock: new FakeClock(4),
        ids: new SequentialIdGenerator(),
        model: new TwoChildBudgetModel(),
        tool: {
          describe: () => undefined,
          execute: () =>
            Promise.resolve({ outcome: "error", errorCode: "unknown_tool", result: null }),
        },
        policy: allowAllPolicy,
      },
    );
    try {
      const parent = await runtime.run("start");
      const completions = parent.events.filter((event) => event.type === "subagent_completed");

      expect(parent.status).toBe("completed");
      expect(parent.state.steps).toBe(5);
      expect(parent.state.usage.costMicros).toBe(10);
      expect(completions).toMatchObject([
        { outcome: "completed", steps: 1, costMicros: 6 },
        { outcome: "completed", steps: 1, costMicros: 4 },
      ]);
    } finally {
      await runtime.close();
    }
  });

  it("runs a production child after the durable announcement with tokenized input and shared scope", async () => {
    const store = new InMemoryEventStore();
    const appendOrder: { readonly runId: Id; readonly types: readonly string[] }[] = [];
    const append = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation((runId, events, expectedSeq) => {
      appendOrder.push({ runId, types: events.map(({ type }) => type) });
      return append(runId, events, expectedSeq);
    });
    const scopes = new RunScopeRegistry();
    const vault = new InMemoryVault();
    const resolvedValues: string[] = [];
    const model = new SpawnModel();
    const sandboxRunIds: IdValue[] = [];
    const sandboxBackend = leaseAwareSandbox(sandboxRunIds);
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        pii: PiiConfigSchema.parse({ enabled: false }),
        models: ModelsConfigSchema.parse({
          routing: {
            default: [{ provider: "local", model: "parent" }],
            roles: { worker: [{ provider: "local", model: "worker" }] },
          },
        }),
        roles: [
          {
            id: "worker",
            route: "worker",
            systemPrompt: "Work carefully.",
            tools: ["test.resolve"],
            contextStrategy: "naive",
            maxDepth: 2,
            maxChildren: 2,
          },
        ],
      },
      {
        store,
        transientVault: true,
        clock: new FakeClock(4),
        ids: new SequentialIdGenerator(),
        model,
        tool: piiTool(scopes, vault, resolvedValues, sandboxBackend),
        sandboxBackend,
        scopeRegistry: scopes,
        policy: allowAllPolicy,
      },
    );
    try {
      const parent = await runtime.run("start");
      const parentId = parent.events[0]?.runId;
      const spawned = parent.events.find((event) => event.type === "subagent_spawned");
      if (parentId === undefined || spawned?.type !== "subagent_spawned") {
        throw new Error("Expected the parent run to spawn a child.");
      }
      const childEvents = await eventsFor(store, spawned.childRunId);
      const childCreated = childEvents[0];
      const childInput = childEvents.find((event) => event.type === "run_input");
      const spawnAppendIndex = appendOrder.findIndex(({ types }) =>
        types.includes("subagent_spawned"),
      );
      const childAppendIndex = appendOrder.findIndex(
        ({ runId, types }) => runId === spawned.childRunId && types.includes("run_created"),
      );
      const childRequest = model.requests.find(({ role }) => role === "worker");

      expect(parent.status).toBe("completed");
      expect(childCreated).toMatchObject({
        type: "run_created",
        parentRunId: parentId,
        parentCallId: spawnCallId,
        scopeId: parentId,
        depth: 1,
      });
      expect(childInput).toMatchObject({
        type: "run_input",
        input: { goal: "inspect the shared token", inputs: { token: "<EMAIL_1>" } },
      });
      expect(spawnAppendIndex).toBeGreaterThanOrEqual(0);
      expect(childAppendIndex).toBeGreaterThan(spawnAppendIndex);
      expect(resolvedValues).toEqual([email]);
      expect(sandboxRunIds).toHaveLength(2);
      expect(new Set(sandboxRunIds).size).toBe(2);
      expect(childRequest?.messages[0]).toEqual({
        role: "system",
        parts: [{ type: "text", text: "Work carefully." }],
      });
      expect(
        parent.events.find(
          (event) => event.type === "tool_result" && event.toolId === "agent.spawn",
        ),
      ).toMatchObject({
        outcome: "ok",
        result: {
          childRunId: spawned.childRunId,
          status: "completed",
          value: { text: "child answer" },
          usage: { inputTokens: 2, outputTokens: 2 },
        },
      });
      expect(parent.events.find((event) => event.type === "subagent_completed")).toMatchObject({
        outcome: "completed",
        inputTokens: 2,
        outputTokens: 2,
      });
    } finally {
      await runtime.close();
    }
  });

  it("keeps a shutdown-aborted child suspended and resumable", async () => {
    const store = new InMemoryEventStore();
    const scopes = new RunScopeRegistry();
    const shutdown = new TestShutdownProcess();
    let signalChildStarted = (): void => undefined;
    const childStarted = new Promise<void>((resolve) => {
      signalChildStarted = resolve;
    });
    let calls = 0;
    const model: ModelPort = {
      complete: (_request, context) => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            completion([
              {
                type: "tool_call",
                callId: spawnCallId,
                toolId: Code.parse("agent.spawn"),
                args: { role: "worker", goal: "suspend child" },
              },
            ]),
          );
        }
        return new Promise((_resolve, reject) => {
          const abort = (): void => {
            reject(new Error("shutdown"));
          };
          context.signal.addEventListener("abort", abort, { once: true });
          if (context.signal.aborted) {
            abort();
          }
          signalChildStarted();
        });
      },
    };
    const config: RuntimeConfig = {
      run: RunConfigSchema.parse({}),
      pii: PiiConfigSchema.parse({ enabled: false }),
      models: ModelsConfigSchema.parse({
        routing: {
          default: [{ provider: "local", model: "parent" }],
          roles: { worker: [{ provider: "local", model: "worker" }] },
        },
      }),
      roles: [
        {
          id: "worker",
          route: "worker",
          tools: [],
          maxDepth: 2,
          maxChildren: 1,
        },
      ],
    };
    const runtime = await createRuntime(config, {
      store,
      transientVault: true,
      clock: new FakeClock(4),
      ids: new SequentialIdGenerator(),
      model,
      tool: runtimePiiTool([]),
      scopeRegistry: scopes,
      policy: allowAllPolicy,
      processLike: shutdown,
    });
    let suspendedChildRunId = rootRunId;
    try {
      const running = runtime.start("suspend nested work", { runId: rootRunId });
      await running.started;
      await childStarted;
      shutdown.emit("SIGTERM");
      await expect(running.completion).resolves.toMatchObject({ status: "suspended" });

      const rootEvents = await eventsFor(store, rootRunId);
      const spawn = rootEvents.find((event) => event.type === "subagent_spawned");
      if (spawn?.type !== "subagent_spawned") {
        throw new Error("Expected a child announcement.");
      }
      suspendedChildRunId = spawn.childRunId;
      expect(
        (await eventsFor(store, suspendedChildRunId)).findLast(
          (event) => event.type === "run_status_changed",
        ),
      ).toMatchObject({
        type: "run_status_changed",
        to: "suspended",
        reason: "shutdown",
      });
    } finally {
      await runtime.close();
    }

    const resumedRuntime = await createRuntime(config, {
      store,
      transientVault: true,
      clock: new FakeClock(5),
      ids: new SequentialIdGenerator(),
      model: {
        complete: () => Promise.resolve(completion([{ type: "text", text: "resumed" }])),
      },
      tool: runtimePiiTool([]),
      scopeRegistry: new RunScopeRegistry(),
      policy: allowAllPolicy,
    });
    try {
      await expect(resumedRuntime.resume(suspendedChildRunId)).resolves.toMatchObject({
        status: "completed",
      });
    } finally {
      await resumedRuntime.close();
    }
  });

  it("cancels a live child and grandchild and records terminal completion at each parent", async () => {
    const store = new InMemoryEventStore();
    const scopes = new RunScopeRegistry();
    let modelCalls = 0;
    let grandchildSignal: AbortSignal | undefined;
    let markGrandchildStarted = (): void => undefined;
    const grandchildStarted = new Promise<void>((resolve) => {
      markGrandchildStarted = resolve;
    });
    const model: ModelPort = {
      complete: (_request, context) => {
        modelCalls += 1;
        if (modelCalls === 1) {
          return Promise.resolve(
            completion([
              {
                type: "tool_call",
                callId: spawnCallId,
                toolId: Code.parse("agent.spawn"),
                args: { role: "worker", goal: "start child" },
              },
            ]),
          );
        }
        if (modelCalls === 2) {
          return Promise.resolve(
            completion([
              {
                type: "tool_call",
                callId: childCallId,
                toolId: Code.parse("agent.spawn"),
                args: { role: "worker", goal: "start grandchild" },
              },
            ]),
          );
        }
        return new Promise((_resolve, reject) => {
          grandchildSignal = context.signal;
          const abort = (): void => {
            reject(new Error("grandchild cancelled"));
          };
          context.signal.addEventListener("abort", abort, { once: true });
          if (context.signal.aborted) {
            abort();
          }
          markGrandchildStarted();
        });
      },
    };
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({ subagents: { maxConcurrentChildren: 1 } }),
        pii: PiiConfigSchema.parse({ enabled: false }),
        models: ModelsConfigSchema.parse({
          routing: {
            default: [{ provider: "local", model: "parent" }],
            roles: { worker: [{ provider: "local", model: "worker" }] },
          },
        }),
        roles: [
          {
            id: "worker",
            route: "worker",
            tools: ["agent.spawn"],
            maxDepth: 3,
            maxChildren: 2,
          },
        ],
      },
      {
        store,
        transientVault: true,
        clock: new FakeClock(4),
        ids: new SequentialIdGenerator(),
        model,
        tool: runtimePiiTool([]),
        scopeRegistry: scopes,
        policy: allowAllPolicy,
      },
    );
    try {
      const running = runtime.start("cancel nested work", { runId: rootRunId });
      await running.started;
      await grandchildStarted;
      await expect(runtime.cancel(rootRunId)).resolves.toBe("cancelled");
      const rootResult = await running.completion;
      const rootEvents = await eventsFor(store, rootRunId);
      const childSpawn = rootEvents.find((event) => event.type === "subagent_spawned");
      if (childSpawn?.type !== "subagent_spawned") {
        throw new Error("Expected a child announcement.");
      }
      const childEvents = await eventsFor(store, childSpawn.childRunId);
      const grandchildSpawn = childEvents.find((event) => event.type === "subagent_spawned");
      if (grandchildSpawn?.type !== "subagent_spawned") {
        throw new Error("Expected a grandchild announcement.");
      }
      const grandchildEvents = await eventsFor(store, grandchildSpawn.childRunId);

      expect(rootResult.status).toBe("cancelled");
      expect(grandchildSignal?.aborted).toBe(true);
      expect(rootEvents.at(-1)).toMatchObject({
        type: "run_status_changed",
        to: "cancelled",
      });
      expect(childEvents.at(-1)).toMatchObject({
        type: "run_status_changed",
        to: "cancelled",
      });
      expect(grandchildEvents.at(-1)).toMatchObject({
        type: "run_status_changed",
        to: "cancelled",
      });
      expect(rootEvents).toContainEqual(
        expect.objectContaining({
          type: "subagent_completed",
          childRunId: childSpawn.childRunId,
          outcome: "cancelled",
        }),
      );
      expect(childEvents).toContainEqual(
        expect.objectContaining({
          type: "subagent_completed",
          childRunId: grandchildSpawn.childRunId,
          outcome: "cancelled",
        }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("stops a child cancelled exactly when its run_created event is appended", async () => {
    const store = new InMemoryEventStore();
    let cancellationInjected = false;
    let childModelCalls = 0;
    const model: ModelPort = {
      complete: (request) => {
        if (request.role === "worker") {
          childModelCalls += 1;
          return Promise.resolve(completion([{ type: "text", text: "must not run" }]));
        }
        return Promise.resolve(
          completion([
            {
              type: "tool_call",
              callId: spawnCallId,
              toolId: Code.parse("agent.spawn"),
              args: { role: "worker", goal: "cancel at child startup" },
            },
          ]),
        );
      },
    };
    const runtime = await createRuntime(
      {
        run: RunConfigSchema.parse({}),
        pii: PiiConfigSchema.parse({ enabled: false }),
        models: ModelsConfigSchema.parse({
          routing: {
            default: [{ provider: "local", model: "parent" }],
            roles: { worker: [{ provider: "local", model: "worker" }] },
          },
        }),
        roles: [
          {
            id: "worker",
            route: "worker",
            tools: [],
            maxDepth: 2,
            maxChildren: 1,
          },
        ],
      },
      {
        store,
        transientVault: true,
        clock: new FakeClock(4),
        ids: new SequentialIdGenerator(),
        model,
        tool: runtimePiiTool([]),
        scopeRegistry: new RunScopeRegistry(),
        policy: allowAllPolicy,
      },
    );
    const append = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation(async (runId, events, expectedSeq) => {
      const result = await append(runId, events, expectedSeq);
      if (
        !cancellationInjected &&
        runId !== rootRunId &&
        events.some((event) => event.type === "run_created")
      ) {
        await runtime.cancel(rootRunId);
        cancellationInjected = true;
      }
      return result;
    });
    try {
      const running = runtime.start("cancel child startup", { runId: rootRunId });
      await running.started;
      await expect(running.completion).resolves.toMatchObject({ status: "cancelled" });

      const parentEvents = await eventsFor(store, rootRunId);
      const spawned = parentEvents.find((event) => event.type === "subagent_spawned");
      if (spawned?.type !== "subagent_spawned") {
        throw new Error("Expected a child announcement.");
      }
      const childEvents = await eventsFor(store, spawned.childRunId);
      expect(cancellationInjected).toBe(true);
      expect(childModelCalls).toBe(0);
      expect(childEvents.at(-1)).toMatchObject({
        type: "run_status_changed",
        to: "cancelled",
      });
      expect(
        parentEvents.filter(
          (event) => event.type === "subagent_completed" && event.childRunId === spawned.childRunId,
        ),
      ).toHaveLength(1);
    } finally {
      await runtime.close();
    }
  });

  it.each([
    {
      name: "steps",
      budgets: RunConfigSchema.parse({ budgets: { maxSteps: 2 } }).budgets,
      deadlineTs: 100,
      responseCount: 3,
      costMicros: 0,
      now: 20,
      exceeded: "steps",
    },
    {
      name: "cost",
      budgets: RunConfigSchema.parse({ budgets: { maxCostUsd: 0.000001 } }).budgets,
      deadlineTs: 100,
      responseCount: 1,
      costMicros: 2,
      now: 20,
      exceeded: "cost",
    },
    {
      name: "absolute deadline",
      budgets: RunConfigSchema.parse({ budgets: { maxWallClockMs: 100 } }).budgets,
      deadlineTs: 10,
      responseCount: 0,
      costMicros: 0,
      now: 20,
      exceeded: "wall_clock",
    },
  ] as const)("restores inherited $name limits after runtime recreation", async (scenario) => {
    const store = new InMemoryEventStore();
    await seedSuspendedBudgetChild(
      store,
      scenario.budgets,
      scenario.deadlineTs,
      scenario.responseCount,
      scenario.costMicros,
    );
    const completeModel = vi.fn(() =>
      Promise.resolve(completion([{ type: "text", text: "must not run" }])),
    );
    const model: ModelPort = { complete: completeModel };
    const scopes = new RunScopeRegistry();
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}), pii: PiiConfigSchema.parse({ enabled: false }) },
      {
        store,
        transientVault: true,
        clock: new FakeClock(scenario.now),
        ids: new SequentialIdGenerator(),
        model,
        tool: runtimePiiTool([]),
        scopeRegistry: scopes,
        policy: allowAllPolicy,
      },
    );
    try {
      const resumed = await runtime.resume(childRunId);

      expect(completeModel).not.toHaveBeenCalled();
      expect(resumed.events).toContainEqual(
        expect.objectContaining({ type: "budget_exceeded", budget: scenario.exceeded }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("resumes a recreated child within its persisted two-step budget", async () => {
    const store = new InMemoryEventStore();
    const budgets = RunConfigSchema.parse({ budgets: { maxSteps: 2 } }).budgets;
    await seedSuspendedBudgetChild(store, budgets, 1_000, 1, 0);
    const complete = vi.fn(() =>
      Promise.resolve(
        completion([
          {
            type: "tool_call",
            callId: Id.parse("77777777777777777777777777"),
            toolId: Code.parse("test.make"),
            args: {},
          },
        ]),
      ),
    );
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}), pii: PiiConfigSchema.parse({ enabled: false }) },
      {
        store,
        transientVault: true,
        clock: new FakeClock(20),
        ids: new SequentialIdGenerator(),
        model: { complete },
        tool: runtimePiiTool([]),
        scopeRegistry: new RunScopeRegistry(),
        policy: allowAllPolicy,
      },
    );
    try {
      const resumed = await runtime.resume(childRunId);

      expect(complete).toHaveBeenCalledTimes(1);
      expect(resumed.status).toBe("failed");
      expect(resumed.state.steps).toBe(2);
      expect(resumed.events).toContainEqual(
        expect.objectContaining({ type: "budget_exceeded", budget: "steps" }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("restores a durable child scope before resumed tool execution", async () => {
    const store = new InMemoryEventStore();
    const scopes = new RunScopeRegistry();
    const vault = new InMemoryVault();
    const token = await vault.put(rootRunId, Code.parse("email"), email);
    const resolvedValues: string[] = [];
    const recorderEvents = [
      {
        runId: childRunId,
        ts: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: Id.parse("66666666666666666666666666"),
        type: "run_created" as const,
        v: 1,
        configHash: hash,
        policyVersion: Code.parse("test"),
        parentRunId: rootRunId,
        parentCallId: childCallId,
        scopeId: rootRunId,
        depth: 1,
      },
      {
        runId: childRunId,
        ts: 2,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: Id.parse("66666666666666666666666666"),
        type: "run_input" as const,
        v: 1,
        input: { goal: "resume child", inputs: { token } },
        inputKind: "initial" as const,
      },
      {
        runId: childRunId,
        ts: 3,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: Id.parse("66666666666666666666666666"),
        type: "run_status_changed" as const,
        v: 1,
        from: "pending" as const,
        to: "running" as const,
        reason: Code.parse("start"),
      },
    ];
    await store.append(childRunId, recorderEvents, 0);
    const model: ModelPort = {
      complete: (request) =>
        Promise.resolve(
          request.messages.some((message) =>
            message.parts.some((part) => part.type === "tool_result"),
          )
            ? completion([{ type: "text", text: "resumed answer" }])
            : completion([
                {
                  type: "tool_call",
                  callId: resolveCallId,
                  toolId: Code.parse("test.resolve"),
                  args: { token },
                },
              ]),
        ),
    };
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({}), pii: PiiConfigSchema.parse({ enabled: false }) },
      {
        store,
        transientVault: true,
        clock: new FakeClock(4),
        ids: new SequentialIdGenerator(),
        model,
        tool: piiTool(scopes, vault, resolvedValues),
        scopeRegistry: scopes,
        policy: allowAllPolicy,
      },
    );
    try {
      const resumed = await runtime.resume(childRunId);

      expect(resumed.status).toBe("completed");
      expect(scopes.scopeOf(childRunId)).toBe(rootRunId);
      expect(resolvedValues).toEqual([email]);
    } finally {
      await runtime.close();
    }
  });

  it("resolves a persisted child-run token through runtime.vault after reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "harness-runtime-child-vault-"));
    const secretResolver = {
      resolve: () => Promise.resolve({ reveal: () => Buffer.alloc(32, 19).toString("base64") }),
    };
    const config: RuntimeConfig = {
      run: RunConfigSchema.parse({}),
      keys: KeysConfigSchema.parse({
        currentKeyId: "runtime-test",
        keys: [{ id: "runtime-test", secret: "env:RUNTIME_TEST_KEY" }],
      }),
      pii: PiiConfigSchema.parse({
        detokenize: [{ toolId: "test.resolve", args: ["/token"] }],
      }),
      models: ModelsConfigSchema.parse({
        routing: {
          default: [{ provider: "local", model: "parent" }],
          roles: { worker: [{ provider: "local", model: "worker" }] },
        },
      }),
      roles: [
        {
          id: "worker",
          route: "worker",
          systemPrompt: "Work carefully.",
          tools: ["test.resolve"],
          contextStrategy: "naive",
          maxDepth: 2,
          maxChildren: 2,
        },
      ],
    };
    const resolvedValues: string[] = [];
    const runtime = await createRuntime(config, {
      dataDir: directory,
      clock: new FakeClock(4),
      ids: new SequentialIdGenerator(),
      model: new SpawnModel(),
      tool: runtimePiiTool(resolvedValues),
      policy: allowAllPolicy,
      secretResolver,
    });
    let reopened: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let runtimeClosed = false;
    try {
      const parent = await runtime.run("start");
      const parentId = parent.events[0]?.runId;
      const spawned = parent.events.find((event) => event.type === "subagent_spawned");
      if (parentId === undefined || spawned?.type !== "subagent_spawned") {
        throw new Error("Expected the parent run to spawn a child.");
      }
      const childCreated = await eventsFor(runtime.store, spawned.childRunId);
      expect(childCreated[0]).toMatchObject({
        type: "run_created",
        parentRunId: parentId,
        scopeId: parentId,
      });
      expect(resolvedValues).toEqual([email]);
      await runtime.close();
      runtimeClosed = true;

      reopened = await createRuntime(config, {
        dataDir: directory,
        model: new SpawnModel(),
        secretResolver,
      });
      await expect(
        reopened.vault.resolve(spawned.childRunId, Token.parse("<EMAIL_1>"), {
          boundary: "ui",
        }),
      ).resolves.toBe(email);
    } finally {
      if (reopened !== undefined) {
        await reopened.close();
      } else if (!runtimeClosed) {
        await runtime.close();
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});
