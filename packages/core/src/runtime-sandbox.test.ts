// SPDX-License-Identifier: Apache-2.0
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Code,
  FakeClock,
  Id,
  JsonValue,
  PiiConfigSchema,
  RunConfigSchema,
  SandboxConfigSchema,
  SecretRefSchema,
  SequentialIdGenerator,
  type WorkspaceRef,
} from "@harness/schemas";
import { InMemoryEventStore } from "@harness/store";
import { InProcessBackend, RemoteSandboxBackend, type SandboxBackend } from "@harness/sandbox";
import { SqliteVault } from "@harness/vault";
import { compilePolicy, PolicyDocumentSchema } from "@harness/policy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntime } from "./runtime.js";
import { withSandboxLease } from "./runtime-lifecycle.js";
import type { ModelCompletion, ToolPort } from "./ports.js";
import { FakeModelPort } from "./testing/fake-model.js";
import { allowAllPolicy } from "./testing/allow-policy.js";

const toolId = Code.parse("sandbox.probe");
const webFetchId = Code.parse("web.fetch");
const run = RunConfigSchema.parse({});
const canary = "synthetic-sandbox-output-canary";
const result = {
  exitCode: 0,
  stdout: canary,
  stderr: "",
  stdoutBytes: canary.length,
  stderrBytes: 0,
  truncated: false,
  timedOut: false,
  durationMs: 1,
};

function completion(parts: ModelCompletion["parts"]): ModelCompletion {
  return {
    parts,
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: parts.some((part) => part.type === "tool_call") ? "tool_calls" : "stop",
    provider: "synthetic",
    model: "synthetic",
    latencyMs: 0,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: null,
  };
}

function requestUrl(input: RequestInfo | URL): URL {
  if (input instanceof URL) {
    return input;
  }
  return typeof input === "string" ? new URL(input) : new URL(input.url);
}

function model(): FakeModelPort {
  return new FakeModelPort([
    completion([
      { type: "tool_call", callId: Id.parse("11111111111111111111111111"), toolId, args: {} },
    ]),
    completion([{ type: "text", text: "completed" }]),
  ]);
}

function textModel(): FakeModelPort {
  return new FakeModelPort([completion([{ type: "text", text: "completed" }])]);
}

function webFetchModel(url: string): FakeModelPort {
  return new FakeModelPort([
    completion([
      {
        type: "tool_call",
        callId: Id.parse("11111111111111111111111112"),
        toolId: Code.parse("web.fetch"),
        args: JsonValue.parse({ url }),
      },
    ]),
    completion([{ type: "text", text: "completed" }]),
  ]);
}

function fileToolModel(fileToolId: string, args: JsonValue): FakeModelPort {
  return new FakeModelPort([
    completion([
      {
        type: "tool_call",
        callId: Id.parse("11111111111111111111111113"),
        toolId: Code.parse(fileToolId),
        args,
      },
    ]),
  ]);
}

function remoteSandbox(allow: readonly { readonly host: string; readonly ports: number[] }[]) {
  return SandboxConfigSchema.parse({
    runner: { url: "http://sandbox-runner:8080", token: "env:RUNNER" },
    egress: { allow },
  });
}

function metadataTool(backend: SandboxBackend, remote: boolean): ToolPort {
  return {
    describe: (id) => (id === toolId ? { idempotent: false, timeoutMs: 5000 } : undefined),
    execute: async (_call, context) => {
      const output = await backend.exec(
        context.runId,
        {
          argv: [
            remote ? "node" : process.execPath,
            "-e",
            'process.stdout.write(process.env.HARNESS_SANDBOX_CANARY ?? "scrubbed")',
          ],
          timeoutMs: 2000,
          limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
        },
        context.signal,
      );
      return { outcome: "ok", result: { exitCode: output.exitCode, bytes: output.stdoutBytes } };
    },
  };
}

function overrides() {
  return {
    store: new InMemoryEventStore(),
    transientVault: true,
    clock: new FakeClock(100),
    ids: new SequentialIdGenerator(),
    flushTelemetry: () => Promise.resolve(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("createRuntime sandbox composition", () => {
  it("enforces a sensitive-path ask through the decorated runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-sandbox-policy-"));
    const modelPort = fileToolModel(
      "fs.write",
      JsonValue.parse({ path: "secrets/.ENV", content: "synthetic", mode: "create" }),
    );
    const compiled = compilePolicy(
      PolicyDocumentSchema.parse({
        version: 1,
        defaultDecision: "deny",
        rules: [
          {
            id: "ask_sensitive_env",
            match: {
              tools: ["fs.write"],
              args: [{ pointer: "/path", op: "matches", value: "[^/]{0,255}\\.[eE][nN][vV]$" }],
            },
            decision: "ask",
            reason: "sensitive_file",
          },
        ],
      }),
    );
    const runtime = await createRuntime(
      { run, pii: PiiConfigSchema.parse({ defaultAction: "tokenize" }) },
      {
        ...overrides(),
        dataDir,
        model: modelPort,
        policy: {
          version: Code.parse("sensitive_path_test"),
          decide: ({ toolId: policyToolId, args }) =>
            compiled.evaluate({ toolId: policyToolId, args, context: { subagent: false } }),
        },
      },
    );
    try {
      const runResult = await runtime.run("write the environment file");
      expect(runResult.events.some((event) => event.type === "approval_requested")).toBe(true);
      expect(runResult.events.some((event) => event.type === "tool_result")).toBe(false);
    } finally {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves a filesystem error code through the decorated runtime", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-sandbox-fs-error-"));
    const modelPort = fileToolModel(
      "fs.read",
      JsonValue.parse({ path: ".harness/offload/private.txt" }),
    );
    const runtime = await createRuntime(
      { run, pii: PiiConfigSchema.parse({ defaultAction: "tokenize" }) },
      { ...overrides(), dataDir, model: modelPort, policy: allowAllPolicy },
    );
    try {
      const runResult = await runtime.run("read the private file");
      expect(runResult.events.find((event) => event.type === "tool_result")).toMatchObject({
        toolId: "fs.read",
        outcome: "error",
        errorCode: "fs_path_invalid",
      });
    } finally {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("retains workspace archives matching the two event-store snapshot refs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-sandbox-snapshot-retention-"));
    const store = new InMemoryEventStore(undefined, { snapshotKeep: 2 });
    const modelPort = new FakeModelPort([
      ...["13", "14", "15"].map((suffix) =>
        completion([
          {
            type: "tool_call",
            callId: Id.parse(`111111111111111111111111${suffix}`),
            toolId,
            args: {},
          },
        ]),
      ),
      completion([{ type: "text", text: "completed" }]),
    ]);
    const runtime = await createRuntime(
      { run: RunConfigSchema.parse({ checkpointEveryEvents: 1 }), store: { snapshotKeep: 2 } },
      {
        ...overrides(),
        store,
        dataDir,
        model: modelPort,
        createTool: (backend) => metadataTool(backend, false),
        policy: allowAllPolicy,
      },
    );
    try {
      const runResult = await runtime.run("synthetic workspace checkpoint");
      const runId = runResult.events[0]?.runId;
      if (runId === undefined) {
        throw new Error("Expected the run to have an identifier.");
      }
      const checkpoints: string[] = [];
      for await (const event of store.read(runId)) {
        if (event.type === "checkpoint_written" && event.workspaceRef !== undefined) {
          checkpoints.push(event.workspaceRef);
        }
      }
      const retainedRefs = (await store.retainedSnapshots(runId, 2))
        .map((snapshot) => snapshot.workspaceRef)
        .filter((ref): ref is WorkspaceRef => ref !== undefined)
        .reverse();
      const archiveIds = retainedRefs.map((ref) => ref.slice(3, 29));
      const archiveNames = await readdir(join(dataDir, "snapshots", runId));

      expect(checkpoints.length).toBeGreaterThanOrEqual(4);
      expect(archiveNames).toEqual(archiveIds.map((id) => `${id}.tar.gz`));
      await expect(store.latestSnapshot(runId)).resolves.toMatchObject({
        workspaceRef: retainedRefs.at(-1),
      });
    } finally {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("preserves the operation outcome when lease cleanup fails", async () => {
    const backend: SandboxBackend = {
      exec: vi.fn(),
      acquireLease: () => Promise.resolve(),
      releaseLease: () => Promise.reject(new Error("synthetic cleanup failure")),
    };
    const value = { status: "completed" };
    await expect(
      withSandboxLease(backend, Id.parse("00000000000000000000000042"), () =>
        Promise.resolve(value),
      ),
    ).resolves.toBe(value);

    const operationError = new Error("synthetic operation failure");
    await expect(
      withSandboxLease(backend, Id.parse("00000000000000000000000042"), () =>
        Promise.reject(operationError),
      ),
    ).rejects.toBe(operationError);
  });

  // threat: T-12
  it("creates a private workspace under the data directory and rejects outside paths", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-sandbox-workspace-"));
    const runtime = await createRuntime({ run }, { ...overrides(), dataDir });
    try {
      const execution = await runtime.sandboxBackend.exec(
        Id.parse("00000000000000000000000041"),
        {
          argv: [process.execPath, "-e", "process.stdout.write(process.cwd())"],
          timeoutMs: 2000,
          limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
        },
        new AbortController().signal,
      );
      const workspaceRoot = join(dataDir, "workspaces");
      // macOS resolves /var to /private/var; compare canonical paths.
      expect(execution.stdout).toBe(
        await realpath(join(workspaceRoot, Id.parse("00000000000000000000000041"), "project")),
      );
      expect((await stat(workspaceRoot)).mode & 0o777).toBe(0o700);
      await expect(
        runtime.sandboxBackend.exec(
          Id.parse("00000000000000000000000041"),
          {
            argv: [process.execPath, "-e", ""],
            cwd: "../outside",
            timeoutMs: 2000,
            limits: { memoryMb: 128, pids: 16, outputBytes: 1024, cpuSeconds: 5 },
          },
          new AbortController().signal,
        ),
      ).rejects.toMatchObject({ code: "sandbox_workspace_path_invalid" });
    } finally {
      await runtime.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  // threat: T-05
  // threat: T-18
  it.each([
    {
      sandbox: {
        egress: { allow: [{ host: "api.example.com", ports: [443] }] },
      },
    },
    {
      sandbox: {
        runner: { url: "http://sandbox-runner:8080", token: SecretRefSchema.parse("env:RUNNER") },
      },
    },
  ])("closes the vault when sandbox configuration fails closed", async ({ sandbox }) => {
    const dataDir = await mkdtemp(join(tmpdir(), "runtime-sandbox-failure-"));
    const closeVault = vi.spyOn(SqliteVault.prototype, "close");
    try {
      await expect(
        createRuntime(
          { run, sandbox: SandboxConfigSchema.parse(sandbox) },
          {
            dataDir,
            transientVault: true,
            clock: new FakeClock(100),
            ids: new SequentialIdGenerator(),
          },
        ),
      ).rejects.toMatchObject({ code: "sandbox_runner_config_invalid" });
      expect(closeVault).toHaveBeenCalledOnce();
      expect(existsSync(join(dataDir, "harness.db"))).toBe(false);
    } finally {
      closeVault.mockRestore();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  // threat: T-10
  // threat: T-11
  it.each([false, true])(
    "passes one configured backend to the tool port and records only result metadata (remote=%s)",
    async (remote) => {
      vi.stubEnv("HARNESS_SANDBOX_CANARY", canary);
      const fetcher = vi.fn((input: RequestInfo | URL) =>
        Promise.resolve(
          Response.json(requestUrl(input).pathname === "/exec" ? result : { status: "ok" }),
        ),
      );
      vi.stubGlobal("fetch", fetcher);
      const createTool = vi.fn((backend: SandboxBackend) => metadataTool(backend, remote));
      const resolve = vi.fn(() =>
        Promise.resolve({ reveal: () => "synthetic-runtime-sandbox-token-0001" }),
      );
      const runtime = await createRuntime(
        {
          run,
          ...(remote
            ? {
                sandbox: SandboxConfigSchema.parse({
                  runner: { url: "http://sandbox-runner:8080", token: "env:RUNNER" },
                }),
              }
            : {}),
        },
        {
          ...overrides(),
          model: model(),
          policy: allowAllPolicy,
          createTool,
          secretResolver: { resolve },
        },
      );
      try {
        expect(runtime.sandboxBackend).toBeInstanceOf(
          remote ? RemoteSandboxBackend : InProcessBackend,
        );
        expect(createTool).toHaveBeenCalledExactlyOnceWith(runtime.sandboxBackend);
        const execution = await runtime.run("probe");
        expect(execution.status).toBe("completed");
        expect(execution.events.find((event) => event.type === "tool_result")).toMatchObject({
          outcome: "ok",
          result: { exitCode: 0, bytes: remote ? canary.length : "scrubbed".length },
        });
        const events = [];
        for await (const event of runtime.store.read(Id.parse(execution.events[0]?.runId))) {
          events.push(event);
        }
        expect(JSON.stringify(events)).not.toContain(canary);
        expect(JSON.stringify(events)).not.toContain("synthetic-runtime-sandbox-token-0001");
        expect(fetcher).toHaveBeenCalledTimes(remote ? 1 : 0);
        expect(resolve).toHaveBeenCalledTimes(remote ? 1 : 0);
      } finally {
        await runtime.close();
      }
    },
  );

  it("does not advertise web.fetch without a configured allowlist or a remote runner", async () => {
    const emptyAllowlistModel = textModel();
    const emptyAllowlistRuntime = await createRuntime(
      { run, sandbox: remoteSandbox([]) },
      {
        ...overrides(),
        model: emptyAllowlistModel,
        secretResolver: {
          resolve: () => Promise.resolve({ reveal: () => "synthetic-runtime-sandbox-token-0001" }),
        },
      },
    );
    const localModel = textModel();
    const localRuntime = await createRuntime(
      { run, sandbox: remoteSandbox([{ host: "docs.example.test", ports: [443] }]) },
      {
        ...overrides(),
        model: localModel,
        sandboxBackend: new InProcessBackend({
          workspaceRoot: "/tmp/runtime-web-fetch",
          logger: { log: () => undefined },
        }),
      },
    );
    try {
      await emptyAllowlistRuntime.run("inspect tools");
      await localRuntime.run("inspect tools");
      expect(
        emptyAllowlistModel.requests[0]?.request.tools?.map(({ toolId: specId }) => specId),
      ).not.toContain("web.fetch");
      expect(
        localModel.requests[0]?.request.tools?.map(({ toolId: specId }) => specId),
      ).not.toContain("web.fetch");
    } finally {
      await emptyAllowlistRuntime.close();
      await localRuntime.close();
    }
  });

  it("advertises web.fetch with a remote runner and allowlist alongside createTool tools", async () => {
    const modelPort = textModel();
    const customTool = {
      describe: (id: Code) => (id === toolId ? { idempotent: true, timeoutMs: 1_000 } : undefined),
      getToolSpecs: () => [{ toolId, description: "A synthetic tool", inputSchema: {} }],
      execute: () => Promise.resolve({ outcome: "ok" as const, result: null }),
    };
    const createTool = vi.fn(() => customTool);
    const runtime = await createRuntime(
      {
        run,
        sandbox: remoteSandbox([{ host: "docs.example.test", ports: [443] }]),
      },
      {
        ...overrides(),
        model: modelPort,
        secretResolver: {
          resolve: () => Promise.resolve({ reveal: () => "synthetic-runtime-sandbox-token-0001" }),
        },
        createTool,
      },
    );
    try {
      await runtime.run("inspect tools");
      expect(createTool).toHaveBeenCalledExactlyOnceWith(runtime.sandboxBackend);
      expect(modelPort.requests[0]?.request.tools?.map(({ toolId: specId }) => specId)).toContain(
        "web.fetch",
      );
      expect(modelPort.requests[0]?.request.tools?.map(({ toolId: specId }) => specId)).toContain(
        toolId,
      );
    } finally {
      await runtime.close();
    }
  });

  it("rejects a web.fetch collision during runtime setup", async () => {
    const runtimeTool: ToolPort = {
      describe: (id) => (id === webFetchId ? { idempotent: true, timeoutMs: 1_000 } : undefined),
      getToolSpecs: () => [{ toolId: webFetchId, description: "Synthetic fetch", inputSchema: {} }],
      execute: () => Promise.resolve({ outcome: "ok", result: null }),
    };

    await expect(
      createRuntime(
        { run, sandbox: remoteSandbox([{ host: "docs.example.test", ports: [443] }]) },
        {
          ...overrides(),
          createTool: () => runtimeTool,
          secretResolver: {
            resolve: () =>
              Promise.resolve({ reveal: () => "synthetic-runtime-sandbox-token-0001" }),
          },
        },
      ),
    ).rejects.toMatchObject({ code: "tool_id_collision", toolId: webFetchId });
  });

  // threat: T-05
  it("applies policy to tokenized web.fetch calls and tokenizes untrusted results", async () => {
    const outputCanary = "fetch.output@example.test";
    const order: string[] = [];
    const fetcher = vi.fn((_input: URL | RequestInfo): Promise<Response> => {
      order.push("fetch");
      return Promise.resolve(
        Response.json({
          url: "https://docs.example.test/page",
          status: 200,
          contentType: "text/plain",
          text: `Contact ${outputCanary}`,
          truncated: false,
          untrusted: true,
          hiddenTextDropped: 0,
        }),
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const modelPort = webFetchModel("https://docs.example.test/page");
    const policy = {
      version: Code.parse("web_fetch_test"),
      decide: vi.fn((call: { readonly toolId: Code; readonly args: JsonValue }) => {
        order.push("policy");
        expect(call.toolId).toBe("web.fetch");
        expect(JSON.stringify(call.args)).toContain("https://docs.example.test/page");
        return {
          decision: "allow" as const,
          ruleId: Code.parse("test_allow"),
          reason: Code.parse("test_allowed"),
          editable: [],
        };
      }),
    };
    const runtime = await createRuntime(
      {
        run,
        pii: PiiConfigSchema.parse({ defaultAction: "tokenize" }),
        sandbox: remoteSandbox([{ host: "docs.example.test", ports: [443] }]),
      },
      {
        ...overrides(),
        model: modelPort,
        policy,
        secretResolver: {
          resolve: () => Promise.resolve({ reveal: () => "synthetic-runtime-sandbox-token-0001" }),
        },
      },
    );
    try {
      const runResult = await runtime.run("fetch the page");
      expect(runResult.status).toBe("completed");
      expect(order).toEqual(["policy", "fetch"]);
      expect(modelPort.requests[0]?.request.tools?.map(({ toolId: specId }) => specId)).toContain(
        "web.fetch",
      );
      expect(runResult.events.find((event) => event.type === "tool_result")).toMatchObject({
        toolId: "web.fetch",
        outcome: "ok",
        result: { text: "Contact <EMAIL_1>", untrusted: true },
      });
      const recorded = JSON.stringify(runResult.events);
      expect(recorded).not.toContain(outputCanary);
    } finally {
      await runtime.close();
    }
  });

  // threat: T-05
  it("does not call the runner when policy denies web.fetch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    const modelPort = webFetchModel("https://docs.example.test/page");
    const policy = {
      version: Code.parse("web_fetch_test"),
      decide: vi.fn(() => ({
        decision: "deny" as const,
        ruleId: Code.parse("test_deny"),
        reason: Code.parse("test_denied"),
        editable: [],
      })),
    };
    const runtime = await createRuntime(
      {
        run,
        sandbox: remoteSandbox([{ host: "docs.example.test", ports: [443] }]),
      },
      {
        ...overrides(),
        model: modelPort,
        policy,
        secretResolver: {
          resolve: () => Promise.resolve({ reveal: () => "synthetic-runtime-sandbox-token-0001" }),
        },
      },
    );
    try {
      const runResult = await runtime.run("fetch the page");
      expect(runResult.events.find((event) => event.type === "tool_intent")).toMatchObject({
        toolId: "web.fetch",
        policyDecision: "deny",
      });
      expect(fetcher).not.toHaveBeenCalled();
      expect(policy.decide).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });

  it("rejects binary fetch results when no workspace offloader is configured", async () => {
    const fetcher = vi.fn(() =>
      Promise.resolve(
        Response.json({
          url: "https://docs.example.test/image",
          status: 200,
          contentType: "image/png",
          binary: true,
          bytes: [0, 255],
          truncated: false,
          untrusted: true,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const runtime = await createRuntime(
      {
        run,
        sandbox: remoteSandbox([{ host: "docs.example.test", ports: [443] }]),
      },
      {
        ...overrides(),
        model: webFetchModel("https://docs.example.test/image"),
        policy: allowAllPolicy,
        secretResolver: {
          resolve: () => Promise.resolve({ reveal: () => "synthetic-runtime-sandbox-token-0001" }),
        },
      },
    );
    try {
      const runResult = await runtime.run("fetch the image");
      expect(runResult.events.find((event) => event.type === "tool_result")).toMatchObject({
        toolId: webFetchId,
        outcome: "error",
        errorCode: "binary_result_unavailable",
        result: null,
      });
      expect(JSON.stringify(runResult.events)).not.toContain("[0,255]");
      expect(fetcher).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });

  // threat: T-08
  it.each(["deny", "ask"] as const)(
    "does not execute the backend before policy %s",
    async (decision) => {
      const exec = vi.fn();
      const backend = { exec };
      const runtime = await createRuntime(
        { run },
        {
          ...overrides(),
          sandboxBackend: backend,
          createTool: (sandbox) => metadataTool(sandbox, false),
          model: model(),
          policy: {
            ...allowAllPolicy,
            decide: () => ({
              decision,
              ruleId: "sandbox_rule",
              reason: "sandbox_policy",
              editable: [],
            }),
          },
        },
      );
      try {
        await runtime.run("probe");
        expect(exec).not.toHaveBeenCalled();
      } finally {
        await runtime.close();
      }
    },
  );

  it("keeps an explicit tool override ahead of the tool factory", async () => {
    const createTool = vi.fn();
    const runtime = await createRuntime(
      { run },
      {
        ...overrides(),
        sandboxBackend: { exec: vi.fn() },
        tool: metadataTool({ exec: vi.fn() }, false),
        createTool,
      },
    );
    await runtime.close();
    expect(createTool).not.toHaveBeenCalled();
  });

  it.each(["none", "flush", "backend"] as const)(
    "closes the backend and storage even when %s fails during shutdown",
    async (failure) => {
      const error = new Error("synthetic");
      const close = vi.fn(() =>
        failure === "backend" ? Promise.reject(error) : Promise.resolve(),
      );
      const deps = overrides();
      const storeClose = vi.spyOn(deps.store, "close");
      const runtime = await createRuntime(
        { run },
        {
          ...deps,
          sandboxBackend: { exec: vi.fn(), close },
          flushTelemetry: () => (failure === "flush" ? Promise.reject(error) : Promise.resolve()),
        },
      );
      const thrown: unknown = await runtime.close().catch((caught: unknown) => caught);
      expect(thrown).toBe(failure === "none" ? undefined : error);
      expect(close).toHaveBeenCalledOnce();
      expect(storeClose).toHaveBeenCalledOnce();
    },
  );

  it("closes the backend if subsequent tool composition fails", async () => {
    const close = vi.fn(() => Promise.resolve());
    await expect(
      createRuntime(
        { run },
        {
          ...overrides(),
          sandboxBackend: { exec: vi.fn(), close },
          createTool: () => {
            throw new Error("synthetic");
          },
        },
      ),
    ).rejects.toThrow("synthetic");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes a backend override if key resolution fails before tool composition", async () => {
    const close = vi.fn(() => Promise.resolve());
    await expect(
      createRuntime(
        {
          run,
          keys: {
            currentKeyId: "synthetic",
            keys: [{ id: "synthetic", secret: SecretRefSchema.parse("env:MISSING_KEY") }],
          },
        },
        {
          ...overrides(),
          sandboxBackend: { exec: vi.fn(), close },
          secretResolver: { resolve: () => Promise.reject(new Error("synthetic")) },
        },
      ),
    ).rejects.toBeDefined();
    expect(close).toHaveBeenCalledOnce();
  });
});
