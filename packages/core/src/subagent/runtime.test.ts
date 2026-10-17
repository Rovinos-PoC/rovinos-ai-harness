// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  FakeClock,
  Id,
  ModelsConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
} from "@harness/schemas";
import type { Event, Id as IdType } from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { HeuristicTokenCounter } from "@harness/context";
import { AuditingVaultResolver, InMemoryVault } from "@harness/vault";
import { ensureTracingFallback } from "@harness/telemetry";
import { describe, expect, it } from "vitest";
import type {
  ModelCompletion,
  ModelPort,
  ModelRequest,
  PolicyPort,
  RunContext,
  ToolPort,
} from "../ports.js";
import { RUN_SPAN, TOOL_CALL_SPAN } from "../spans.js";
import { RunRecorder } from "../recorder.js";
import { contextForRole, resolveRuntimeRoles, createSubagentTool } from "./runtime.js";
import { RunScopeRegistry } from "./scope.js";
import { RoleRegistry, type ResolvedRole } from "../roles.js";
import { z } from "zod";
import { toolRunContext } from "../steps/prepare-tool.js";

const parentRunId = Id.parse("99999999999999999999999999");
const parentCallId = Id.parse("11111111111111111111111111");
const configHash = "a".repeat(64);

function ensureTracing(): void {
  ensureTracingFallback(
    RUN_SPAN.start({
      "harness.run.id": parentRunId,
      "harness.segment.id": Id.parse("77777777777777777777777777"),
    }),
  );
}

function completion(
  parts: ModelCompletion["parts"] = [{ type: "text", text: "child answer" }],
  usage: ModelCompletion["usage"] = { inputTokens: 1, outputTokens: 1 },
  rungUsed?: ModelCompletion["rungUsed"],
  enforcement?: ModelCompletion["enforcement"],
): ModelCompletion {
  return {
    parts,
    usage,
    finishReason: "stop",
    provider: "test",
    model: "worker-model",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
    ...(rungUsed === undefined ? {} : { rungUsed }),
    ...(enforcement === undefined ? {} : { enforcement }),
  };
}

async function readEvents(store: InMemoryEventStore, runId: IdType): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

describe("production subagent runtime", () => {
  it("includes a role system prompt in the context build metadata", async () => {
    const role: ResolvedRole = {
      id: Code.parse("worker"),
      systemPrompt: "Follow the task.",
      tools: [],
      maxDepth: 1,
      maxChildren: 1,
    };
    const context = contextForRole(role);
    const built = await context.build([
      {
        runId: parentRunId,
        seq: 0,
        ts: 0,
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId: parentRunId,
        type: "run_input",
        input: "inspect this",
        inputKind: "initial",
      },
    ]);

    expect(built.messages[0]).toEqual({
      role: "system",
      parts: [{ type: "text", text: "Follow the task." }],
    });
    expect(built.metadata.messageCount).toBe(built.messages.length);
    expect(built.metadata.messageCount).toBe(2);
    const counter = new HeuristicTokenCounter();
    const modelRef = { provider: "default", model: "default" };
    expect(built.metadata.estimatedTokens).toBe(counter.count(built.messages, modelRef));
    expect(built.metadata.estimatedTokens).toBeGreaterThan(
      counter.count(built.messages.slice(1), modelRef),
    );
  });

  it("routes the child through its role and persists isolated run metadata", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    const clock = new FakeClock(10);
    const ids = new SequentialIdGenerator();
    const scopes = new RunScopeRegistry();
    const modelRequests: ModelRequest[] = [];
    const model: ModelPort = {
      complete: (request) => {
        modelRequests.push(request);
        return Promise.resolve(completion());
      },
    };
    const parentTools: ToolPort = {
      describe: (toolId) =>
        toolId === "test.read" ? { idempotent: true, timeoutMs: 1_000 } : undefined,
      getToolSpecs: () => [{ toolId: "test.read", description: "Read a fixture", inputSchema: {} }],
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
    };
    const config = {
      run: RunConfigSchema.parse({}),
      models: ModelsConfigSchema.parse({
        routing: {
          default: [{ provider: "local", model: "parent" }],
          roles: { worker_route: [{ provider: "local", model: "worker-model" }] },
        },
      }),
      roles: [
        {
          id: "worker",
          route: "worker_route",
          systemPrompt: "Follow the task.",
          contextStrategy: "naive",
          tools: ["test.read"],
          maxDepth: 2,
          maxChildren: 2,
        },
      ],
    };
    const roles = await resolveRuntimeRoles(config, process.cwd(), parentTools, () => undefined);
    const policy: PolicyPort = {
      version: Code.parse("test.policy"),
      decide: () => ({
        decision: "allow",
        ruleId: "test_allow",
        reason: "test_allowed",
        editable: [],
      }),
    };
    const childTool = createSubagentTool({
      config,
      clock,
      ids,
      store,
      model,
      parentTool: parentTools,
      policy,
      policyVersion: policy.version,
      roles,
      scopes,
    });
    const parentRecorder = new RunRecorder(
      store,
      parentRunId,
      Id.parse("88888888888888888888888888"),
      0,
      clock,
    );
    await parentRecorder.withStepSpan(RUN_SPAN, {}, async () => {
      const events = await parentRecorder.recordBatch([
        {
          type: "run_created",
          v: 1,
          configHash,
          policyVersion: "test",
          scopeId: parentRunId,
        },
        {
          type: "run_status_changed",
          v: 1,
          from: "pending",
          to: "running",
          reason: "start",
        },
      ]);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected parent seed events.");
      }
      return last;
    });

    let spawnResult: Awaited<ReturnType<ToolPort["execute"]>> | undefined;
    await parentRecorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      const context: RunContext = {
        runId: parentRunId,
        signal: new AbortController().signal,
        toolRegistry: childTool,
        depth: 0,
        recordSubagentSpawned: async ({ childRunId, role, parentCallId: callId }) => {
          await parentRecorder.record({
            type: "subagent_spawned",
            v: 1,
            childRunId,
            role,
            parentCallId: callId,
          });
        },
        recordSubagentCompleted: async ({
          childRunId,
          outcome,
          inputTokens,
          outputTokens,
          steps,
          costMicros,
        }) => {
          await parentRecorder.record({
            type: "subagent_completed",
            v: 1,
            childRunId,
            outcome,
            inputTokens,
            outputTokens,
            ...(steps === undefined ? {} : { steps }),
            ...(costMicros === undefined ? {} : { costMicros }),
          });
        },
      };
      spawnResult = await childTool.execute(
        {
          callId: parentCallId,
          toolId: Code.parse("agent.spawn"),
          args: { role: "worker", goal: "inspect this" },
        },
        context,
      );
      const events = await readEvents(store, parentRunId);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected a durable spawn announcement.");
      }
      return last;
    });

    const childId = (await readEvents(store, parentRunId)).find(
      (event) => event.type === "subagent_spawned",
    );
    if (childId?.type !== "subagent_spawned") {
      throw new Error("Expected a child run id.");
    }
    const childEvents = await readEvents(store, childId.childRunId);

    expect(spawnResult).toMatchObject({
      outcome: "ok",
      result: {
        childRunId: childId.childRunId,
        status: "completed",
        value: { text: "child answer" },
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    });
    expect(childEvents[0]).toMatchObject({
      type: "run_created",
      parentRunId,
      parentCallId,
      scopeId: parentRunId,
      depth: 1,
    });
    expect(childEvents.find((event) => event.type === "run_input")).toMatchObject({
      input: { goal: "inspect this" },
    });
    expect(modelRequests[0]?.role).toBe("worker_route");
    expect(modelRequests[0]?.messages[0]).toEqual({
      role: "system",
      parts: [{ type: "text", text: "Follow the task." }],
    });
    expect(modelRequests[0]?.tools?.map(({ toolId }) => toolId)).toEqual(["test.read"]);
    expect(
      (await readEvents(store, parentRunId)).find((event) => event.type === "subagent_completed"),
    ).toMatchObject({
      outcome: "completed",
      inputTokens: 1,
      outputTokens: 1,
    });
  });

  it("validates tokenized structured output and records terminal usage without raw values", async () => {
    ensureTracing();
    const store = new InMemoryEventStore();
    const clock = new FakeClock(10);
    const ids = new SequentialIdGenerator();
    const scopes = new RunScopeRegistry();
    const vault = new InMemoryVault();
    const token = await vault.put(parentRunId, Code.parse("email"), "alice@example.test");
    const audits: { readonly boundary: string }[] = [];
    const resolver = new AuditingVaultResolver(
      vault,
      (audit) => {
        audits.push(audit);
      },
      scopes.scopeOf,
    );
    const modelRequests: { readonly context: RunContext }[] = [];
    let structuredCalls = 0;
    const resultSchema = z.object({ email: z.email() }).strict();
    const model: ModelPort = {
      complete: async (_request, context) => {
        modelRequests.push({ context });
        if (context.outputSchema === undefined) {
          return completion([{ type: "text", text: "final answer candidate" }], {
            inputTokens: 1,
            outputTokens: 2,
            costMicros: 3,
          });
        }
        structuredCalls += 1;
        if (structuredCalls === 2) {
          throw Object.assign(new Error("invalid result"), {
            code: "model_output_invalid",
            usage: { inputTokens: 13, outputTokens: 17, costMicros: 19 },
            latencyMs: 2,
            repairAttempts: 1,
          });
        }
        if (context.valueTransform === undefined) {
          throw new Error("Expected token-aware output validation.");
        }
        await expect(
          context.valueTransform(context.outputSchema, { email: token }),
        ).resolves.toEqual({
          ok: true,
          tokenized: { email: token },
        });
        return completion(
          [{ type: "text", text: `Here is the result: {"email":"${token}"}` }],
          { inputTokens: 5, outputTokens: 7, costMicros: 11 },
          "prompt",
          { valid: true, value: { email: token }, rungUsed: "prompt" },
        );
      },
    };
    const tools: ToolPort = {
      describe: () => undefined,
      execute: () => Promise.resolve({ outcome: "error", errorCode: "unknown_tool", result: null }),
    };
    const models = ModelsConfigSchema.parse({
      routing: {
        default: [{ provider: "local", model: "parent" }],
        roles: { worker: [{ provider: "local", model: "worker" }] },
      },
    });
    const config = { run: RunConfigSchema.parse({}), models };
    const roles = await RoleRegistry.create({
      roles: [
        {
          id: "worker",
          tools: [],
          resultSchema: "./schema.js#Result",
          maxDepth: 2,
          maxChildren: 2,
        },
      ],
      models,
      registeredTools: ["agent.spawn"],
      contextStrategies: new Set(["naive"]),
      configDirectory: process.cwd(),
      loadSchema: () => Promise.resolve({ Result: resultSchema }),
    });
    const policy: PolicyPort = {
      version: Code.parse("test.policy"),
      decide: () => ({
        decision: "allow",
        ruleId: "test_allow",
        reason: "test_allowed",
        editable: [],
      }),
    };
    const childTool = createSubagentTool({
      config,
      clock,
      ids,
      store,
      model,
      parentTool: tools,
      policy,
      policyVersion: policy.version,
      roles,
      scopes,
      resolver,
    });
    const parentRecorder = new RunRecorder(
      store,
      parentRunId,
      Id.parse("88888888888888888888888888"),
      0,
      clock,
    );
    await parentRecorder.withStepSpan(RUN_SPAN, {}, async () => {
      const events = await parentRecorder.recordBatch([
        {
          type: "run_created",
          v: 1,
          configHash,
          policyVersion: "test",
          scopeId: parentRunId,
        },
        {
          type: "run_status_changed",
          v: 1,
          from: "pending",
          to: "running",
          reason: "start",
        },
      ]);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected parent seed events.");
      }
      return last;
    });
    const context = toolRunContext(
      {
        runId: parentRunId,
        signal: new AbortController().signal,
        toolRegistry: childTool,
        depth: 0,
      },
      parentRecorder,
      [],
    );
    let spawnResult: Awaited<ReturnType<ToolPort["execute"]>> | undefined;
    await parentRecorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      await parentRecorder.record({
        type: "tool_intent",
        v: 1,
        callId: parentCallId,
        toolId: "agent.spawn",
        idempotent: false,
        policyDecision: "allow",
        argsHash: configHash,
        args: {},
      });
      const result = await childTool.execute(
        {
          callId: parentCallId,
          toolId: Code.parse("agent.spawn"),
          args: { role: "worker", goal: "return the email" },
        },
        context,
      );
      spawnResult = result;
      return parentRecorder.record({
        type: "tool_result",
        v: 1,
        callId: parentCallId,
        toolId: "agent.spawn",
        outcome: result.outcome,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        latencyMs: 0,
        result: result.result,
      });
    });

    expect(spawnResult).toMatchObject({
      outcome: "ok",
      result: {
        status: "completed",
        value: { email: token },
        usage: { inputTokens: 6, outputTokens: 9, costMicros: 14 },
      },
    });
    expect(modelRequests).toHaveLength(2);
    expect(modelRequests[0]?.context.outputSchema).toBeUndefined();
    expect(modelRequests[1]?.context.outputSchema).toBe(resultSchema);
    expect(modelRequests[1]?.context.valueTransform).toBeTypeOf("function");
    expect(audits).toHaveLength(1);
    expect(audits[0]?.boundary).toBe("tool_input");
    const parentEvents = await readEvents(store, parentRunId);
    expect(parentEvents.find((event) => event.type === "subagent_completed")).toMatchObject({
      outcome: "completed",
      inputTokens: 6,
      outputTokens: 9,
      costMicros: 14,
    });
    expect(JSON.stringify(parentEvents)).not.toContain("alice@example.test");
    expect(JSON.stringify(spawnResult)).not.toContain("alice@example.test");

    const invalidCallId = Id.parse("22222222222222222222222222");
    let invalidResult: Awaited<ReturnType<ToolPort["execute"]>> | undefined;
    await parentRecorder.withStepSpan(TOOL_CALL_SPAN, {}, async () => {
      await parentRecorder.record({
        type: "tool_intent",
        v: 1,
        callId: invalidCallId,
        toolId: "agent.spawn",
        idempotent: false,
        policyDecision: "allow",
        argsHash: configHash,
        args: {},
      });
      const result = await childTool.execute(
        {
          callId: invalidCallId,
          toolId: Code.parse("agent.spawn"),
          args: { role: "worker", goal: "return an invalid result" },
        },
        context,
      );
      invalidResult = result;
      return parentRecorder.record({
        type: "tool_result",
        v: 1,
        callId: invalidCallId,
        toolId: "agent.spawn",
        outcome: result.outcome,
        ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        latencyMs: 0,
        result: result.result,
      });
    });

    expect(invalidResult?.outcome).toBe("error");
    if (invalidResult?.outcome !== "error") {
      throw new Error("Expected the invalid child result to be an error.");
    }
    expect(invalidResult.errorCode).toBe("subagent_result_invalid");
    expect(invalidResult.result).toMatchObject({ status: "failed" });
    expect(
      typeof invalidResult.result === "object" &&
        invalidResult.result !== null &&
        "childRunId" in invalidResult.result &&
        Id.safeParse(invalidResult.result.childRunId).success,
    ).toBe(true);
    const finalParentEvents = await readEvents(store, parentRunId);
    const failedSpawn = finalParentEvents.find(
      (event) => event.type === "subagent_spawned" && event.parentCallId === invalidCallId,
    );
    if (failedSpawn?.type !== "subagent_spawned") {
      throw new Error("Expected the failed child spawn event.");
    }
    expect(
      (await readEvents(store, failedSpawn.childRunId)).find(
        (event) => event.type === "run_status_changed" && event.to === "failed",
      ),
    ).toMatchObject({ reason: "result_invalid" });
    expect(
      finalParentEvents.findLast((event) => event.type === "subagent_completed"),
    ).toMatchObject({
      outcome: "failed",
      inputTokens: 14,
      outputTokens: 19,
      costMicros: 22,
    });
    expect(JSON.stringify(finalParentEvents)).not.toContain("alice@example.test");
  });
});
