// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Code,
  Id,
  KeysConfigSchema,
  ModelsConfigSchema,
  PiiConfigSchema,
  RunConfigSchema,
  type ModelRequest,
  type JsonValue,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { ProviderError, type ProviderAdapter } from "@harness/models";
import { AuditingVaultResolver, InMemoryVault, Token } from "@harness/vault";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailDetector, PiiMessageSanitizer, PiiToolPort, Tokenizer } from "@harness/pii";
import * as telemetry from "@harness/telemetry";
import { AdapterRegistry, ModelGateway } from "@harness/models";
import type { ModelCompletion, ModelToolCall, ToolPort } from "./ports.js";
import { createRuntime } from "./runtime.js";
import { createRuntimeKeys } from "./runtime-keys.js";
import { createRuntimeVault } from "./runtime-vault.js";
import type { RuntimeConfig } from "./runtime-config.js";
import { FakeModelPort } from "./testing/fake-model.js";
import { allowAllPolicy } from "./testing/allow-policy.js";
import { createRuntimePii } from "./runtime-pii.js";
import { RunScopeRegistry } from "./subagent/scope.js";
import { z } from "zod";

const email = "runtime-canary@example.test";
const toolId = Code.parse("test.echo");
const keys = KeysConfigSchema.parse({
  currentKeyId: "runtime-test",
  keys: [{ id: "runtime-test", secret: "env:RUNTIME_TEST_KEY" }],
});
const secretResolver = {
  resolve: () => Promise.resolve({ reveal: () => Buffer.alloc(32, 19).toString("base64") }),
};
const runConfig = RunConfigSchema.parse({});

let directories: string[] = [];

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "test",
    model: "test",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function scriptedModel(args: JsonValue): FakeModelPort {
  const call: ModelToolCall = {
    callId: Id.parse("11111111111111111111111111"),
    toolId,
    args,
  };
  return new FakeModelPort([
    completion([{ type: "tool_call", ...call }]),
    completion([{ type: "text", text: "completed" }]),
  ]);
}

function makeTool(received: JsonValue[], output: JsonValue): ToolPort {
  return {
    describe: (id) => (id === toolId ? { idempotent: true, timeoutMs: 1_000 } : undefined),
    execute: (call) => {
      received.push(call.args);
      return Promise.resolve({ outcome: "ok", result: output });
    },
  };
}

async function dataDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "harness-runtime-pii-"));
  directories.push(directory);
  return directory;
}

function config(pii = PiiConfigSchema.parse({})): RuntimeConfig {
  return { run: runConfig, keys, pii };
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    directories.map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories = [];
});

describe("createRuntime PII composition", () => {
  it("preserves overlapping runtime detections until policy evaluation", async () => {
    const input = `prefix ${email} suffix`;
    const pii = PiiConfigSchema.parse({
      custom: [{ name: "org_id", pattern: "prefix runtime-canary@example\\.test suffix" }],
      rules: [
        {
          entities: ["custom_org_id"],
          boundaries: ["tool_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    });
    const runId = Id.parse("C".repeat(26));
    const scopes = new RunScopeRegistry();
    const { tokenizer } = createRuntimePii({
      config: pii,
      vault: new InMemoryVault(),
      scopes,
      scopeOf: scopes.scopeOf,
      policyVersion: Code.parse("test.policy"),
      clock: { now: () => 0 },
    });

    const result = await tokenizer.tokenizeText(runId, input, {
      boundary: "tool_input",
      destination: "local",
    });

    expect(result.text).toBe("<EMAIL_1>");
    expect(result.text).not.toContain(email);
  });

  it("re-sanitizes local-allow messages before hosted fallback and records summaries", async () => {
    const localRequests: ModelRequest[] = [];
    const hostedRequests: ModelRequest[] = [];
    const adapters: ProviderAdapter[] = [
      {
        provider: "local",
        kind: "openai",
        complete: (request) => {
          localRequests.push(request);
          return Promise.reject(new ProviderError("provider_unavailable"));
        },
      },
      {
        provider: "hosted",
        kind: "openai",
        complete: (request) => {
          hostedRequests.push(request);
          return Promise.resolve({
            parts: [{ type: "text", text: "completed" }],
            usage: { inputTokens: 1, outputTokens: 1 },
            finishReason: "stop",
            latencyMs: 0,
          });
        },
      },
    ];
    const models = ModelsConfigSchema.parse({
      retry: { maxAttempts: 1 },
      providers: [
        {
          id: "local",
          kind: "openai_compatible",
          baseUrl: "http://127.0.0.1:1234",
          trust: "local",
        },
        { id: "hosted", kind: "openai", trust: "hosted" },
      ],
      routing: {
        default: [
          { provider: "local", model: "local-model" },
          { provider: "hosted", model: "hosted-model" },
        ],
      },
    });
    const pii = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    });
    const runtime = await createRuntime(
      { run: runConfig, keys, pii, models },
      {
        dataDir: await dataDirectory(),
        store: new InMemoryEventStore(),
        transientVault: true,
        providerAdapters: adapters,
        policy: allowAllPolicy,
        secretResolver,
      },
    );

    try {
      const result = await runtime.run(email);

      expect(result.status).toBe("completed");
      expect(JSON.stringify(localRequests[0]?.messages)).toContain(email);
      expect(JSON.stringify(hostedRequests[0]?.messages)).not.toContain(email);
      expect(JSON.stringify(hostedRequests[0]?.messages)).toContain("<EMAIL_1>");
      const runId = result.events[0]?.runId;
      expect(runId).toBeDefined();
      if (runId === undefined) {
        throw new Error("Expected the run to have an ID.");
      }
      const persistedEvents: unknown[] = [];
      for await (const event of runtime.store.read(runId)) {
        persistedEvents.push(event);
      }
      expect(JSON.stringify(persistedEvents)).not.toContain(email);
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "pii_action",
          boundary: "model_input",
          action: "allowed",
          entities: [{ type: "email", count: 1 }],
        }),
      );
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "pii_action",
          boundary: "model_input",
          action: "tokenized",
          entities: [{ type: "email", count: 1 }],
        }),
      );
    } finally {
      await runtime.close();
    }
  });

  it("sanitizes tool-call arguments appended to a structured-output repair request", async () => {
    const requests: ModelRequest[] = [];
    let attempt = 0;
    const vault = new InMemoryVault();
    const resolver = new AuditingVaultResolver(vault, () => undefined);
    const detectors = { detect: (text: string) => emailDetector.detect(text) };
    const policy = PiiConfigSchema.parse({});
    const tokenizer = new Tokenizer({ detectors, policy, vault });
    const sanitizer = new PiiMessageSanitizer({ tokenizer, detectors, policy, resolver });
    const adapter: ProviderAdapter = {
      provider: Code.parse("hosted"),
      kind: "openai",
      capabilities: { structuredOutput: "none", forcedToolChoice: true },
      complete: (request) => {
        requests.push(request);
        attempt += 1;
        return Promise.resolve({
          parts: [
            {
              type: "tool_call",
              callId: Id.parse(String(attempt).padStart(26, "0")),
              toolId: Code.parse("emit_result"),
              args: { answer: attempt === 1 ? email : 1 },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
          finishReason: "tool_calls",
          latencyMs: 0,
        });
      },
    };
    const gateway = new ModelGateway(new AdapterRegistry([adapter]), {
      ids: { next: () => Id.parse("11111111111111111111111111") },
      clock: { now: () => 0 },
      requestSanitizer: (request, target, context) =>
        sanitizer.sanitizeRequest(request, target, context.runId, { signal: context.signal }),
    });

    await gateway.complete(
      {
        requestId: Id.parse("22222222222222222222222222"),
        model: { provider: Code.parse("hosted"), model: Code.parse("test-model") },
        messages: [{ role: "user", parts: [{ type: "text", text: "Return an answer." }] }],
      },
      {
        runId: Id.parse("33333333333333333333333333"),
        signal: new AbortController().signal,
        outputSchema: z.object({ answer: z.number() }),
      },
    );

    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests[1])).not.toContain(email);
    expect(JSON.stringify(requests[1]?.messages)).toContain("<EMAIL_1>");
    expect(
      requests[1]?.messages.some((message) =>
        message.parts.some((part) => part.type === "tool_call"),
      ),
    ).toBe(true);
  });

  it("fails the run with pii_blocked before a provider can receive a blocked token", async () => {
    const complete = vi.fn<ProviderAdapter["complete"]>(() =>
      Promise.resolve({
        parts: [{ type: "text", text: "completed" }],
        usage: { inputTokens: 1, outputTokens: 1 },
        finishReason: "stop",
        latencyMs: 0,
      }),
    );
    const models = ModelsConfigSchema.parse({
      retry: { maxAttempts: 1 },
      providers: [
        { id: "hosted", kind: "openai", trust: "hosted" },
        { id: "secondary", kind: "openai", trust: "hosted" },
      ],
      routing: {
        default: [
          { provider: "hosted", model: "hosted-model" },
          { provider: "secondary", model: "secondary-model" },
        ],
        fallbackOn: ["pii_blocked"],
      },
    });
    const secondaryComplete = vi.fn<ProviderAdapter["complete"]>();
    const pii = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["hosted"],
          action: "block",
        },
      ],
    });
    const runtime = await createRuntime(
      { run: runConfig, keys, pii, models },
      {
        dataDir: await dataDirectory(),
        store: new InMemoryEventStore(),
        transientVault: true,
        providerAdapters: [
          { provider: "hosted", kind: "openai", complete },
          { provider: "secondary", kind: "openai", complete: secondaryComplete },
        ],
        policy: allowAllPolicy,
        secretResolver,
      },
    );

    try {
      const result = await runtime.run(email);

      expect(result.status).toBe("failed");
      expect(complete).not.toHaveBeenCalled();
      expect(secondaryComplete).not.toHaveBeenCalled();
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "run_status_changed",
          to: "failed",
          reason: "pii_blocked",
        }),
      );
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "pii_action",
          boundary: "model_input",
          action: "blocked",
          entities: [{ type: "email", count: 1 }],
        }),
      );
      const runId = result.events[0]?.runId;
      expect(runId).toBeDefined();
      if (runId === undefined) {
        throw new Error("Expected the run to have an ID.");
      }
      const persistedEvents: unknown[] = [];
      for await (const event of runtime.store.read(runId)) {
        persistedEvents.push(event);
      }
      expect(JSON.stringify(persistedEvents)).not.toContain(email);
    } finally {
      await runtime.close();
    }
  });

  it("detokenizes only allowlisted arguments and tokenizes tool output before recording", async () => {
    const received: JsonValue[] = [];
    const store = new InMemoryEventStore();
    const directory = await dataDirectory();
    const runtime = await createRuntime(
      config(
        PiiConfigSchema.parse({
          detokenize: [{ toolId, args: ["/allowed"] }],
          custom: [{ name: "tag", pattern: "TAG-[0-9]{4}" }],
        }),
      ),
      {
        dataDir: directory,
        store,
        tool: makeTool(received, { echo: email }),
        model: scriptedModel({ allowed: email, private: email }),
        policy: allowAllPolicy,
        secretResolver,
      },
    );

    let reopened: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let runtimeClosed = false;
    try {
      const result = await runtime.run("start");
      const runId = result.events[0]?.runId;
      expect(runId).toBeDefined();
      expect(received).toEqual([{ allowed: email, private: "<EMAIL_1>" }]);
      expect(JSON.stringify(result.events)).not.toContain(email);
      expect(JSON.stringify(result.events)).toContain("<EMAIL_1>");
      expect(
        result.events.filter(
          (event) => event.type === "pii_action" && event.action === "detokenized",
        ),
      ).toMatchObject([
        {
          type: "pii_action",
          boundary: "tool_input",
          action: "detokenized",
          toolId,
          entities: [{ type: "email", count: 1 }],
        },
      ]);
      expect("put" in runtime.vault).toBe(false);
      await runtime.close();
      runtimeClosed = true;

      reopened = await createRuntime(config(), {
        dataDir: directory,
        store: new InMemoryEventStore(),
        secretResolver,
      });
      if (runId === undefined) {
        throw new Error("Expected the run to have an ID.");
      }
      await expect(
        reopened.vault.resolve(runId, Token.parse("<EMAIL_1>"), { boundary: "ui" }),
      ).resolves.toBe(email);
    } finally {
      if (reopened !== undefined) {
        await reopened.close();
      } else if (!runtimeClosed) {
        await runtime.close();
      }
    }
  });

  it("leaves the raw tool port unwrapped when PII is disabled outside production", async () => {
    const received: JsonValue[] = [];
    const runtime = await createRuntime(config(PiiConfigSchema.parse({ enabled: false })), {
      dataDir: await dataDirectory(),
      store: new InMemoryEventStore(),
      transientVault: true,
      tool: makeTool(received, null),
      model: scriptedModel({ value: email }),
      policy: allowAllPolicy,
      secretResolver,
    });

    try {
      await runtime.run("start");
      expect(received).toEqual([{ value: email }]);
    } finally {
      await runtime.close();
    }
  });

  it("rejects disabling PII in production before opening runtime resources", async () => {
    vi.stubEnv("NODE_ENV", "production");

    await expect(
      createRuntime(config(PiiConfigSchema.parse({ enabled: false })), {
        store: new InMemoryEventStore(),
        transientVault: true,
      }),
    ).rejects.toMatchObject({ code: "pii_disabled_in_production" });
  });

  // threat: T-10
  it.each(["tool", "createTool"])("rejects a pre-wrapped port supplied by %s", async (source) => {
    const piiConfig = PiiConfigSchema.parse({});
    const vault = new InMemoryVault();
    const wrapped = new PiiToolPort(makeTool([], null), {
      tokenizer: new Tokenizer({
        detectors: { detect: () => [] },
        policy: piiConfig,
        vault,
      }),
      config: piiConfig,
      resolver: new AuditingVaultResolver(vault, () => undefined),
    });

    await expect(
      createRuntime(config(), {
        store: new InMemoryEventStore(),
        ...(source === "tool" ? { tool: wrapped } : { createTool: () => wrapped }),
        transientVault: true,
        secretResolver,
      }),
    ).rejects.toMatchObject({ code: "pii_tool_port_already_wrapped" });
  });

  it("persists an injected-store vault and emits one metadata-only resolver audit after reopen", async () => {
    const directory = await dataDirectory();
    vi.stubEnv("HARNESS_DATA_DIR", directory);
    const emitSafeEventSpy = vi
      .spyOn(telemetry, "emitSafeEventToDefaultLogger")
      .mockImplementation(() => undefined);

    const runtime = await createRuntime(config(), {
      store: new InMemoryEventStore(),
      tool: makeTool([], null),
      model: scriptedModel({ value: email }),
      policy: allowAllPolicy,
      secretResolver,
    });
    let reopened: Awaited<ReturnType<typeof createRuntime>> | undefined;
    let runtimeClosed = false;
    try {
      const result = await runtime.run(email);
      const runId = result.events[0]?.runId;
      expect(runId).toBeDefined();
      expect(existsSync(join(directory, "vault.db"))).toBe(true);
      await runtime.close();
      runtimeClosed = true;

      reopened = await createRuntime(config(), {
        store: new InMemoryEventStore(),
        secretResolver,
      });
      if (runId === undefined) {
        throw new Error("Expected the run to have an ID.");
      }
      await expect(
        reopened.vault.resolve(runId, Token.parse("<EMAIL_1>"), { boundary: "ui" }),
      ).resolves.toBe(email);
      expect(emitSafeEventSpy).toHaveBeenCalledTimes(1);
      const audit = emitSafeEventSpy.mock.calls[0]?.[0];
      expect(audit).toMatchObject({
        runId,
        kind: "pii_action",
        boundary: "ui",
        action: "detokenized",
        entities: [{ type: "email", count: 1 }],
      });
      expect(Object.keys(audit ?? {}).sort()).toEqual(
        [
          "action",
          "boundary",
          "entities",
          "kind",
          "policyVersion",
          "runId",
          "seq",
          "spanId",
          "traceId",
          "ts",
        ].sort(),
      );
      expect(JSON.stringify(audit)).not.toContain(email);
    } finally {
      emitSafeEventSpy.mockRestore();
      if (reopened !== undefined) {
        await reopened.close();
      } else if (!runtimeClosed) {
        await runtime.close();
      }
    }
  });

  it("opens vault and store read-only without modifying either database", async () => {
    const directory = await dataDirectory();
    const runtime = await createRuntime(config(), {
      dataDir: directory,
      model: new FakeModelPort([completion([{ type: "text", text: "done" }])]),
      secretResolver,
    });
    let runId: ReturnType<typeof Id.parse> | undefined;
    try {
      const result = await runtime.run(email);
      runId = result.events[0]?.runId;
    } finally {
      await runtime.close();
    }
    if (runId === undefined) {
      throw new Error("Expected the run to have an ID.");
    }
    const vaultPath = join(directory, "vault.db");
    const storePath = join(directory, "harness.db");
    const vaultBefore = await readFile(vaultPath);
    const storeBefore = await readFile(storePath);
    const readOnlyRuntime = await createRuntime(config(), {
      dataDir: directory,
      readOnlyStore: true,
      secretResolver,
    });
    try {
      await expect(
        readOnlyRuntime.vault.resolve(runId, Token.parse("<EMAIL_1>"), { boundary: "ui" }),
      ).resolves.toBe(email);
    } finally {
      await readOnlyRuntime.close();
    }

    expect(await readFile(vaultPath)).toEqual(vaultBefore);
    expect(await readFile(storePath)).toEqual(storeBefore);
  });

  it("uses an empty read-only vault without creating a database", async () => {
    const directory = await dataDirectory();
    const runId = Id.parse("B".repeat(26));
    const token = Token.parse("<EMAIL_1>");
    const runtimeKeys = await createRuntimeKeys(undefined, { secretResolver });
    const vault = await createRuntimeVault({
      dataDir: directory,
      config: config(),
      overrides: { readOnlyStore: true, secretResolver },
      keys: runtimeKeys,
      clock: { now: () => 0 },
    });
    try {
      await expect(vault.resolve(runId, token, { boundary: "ui" })).resolves.toBeUndefined();
      await expect(vault.put(runId, "email", email)).rejects.toMatchObject({
        code: "vault_unavailable",
      });
      await expect(vault.markTerminal(runId, 1)).rejects.toMatchObject({
        code: "vault_unavailable",
      });
      await expect(vault.listTerminalRunsBefore({ terminalBefore: 2, limit: 1 })).resolves.toEqual(
        [],
      );
      await expect(vault.purge(runId)).rejects.toMatchObject({
        code: "vault_unavailable",
      });
      await expect(vault.stats(runId)).rejects.toMatchObject({
        code: "vault_unavailable",
      });
    } finally {
      await vault.close();
      runtimeKeys.dispose();
    }
    await expect(vault.resolve(runId, token, { boundary: "ui" })).rejects.toMatchObject({
      code: "vault_unavailable",
    });
    expect(existsSync(join(directory, "vault.db"))).toBe(false);
  });

  it("rejects transient vaults in production", async () => {
    const directory = await dataDirectory();
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      createRuntime(config(), {
        dataDir: directory,
        transientVault: true,
        secretResolver,
      }),
    ).rejects.toMatchObject({ code: "transient_vault_in_production" });
  });
});
