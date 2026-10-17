// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  FakeClock,
  Id,
  ModelsConfigSchema,
  RunConfigSchema,
  type JsonValue,
  type ToolSpec,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { describe, expect, it, vi } from "vitest";
import { LeaseLostError } from "../recorder.js";
import { RoleRegistry } from "../roles.js";
import type { ModelToolCall, RunContext, ToolPort } from "../ports.js";
import { AgentSpawnInputSchema, AgentSpawnTool } from "./spawn-tool.js";
import { SubagentSupervisor } from "./supervisor.js";
import type { SubagentRunRequest, SubagentRunner } from "./supervisor.js";
import { RunScopeRegistry } from "./scope.js";

const parentRunId = Id.parse("00000000000000000000000000");
const parentCallId = Id.parse("11111111111111111111111111");
const childRunId = Id.parse("22222222222222222222222222");

async function roles(maxChildren = 2): Promise<RoleRegistry> {
  return RoleRegistry.create({
    roles: [{ id: "worker", tools: ["fs.read"], maxDepth: 2, maxChildren }],
    models: ModelsConfigSchema.parse({
      routing: {
        default: [{ provider: "local", model: "model" }],
        roles: { worker: [{ provider: "local", model: "model" }] },
      },
    }),
    registeredTools: ["agent.spawn", "fs.read", "fs.write"],
    contextStrategies: new Set(["naive"]),
    configDirectory: process.cwd(),
  });
}

function call(toolId: string, args: JsonValue): ModelToolCall {
  return { callId: parentCallId, toolId: Code.parse(toolId), args };
}

function innerTools(): ToolPort {
  return {
    describe: (toolId) =>
      toolId === "fs.read" || toolId === "fs.write"
        ? { idempotent: true, timeoutMs: 1_000 }
        : undefined,
    getToolSpecs: () =>
      [
        { toolId: "agent.spawn", description: "duplicate", inputSchema: {} },
        { toolId: "fs.read", description: "read", inputSchema: {} },
        { toolId: "fs.write", description: "write", inputSchema: {} },
      ] satisfies ToolSpec[],
    prepare: vi.fn((toolCall) => Promise.resolve(toolCall)),
    execute: vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: { ok: true } })),
  };
}

function runContext(tools: ToolPort): RunContext {
  return {
    runId: parentRunId,
    signal: new AbortController().signal,
    toolRegistry: tools,
    depth: 0,
    recordSubagentSpawned: vi.fn(() => Promise.resolve()),
    recordSubagentCompleted: vi.fn(() => Promise.resolve()),
  };
}

async function createSpawnTool(
  inner: ToolPort,
  registry: RoleRegistry,
  onChild: (request: SubagentRunRequest) => void = () => undefined,
  runChild?: SubagentRunner,
  options: {
    readonly runConfig?: ReturnType<typeof RunConfigSchema.parse>;
    readonly existingChild?: Id;
  } = {},
): Promise<AgentSpawnTool> {
  const store = new InMemoryEventStore();
  await store.append(
    parentRunId,
    [
      {
        runId: parentRunId,
        ts: 1,
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: parentRunId,
        type: "run_created",
        configHash: "c".repeat(64),
        policyVersion: "test",
        depth: 0,
      },
    ],
    0,
  );
  if (options.existingChild !== undefined) {
    await store.append(
      parentRunId,
      [
        {
          runId: parentRunId,
          ts: 2,
          traceId: "a".repeat(32),
          spanId: "b".repeat(16),
          segmentId: parentRunId,
          type: "subagent_spawned",
          v: 1,
          childRunId: options.existingChild,
          role: "worker",
          parentCallId: Id.parse("33333333333333333333333333"),
        },
      ],
      1,
    );
  }
  const supervisor = new SubagentSupervisor({
    store,
    ids: { next: () => childRunId },
    clock: new FakeClock(1),
    runConfig: options.runConfig ?? RunConfigSchema.parse({}),
    scopes: new RunScopeRegistry(),
    parentTools: inner,
    parentSpanContext: () => ({
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      traceFlags: 1,
    }),
    runChild:
      runChild ??
      ((request) => {
        onChild(request);
        return Promise.resolve({
          childRunId: request.runId,
          status: "completed",
          value: { input: request.input },
          usage: { inputTokens: 0, outputTokens: 0 },
        });
      }),
  });
  return new AgentSpawnTool(inner, registry, supervisor);
}

describe("agent.spawn tool", () => {
  it("validates the strict role, goal, and optional JSON input schema", () => {
    expect(
      AgentSpawnInputSchema.safeParse({
        role: "worker",
        goal: "A".repeat(8_000),
        inputs: { token: "<EMAIL_1>" },
      }).success,
    ).toBe(true);
    expect(
      AgentSpawnInputSchema.safeParse({ role: "worker", goal: "A".repeat(8_001) }).success,
    ).toBe(false);
    expect(
      AgentSpawnInputSchema.safeParse({ role: "worker", goal: "goal", extra: true }).success,
    ).toBe(false);
  });

  it("advertises a non-idempotent built-in and preserves other tool behavior", async () => {
    const inner = innerTools();
    const prepare = vi.spyOn(inner, "prepare");
    const tool = await createSpawnTool(inner, await roles());
    const spawnCall = call("agent.spawn", { role: "worker", goal: "goal" });

    expect(tool.describe("agent.spawn")).toMatchObject({
      idempotent: false,
      timeoutMs: 300_000,
      longRunning: true,
    });
    expect(tool.describe("agent.spawn")?.inputSchema).toEqual(
      tool.getToolSpecs().find(({ toolId }) => toolId === "agent.spawn")?.inputSchema,
    );
    expect(tool.describe("fs.read")).toEqual({ idempotent: true, timeoutMs: 1_000 });
    expect(tool.getToolSpecs().map(({ toolId }) => toolId)).toEqual([
      "fs.read",
      "fs.write",
      "agent.spawn",
    ]);
    const context = runContext(inner);
    await expect(tool.prepare(spawnCall, context)).resolves.toBe(spawnCall);
    expect(prepare).toHaveBeenCalledWith(spawnCall, context);
    await expect(tool.prepare(call("fs.read", {}), runContext(inner))).resolves.toEqual(
      call("fs.read", {}),
    );
    await expect(tool.execute(call("fs.read", {}), runContext(inner))).resolves.toEqual({
      outcome: "ok",
      result: { ok: true },
    });
  });

  it("returns a schema failure without starting a child", async () => {
    const runChild = vi.fn();
    const tool = await createSpawnTool(innerTools(), await roles(), runChild);

    await expect(
      tool.execute(call("agent.spawn", { role: "worker", goal: 3 }), runContext(innerTools())),
    ).resolves.toEqual({ outcome: "error", errorCode: "agent_spawn_invalid", result: null });
    expect(runChild).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "global depth",
      runConfig: RunConfigSchema.parse({ subagents: { maxDepth: 0 } }),
      expectedCode: "subagent_limit",
    },
    {
      name: "per-run child count",
      runConfig: RunConfigSchema.parse({ subagents: { maxChildrenPerRun: 1 } }),
      existingChild: Id.parse("77777777777777777777777777"),
      expectedCode: "subagent_limit",
    },
    {
      name: "concurrent child count",
      runConfig: RunConfigSchema.parse({ subagents: { maxConcurrentChildren: 1 } }),
      existingChild: Id.parse("77777777777777777777777777"),
      expectedCode: "subagent_limit",
    },
    {
      name: "role depth",
      runConfig: RunConfigSchema.parse({}),
      depth: 2,
      expectedCode: "subagent_depth_limit",
    },
    {
      name: "role child count",
      runConfig: RunConfigSchema.parse({}),
      existingChild: Id.parse("77777777777777777777777777"),
      roleMaxChildren: 1,
      expectedCode: "subagent_children_limit",
    },
  ])(
    "returns $expectedCode for the $name limit",
    async ({ runConfig, existingChild, depth, roleMaxChildren, expectedCode }) => {
      const runChild = vi.fn();
      const tool = await createSpawnTool(
        innerTools(),
        await roles(roleMaxChildren),
        () => undefined,
        runChild,
        {
          runConfig,
          ...(existingChild === undefined ? {} : { existingChild }),
        },
      );

      await expect(
        tool.execute(call("agent.spawn", { role: "worker", goal: "must not start" }), {
          ...runContext(innerTools()),
          ...(depth === undefined ? {} : { depth }),
        }),
      ).resolves.toEqual({ outcome: "error", errorCode: expectedCode, result: null });
      expect(runChild).not.toHaveBeenCalled();
    },
  );

  it("propagates lease-loss errors instead of converting them to tool results", async () => {
    const inner = innerTools();
    const leaseLost = new LeaseLostError(2);
    const tool = await createSpawnTool(inner, await roles(), undefined, () =>
      Promise.reject(leaseLost),
    );

    await expect(
      tool.execute(call("agent.spawn", { role: "worker", goal: "goal" }), runContext(inner)),
    ).rejects.toBe(leaseLost);
  });

  it("awaits a child with role-filtered tools and returns its JSON result", async () => {
    const inner = innerTools();
    const seen: SubagentRunRequest[] = [];
    const tool = await createSpawnTool(inner, await roles(), (request) => seen.push(request));
    const context = runContext(tool);

    await expect(
      tool.execute(
        call("agent.spawn", {
          role: "worker",
          goal: "tokenized goal",
          inputs: { ref: "<EMAIL_1>" },
        }),
        context,
      ),
    ).resolves.toEqual({
      outcome: "ok",
      result: {
        childRunId,
        status: "completed",
        value: { input: { goal: "tokenized goal", inputs: { ref: "<EMAIL_1>" } } },
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.role.id).toBe("worker");
    expect(seen[0]?.tools.describe("fs.read")).toBeDefined();
    expect(seen[0]?.tools.describe("fs.write")).toBeUndefined();
  });

  it("does not handle calls for another tool ID", async () => {
    const inner = innerTools();
    const tool = await createSpawnTool(inner, await roles());

    await expect(tool.execute(call("fs.read", {}), runContext(inner))).resolves.toMatchObject({
      result: { ok: true },
    });
  });

  it("returns a typed error for cancelled children with their identity and status", async () => {
    const inner = innerTools();
    const tool = await createSpawnTool(inner, await roles(), undefined, (request) =>
      Promise.resolve({
        childRunId: request.runId,
        status: "cancelled",
        errorCode: "run_cancelled",
        usage: { inputTokens: 0, outputTokens: 0 },
      }),
    );

    await expect(
      tool.execute(call("agent.spawn", { role: "worker", goal: "cancel" }), runContext(inner)),
    ).resolves.toEqual({
      outcome: "error",
      errorCode: "run_cancelled",
      result: { childRunId, status: "cancelled" },
    });
  });

  it("falls back to a typed code for an unusual child failure reason", async () => {
    const inner = innerTools();
    const tool = await createSpawnTool(inner, await roles(), undefined, (request) =>
      Promise.resolve({
        childRunId: request.runId,
        status: "failed",
        errorCode: "failure reason with spaces",
        usage: { inputTokens: 1, outputTokens: 2 },
      }),
    );

    await expect(
      tool.execute(call("agent.spawn", { role: "worker", goal: "failed" }), runContext(inner)),
    ).resolves.toEqual({
      outcome: "error",
      errorCode: "subagent_failed",
      result: { childRunId, status: "failed" },
    });
  });
});
