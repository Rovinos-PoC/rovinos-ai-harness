// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createServer as createNetServer } from "node:net";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Duplex, Readable } from "node:stream";
import { Id, parseJson } from "@harness/schemas";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { WebFetchResultSchema } from "../../src/web-fetch-contracts.js";
import { WorkspaceSnapshotter } from "../../src/snapshot.js";
import { RemoteSandboxBackend } from "../../src/remote.js";
import {
  createRunnerServer,
  createRunnerRequestHandler,
  formatRunnerConfigurationError,
  RunnerConfigurationError,
  startRunnerServer,
  withProxyEnvironment,
} from "./server.js";
import type { RunnerServerOptions } from "./server.js";
import type { ExecResult, ExecSpec } from "../../src/types.js";
import { fetchWebContent } from "./web-fetch.js";
import type { ProxyRequest, ProxyResponse, WebFetchTransport } from "./web-fetch-transport.js";
import { ensureRunWorkspace } from "../../src/workspace.js";
import { WorkspaceFileSystem } from "../../src/workspace-files.js";
import type { RunnerCredentialApi } from "./process-lock.js";

const token = "synthetic-runner-token-that-is-at-least-32-bytes";
const runId = Id.parse("00000000000000000000000001");
const otherRunId = Id.parse("00000000000000000000000002");
const workspaceRoot = mkdtempSync(join(tmpdir(), "sandbox-runner-server-"));
const spec: ExecSpec = {
  argv: ["/bin/echo", "ok"],
  timeoutMs: 100,
  limits: { memoryMb: 128, pids: 16, outputBytes: 128, cpuSeconds: 2 },
};
const result: ExecResult = {
  exitCode: 0,
  stdout: "ok\n",
  stderr: "",
  stdoutBytes: 3,
  stderrBytes: 0,
  truncated: false,
  timedOut: false,
  durationMs: 2,
};
const ResponseBodySchema = z
  .object({
    code: z.string().optional(),
    status: z.literal("ok").optional(),
    exitCode: z.number().int().nonnegative().nullable().optional(),
    signal: z.string().optional(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    stdoutBytes: z.number().int().nonnegative().optional(),
    stderrBytes: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    timedOut: z.boolean().optional(),
    durationMs: z.number().int().nonnegative().optional(),
  })
  .strict();

class MemoryResponse extends EventEmitter {
  headersSent = false;
  writableEnded = false;
  status = 0;
  body = "";
  destroyed = false;
  readonly chunks: Buffer[] = [];

  writeHead(status: number, _headers: Record<string, string>): this {
    this.status = status;
    this.headersSent = true;
    return this;
  }

  write(chunk: Buffer): boolean {
    this.chunks.push(Buffer.from(chunk));
    return true;
  }

  end(body?: string): void {
    this.body = body ?? Buffer.concat(this.chunks).toString("utf8");
    this.writableEnded = true;
    this.emit("close");
  }

  destroy(): void {
    this.destroyed = true;
  }
}

class FakeSocket extends Duplex {
  override _read(): void {
    this.push(null);
  }

  override _write(
    _chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    callback();
  }
}

function makeRequest(
  options: {
    method?: string;
    url?: string;
    host?: string;
    origin?: string;
    authorization?: string;
    body?: string | Buffer;
    workspaceRunId?: string;
    maxFileBytes?: number;
    maxSnapshotBytes?: number;
  } = {},
) {
  const request = Readable.from(
    options.body === undefined
      ? []
      : [Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)],
  );
  return Object.assign(request, {
    method: options.method ?? "POST",
    url: options.url ?? "/exec",
    headers: {
      host: options.host ?? "runner.test",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
      ...(options.workspaceRunId === undefined ? {} : { "x-run-id": options.workspaceRunId }),
      ...(options.maxFileBytes === undefined
        ? {}
        : { "x-max-file-bytes": String(options.maxFileBytes) }),
      ...(options.maxSnapshotBytes === undefined
        ? {}
        : { "x-max-snapshot-bytes": String(options.maxSnapshotBytes) }),
    },
  });
}

function makeOptions(overrides: Partial<RunnerServerOptions> = {}): RunnerServerOptions {
  return {
    token,
    allowedHosts: ["runner.test"],
    workspaceRoot,
    execute: () => Promise.resolve(result),
    ...overrides,
  };
}

function makePayload(): string {
  return JSON.stringify({ runId, spec });
}

const fetchPayload = JSON.stringify({
  runId,
  request: { url: "https://docs.example.test/page?synthetic=canary", accept: "text/plain" },
});
const fetchResult = WebFetchResultSchema.parse({
  url: "https://docs.example.test/page",
  status: 200,
  contentType: "text/plain",
  text: "untrusted response",
  truncated: false,
  untrusted: true,
  hiddenTextDropped: 0,
});

async function call(
  handler: ReturnType<typeof createRunnerRequestHandler>,
  request: ReturnType<typeof makeRequest>,
): Promise<MemoryResponse> {
  const response = new MemoryResponse();
  await handler(request, response);
  return response;
}

function responseBody(response: MemoryResponse): z.infer<typeof ResponseBodySchema> {
  return parseJson(ResponseBodySchema, response.body);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe("runner HTTP request handler", () => {
  it("rejects matching execution uids while allowing the shared execution group", () => {
    const serverUid = process.getuid?.() ?? 0;
    const serverGid = process.getgid?.() ?? 0;

    expect(() => createRunnerServer(makeOptions({ executionUid: serverUid }))).toThrowError(
      RunnerConfigurationError,
    );
    expect(() => createRunnerServer(makeOptions({ executionGid: serverGid }))).not.toThrow();
  });

  it("serves health without auth and rejects unknown routes", async () => {
    const handler = createRunnerRequestHandler(makeOptions());

    const health = await call(handler, makeRequest({ method: "GET", url: "/healthz" }));
    const missing = await call(
      handler,
      makeRequest({ url: "/missing", authorization: "Bearer " + token }),
    );

    expect(health.status).toBe(200);
    expect(responseBody(health)).toEqual({ status: "ok" });
    expect(missing.status).toBe(404);
    expect(responseBody(missing)).toMatchObject({ code: "sandbox_route_not_found" });
  });

  it("requires an allowlist and proxy before exposing the authenticated fetch endpoint", async () => {
    const handler = createRunnerRequestHandler(makeOptions());
    const response = await call(
      handler,
      makeRequest({
        url: "/fetch",
        authorization: ["Bearer", token].join(" "),
        body: fetchPayload,
      }),
    );

    expect(response.status).toBe(403);
    expect(responseBody(response)).toMatchObject({ code: "sandbox_fetch_egress_disabled" });
  });

  it("fetches only through the configured runner proxy and returns untrusted content", async () => {
    const fetch = vi.fn(() => Promise.resolve(fetchResult));
    const handler = createRunnerRequestHandler(
      makeOptions({
        proxyUrl: "http://sandbox-egress-proxy:3128",
        egressAllowlist: [{ host: "docs.example.test", ports: [443] }],
        fetch,
      }),
    );
    const response = await call(
      handler,
      makeRequest({
        url: "/fetch",
        authorization: ["Bearer", token].join(" "),
        body: fetchPayload,
      }),
    );

    expect(response.status).toBe(200);
    expect(WebFetchResultSchema.parse(JSON.parse(response.body))).toEqual(fetchResult);
    expect(fetch).toHaveBeenCalledWith(
      { url: "https://docs.example.test/page?synthetic=canary", accept: "text/plain" },
      {
        proxyUrl: "http://sandbox-egress-proxy:3128",
        allow: [{ host: "docs.example.test", ports: [443] }],
      },
      expect.any(AbortSignal),
    );
  });

  it("cancels a stalled TLS handshake and admits the next exec request", async () => {
    const tunnelSocket = new FakeSocket();
    const tlsSocket = new FakeSocket();
    let onConnect: ((response: ProxyResponse, socket: Duplex) => void) | undefined;
    let signalTlsStarted: () => void = () => undefined;
    const tlsStarted = new Promise<void>((resolve) => {
      signalTlsStarted = resolve;
    });
    const connectResponse: ProxyResponse = {
      statusCode: 200,
      headers: {},
      onData: () => undefined,
      onEnd: () => undefined,
      onError: () => undefined,
      onAborted: () => undefined,
      destroy: () => undefined,
    };
    const transport: WebFetchTransport = {
      requestHttp: (_requestOptions) => {
        const request: ProxyRequest = {
          onError: () => undefined,
          onConnect: (listener) => {
            onConnect = listener;
          },
          end: () => onConnect?.(connectResponse, tunnelSocket),
        };
        return request;
      },
      connectTls: () => {
        signalTlsStarted();
        return {
          socket: tlsSocket,
          onError: () => undefined,
          onSecureConnect: () => undefined,
        };
      },
      requestHttps: () => {
        throw new Error("TLS handshake should remain stalled");
      },
    };
    const handler = createRunnerRequestHandler(
      makeOptions({
        proxyUrl: "http://sandbox-egress-proxy:3128",
        egressAllowlist: [{ host: "docs.example.test", ports: [443] }],
        fetch: (request, configuration, signal) =>
          fetchWebContent(request, configuration, signal, { transport }),
      }),
    );
    const fetchResponse = new MemoryResponse();
    const pendingFetch = handler(
      makeRequest({
        url: "/fetch",
        authorization: ["Bearer", token].join(" "),
        body: fetchPayload,
      }),
      fetchResponse,
    );

    await tlsStarted;
    fetchResponse.emit("close");
    await pendingFetch;

    expect(fetchResponse.status).toBe(502);
    expect(tunnelSocket.destroyed).toBe(true);
    expect(tlsSocket.destroyed).toBe(true);
    const execResponse = await call(
      handler,
      makeRequest({
        url: "/exec",
        authorization: ["Bearer", token].join(" "),
        body: makePayload(),
      }),
    );
    expect(execResponse.status).toBe(200);
    expect(responseBody(execResponse)).toMatchObject({ stdout: "ok\n" });
  });

  it("does not expose fetch URLs in runner errors or invoke the fetcher for malformed inputs", async () => {
    const fetch = vi.fn(() => Promise.resolve(fetchResult));
    const handler = createRunnerRequestHandler(
      makeOptions({
        proxyUrl: "http://sandbox-egress-proxy:3128",
        egressAllowlist: [{ host: "docs.example.test", ports: [443] }],
        fetch,
      }),
    );
    const response = await call(
      handler,
      makeRequest({
        url: "/fetch",
        authorization: ["Bearer", token].join(" "),
        body: JSON.stringify({
          runId,
          request: { url: "******docs.example.test/page?synthetic-canary" },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(response.body).not.toContain("synthetic-canary");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects missing and incorrect bearer credentials", async () => {
    const handler = createRunnerRequestHandler(makeOptions());

    const missing = await call(handler, makeRequest({ body: makePayload() }));
    const incorrect = await call(
      handler,
      makeRequest({
        authorization: ["Bearer", "incorrect-synthetic-token"].join(" "),
        body: makePayload(),
      }),
    );
    const malformed = await call(
      handler,
      makeRequest({ authorization: "Basic wrong", body: makePayload() }),
    );

    expect(missing.status).toBe(401);
    expect(incorrect.status).toBe(401);
    expect(malformed.status).toBe(401);
  });

  it("rejects unexpected Host and Origin values", async () => {
    const handler = createRunnerRequestHandler(makeOptions());

    const wrongHost = await call(
      handler,
      makeRequest({ host: "untrusted.test", authorization: "Bearer " + token }),
    );
    const wrongHostPort = await call(
      handler,
      makeRequest({ host: "runner.test:8080", authorization: "Bearer " + token }),
    );
    const malformedHost = await call(
      handler,
      makeRequest({ host: "http://runner.test", authorization: "Bearer " + token }),
    );
    const wrongOrigin = await call(
      handler,
      makeRequest({
        origin: "https://untrusted.test",
        authorization: "Bearer " + token,
      }),
    );
    const validOrigin = await call(
      handler,
      makeRequest({
        origin: "https://runner.test",
        authorization: "Bearer " + token,
        body: makePayload(),
      }),
    );

    expect(wrongHost.status).toBe(400);
    expect(wrongHostPort.status).toBe(400);
    expect(malformedHost.status).toBe(400);
    expect(wrongOrigin.status).toBe(400);
    expect(validOrigin.status).toBe(200);
  });

  it("validates the request schema and enforces the two MiB body limit", async () => {
    const handler = createRunnerRequestHandler(makeOptions());

    const invalid = await call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: "{}" }),
    );
    const invalidUtf8 = await call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: Buffer.from([0xff]) }),
    );
    const oversized = await call(
      handler,
      makeRequest({
        authorization: "Bearer " + token,
        body: Buffer.alloc(2 * 1024 * 1024 + 1, "x"),
      }),
    );

    expect(invalid.status).toBe(400);
    expect(invalidUtf8.status).toBe(400);
    expect(oversized.status).toBe(413);
  });

  it("rejects a mismatch between the /fs route and its body operation", async () => {
    const handler = createRunnerRequestHandler(makeOptions());
    const response = await call(
      handler,
      makeRequest({
        url: "/fs/read",
        authorization: "Bearer " + token,
        body: JSON.stringify({
          runId,
          request: {
            operation: "write",
            input: { path: "mismatch.txt", content: "synthetic", mode: "create" },
          },
        }),
      }),
    );

    expect(response.status).toBe(400);
    expect(responseBody(response)).toMatchObject({ code: "sandbox_request_invalid" });
  });

  it("serializes concurrent preconditioned file edits through the runner handler", async () => {
    const runIdForFile = Id.parse("00000000000000000000000022");
    const project = await ensureRunWorkspace(workspaceRoot, runIdForFile);
    const path = join(project, "concurrent.txt");
    const original = "before";
    await writeFile(path, original);
    const expectedSha256 = createHash("sha256").update(original).digest("hex");
    const handler = createRunnerRequestHandler(makeOptions());
    const request = () =>
      call(
        handler,
        makeRequest({
          url: "/fs/edit",
          authorization: "Bearer " + token,
          body: JSON.stringify({
            runId: runIdForFile,
            request: {
              operation: "edit",
              input: {
                path: "concurrent.txt",
                edits: [{ oldText: original, newText: "after" }],
                expectedSha256,
              },
            },
          }),
        }),
      );

    const responses = await Promise.all([request(), request()]);
    expect(responses.filter((response) => response.status === 200)).toHaveLength(1);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(1);
    expect(await readFile(path, "utf8")).toBe("after");
  });

  it("serializes lease requests until file operations restore process credentials", async () => {
    const executionUid = 10003;
    const executionGid = 10003;
    let currentUid = 10002;
    let currentGid = 10002;
    const credentials: RunnerCredentialApi = {
      geteuid: () => currentUid,
      getegid: () => currentGid,
      seteuid: (uid) => {
        currentUid = uid;
      },
      setegid: (gid) => {
        currentGid = gid;
      },
    };
    let markStarted: () => void = () => undefined;
    let releaseOperation: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseOperation = resolve;
    });
    const executeFileOperation = vi
      .spyOn(WorkspaceFileSystem.prototype, "execute")
      .mockImplementation(async () => {
        expect(credentials.geteuid()).toBe(executionUid);
        expect(credentials.getegid()).toBe(executionGid);
        markStarted();
        await gate;
        return { binary: false, bytes: 0, content: "", offset: 0, path: "idle.txt" };
      });
    const handler = createRunnerRequestHandler(
      makeOptions({ executionUid, executionGid }),
      credentials,
    );
    try {
      const fileResponse = new MemoryResponse();
      const pendingFile = handler(
        makeRequest({
          url: "/fs/read",
          authorization: "Bearer " + token,
          body: JSON.stringify({
            runId,
            request: { operation: "read", input: { path: "idle.txt" } },
          }),
        }),
        fileResponse,
      );
      await started;
      let identityAtLeaseResponse: readonly [number | undefined, number | undefined] | undefined;
      class LeaseIdentityResponse extends MemoryResponse {
        override end(body?: string): void {
          identityAtLeaseResponse = [credentials.geteuid(), credentials.getegid()];
          super.end(body);
        }
      }
      const leaseResponse = new LeaseIdentityResponse();
      const pendingLease = handler(
        makeRequest({
          url: "/lease",
          authorization: "Bearer " + token,
          body: JSON.stringify({ runId }),
        }),
        leaseResponse,
      );
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(leaseResponse.writableEnded).toBe(false);
      releaseOperation();
      await Promise.all([pendingFile, pendingLease]);

      expect(fileResponse.status).toBe(200);
      expect(leaseResponse.status).toBe(200);
      expect(identityAtLeaseResponse).toEqual([10002, 10002]);
      expect(credentials.geteuid()).toBe(10002);
      expect(credentials.getegid()).toBe(10002);
      expect(executeFileOperation).toHaveBeenCalledOnce();
    } finally {
      releaseOperation();
      executeFileOperation.mockRestore();
    }
  });

  it("executes an authenticated request and returns a schema-validated result", async () => {
    const execute = vi.fn(() => Promise.resolve(result));
    const handler = createRunnerRequestHandler(makeOptions({ execute }));

    const response = await call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: makePayload() }),
    );

    expect(response.status).toBe(200);
    expect(responseBody(response)).toMatchObject({ stdout: "ok\n" });
    expect(execute).toHaveBeenCalledWith(runId, spec, expect.any(AbortSignal));
  });

  it("injects both proxy spellings and removes proxy bypass variables", async () => {
    const execute = vi.fn((_runId: typeof runId, _spec: ExecSpec) => Promise.resolve(result));
    const handler = createRunnerRequestHandler(
      makeOptions({ execute, proxyUrl: "http://sandbox-egress-proxy:3128" }),
    );
    const response = await call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: makePayload() }),
    );
    const executedSpec = execute.mock.calls[0]?.[1];
    expect(response.status).toBe(200);
    expect(executedSpec?.env).toEqual({
      HTTP_PROXY: "http://sandbox-egress-proxy:3128",
      HTTPS_PROXY: "http://sandbox-egress-proxy:3128",
      http_proxy: "http://sandbox-egress-proxy:3128",
      https_proxy: "http://sandbox-egress-proxy:3128",
    });
    expect(executedSpec?.env).not.toHaveProperty("NO_PROXY");
    expect(executedSpec?.env).not.toHaveProperty("no_proxy");
    expect(() =>
      createRunnerRequestHandler(makeOptions({ proxyUrl: "file:///tmp/proxy" })),
    ).toThrow(RunnerConfigurationError);
  });

  it("removes both proxy bypass spellings from a child environment", () => {
    const execution = withProxyEnvironment(
      {
        ...spec,
        env: {
          NO_PROXY: "*",
          no_proxy: "*",
          HTTP_PROXY: "http://untrusted.example.test",
          http_proxy: "http://untrusted.example.test",
          CUSTOM_VALUE: "preserved",
        },
      },
      "http://sandbox-egress-proxy:3128",
    );

    expect(execution.env).toEqual({
      CUSTOM_VALUE: "preserved",
      HTTP_PROXY: "http://sandbox-egress-proxy:3128",
      HTTPS_PROXY: "http://sandbox-egress-proxy:3128",
      http_proxy: "http://sandbox-egress-proxy:3128",
      https_proxy: "http://sandbox-egress-proxy:3128",
    });
  });

  it("rejects a file operation while an execution is busy", async () => {
    let releaseExecution: (value: ExecResult) => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<ExecResult>((resolve) => {
      releaseExecution = resolve;
    });
    const handler = createRunnerRequestHandler(
      makeOptions({
        execute: async () => {
          markStarted();
          return pending;
        },
      }),
    );
    const first = call(
      handler,
      makeRequest({ authorization: "Bearer " + token, body: makePayload() }),
    );
    await started;
    const second = await call(
      handler,
      makeRequest({
        url: "/fs/read",
        authorization: "Bearer " + token,
        body: JSON.stringify({
          runId,
          request: { operation: "read", input: { path: "busy.txt" } },
        }),
      }),
    );
    releaseExecution(result);
    await first;

    expect(second.status).toBe(409);
    expect(responseBody(second)).toMatchObject({ code: "sandbox_busy" });
  });

  it("aborts execution when the response closes before it completes", async () => {
    let releaseExecution: (value: ExecResult) => void = () => undefined;
    let markStarted: (signal: AbortSignal) => void = () => undefined;
    const started = new Promise<AbortSignal>((resolve) => {
      markStarted = resolve;
    });
    const pending = new Promise<ExecResult>((resolve) => {
      releaseExecution = resolve;
    });
    const handler = createRunnerRequestHandler(
      makeOptions({
        execute: async (_runId, _spec, signal) => {
          markStarted(signal);
          return pending;
        },
      }),
    );
    const request = makeRequest({ authorization: "Bearer " + token, body: makePayload() });
    const response = new MemoryResponse();
    const execution = handler(request, response);
    const signal = await started;
    response.emit("close");
    releaseExecution(result);
    await execution;

    expect(signal.aborted).toBe(true);
  });

  it("returns a safe execution failure when the executor or result contract fails", async () => {
    const failing = createRunnerRequestHandler(
      makeOptions({ execute: () => Promise.reject(new Error("synthetic failure")) }),
    );
    const invalidResult = createRunnerRequestHandler(
      makeOptions({ execute: () => Promise.resolve({ ...result, exitCode: -1 }) }),
    );
    const request = () => makeRequest({ authorization: "Bearer " + token, body: makePayload() });

    expect((await call(failing, request())).status).toBe(500);
    expect((await call(invalidResult, request())).status).toBe(500);
  });

  it("rejects requests with a failed body stream without exposing details", async () => {
    const handler = createRunnerRequestHandler(makeOptions());
    const request = Object.assign(
      new Readable({
        read() {
          this.destroy(new Error("synthetic stream failure"));
        },
      }),
      {
        method: "POST",
        url: "/exec",
        headers: { host: "runner.test", authorization: "Bearer " + token },
      },
    );

    const response = await call(handler, request);

    expect(response.status).toBe(500);
    expect(response.body).not.toContain("synthetic stream failure");
  });

  it("rejects empty tokens, missing hosts, and malformed allowlists", () => {
    expect(() => createRunnerRequestHandler(makeOptions({ token: "" }))).toThrow(
      RunnerConfigurationError,
    );
    expect(() =>
      createRunnerRequestHandler(makeOptions({ token: "short-synthetic-token" })),
    ).toThrow(RunnerConfigurationError);
    expect(() => createRunnerRequestHandler(makeOptions({ token: "é".repeat(16) }))).not.toThrow();
    expect(() => createRunnerRequestHandler(makeOptions({ allowedHosts: [] }))).toThrow(
      RunnerConfigurationError,
    );
    expect(() =>
      createRunnerRequestHandler(makeOptions({ allowedHosts: ["runner.test/path"] })),
    ).toThrow(RunnerConfigurationError);
  });

  it("requires a strong token at startup and removes it from the environment", () => {
    vi.stubEnv("SANDBOX_RUNNER_TOKEN", "");
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);
    vi.stubEnv("SANDBOX_RUNNER_TOKEN", "short-token");
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);
    vi.stubEnv("SANDBOX_RUNNER_TOKEN", token);
    vi.stubEnv("SANDBOX_RUNNER_PORT", "0");
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);
    expect(process.env.SANDBOX_RUNNER_TOKEN).toBeUndefined();
    vi.stubEnv("SANDBOX_RUNNER_PORT", "8080");
    delete process.env.SANDBOX_RUNNER_TOKEN;
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);
  });

  it("reads a runner token from a file and removes both token settings from the environment", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-token-"));
    const tokenPath = join(directory, "token");
    await writeFile(tokenPath, `${token}\n`, { encoding: "utf8" });
    const port = await availablePort();
    vi.stubEnv("SANDBOX_RUNNER_TOKEN_FILE", tokenPath);
    vi.stubEnv("SANDBOX_RUNNER_PORT", String(port));
    vi.stubEnv("SANDBOX_ALLOWED_HOSTS", `127.0.0.1:${String(port)}`);
    let server: ReturnType<typeof startRunnerServer> | undefined;

    try {
      server = startRunnerServer();
      await new Promise<void>((resolve, reject) => {
        server?.once("listening", resolve);
        server?.once("error", reject);
      });
      const response = await fetch(`http://127.0.0.1:${String(port)}/exec`, {
        method: "POST",
        headers: { authorization: ["Bearer", token].join(" ") },
        body: "{}",
      });

      expect(response.status).toBe(400);
      expect(process.env.SANDBOX_RUNNER_TOKEN).toBeUndefined();
      expect(process.env.SANDBOX_RUNNER_TOKEN_FILE).toBeUndefined();
    } finally {
      if (server?.listening === true) {
        await new Promise<void>((resolve, reject) => {
          server?.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("round-trips snapshots through the runner-owned workspace", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-snapshot-"));
    const runnerWorkspaceRoot = join(directory, "runner-workspaces");
    const localWorkspaceRoot = join(directory, "harness-workspaces");
    const snapshotRoot = join(directory, "snapshots");
    const runRoot = join(runnerWorkspaceRoot, runId);
    await mkdir(runRoot, { recursive: true, mode: 0o750 });
    await writeFile(join(runRoot, "project.txt"), "before", { encoding: "utf8" });
    await mkdir(join(runnerWorkspaceRoot, otherRunId), { recursive: true, mode: 0o750 });
    await writeFile(join(runnerWorkspaceRoot, otherRunId, "project.txt"), "other", {
      encoding: "utf8",
    });
    const port = await availablePort();
    const server = createRunnerServer(
      makeOptions({
        workspaceRoot: runnerWorkspaceRoot,
        allowedHosts: [`127.0.0.1:${String(port)}`],
      }),
    );
    const fetcher: typeof fetch = async (input, init) => {
      let url: URL;
      if (input instanceof URL) {
        url = input;
      } else if (typeof input === "string") {
        url = new URL(input);
      } else {
        url = new URL(input.url);
      }
      url.hostname = "127.0.0.1";
      return fetch(url, init);
    };
    const backend = new RemoteSandboxBackend({
      url: `http://runner.test:${String(port)}/`,
      token,
      fetcher,
    });
    let snapshotIndex = 0;
    const snapshotter = new WorkspaceSnapshotter({
      workspaceRoot: localWorkspaceRoot,
      snapshotRoot,
      ids: {
        next: () => {
          snapshotIndex += 1;
          return `0000000000000000000000000${String(snapshotIndex)}`;
        },
      },
      remoteWorkspace: backend,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      expect(await snapshotter.hasWorkspace(runId)).toBe(true);
      await expect(lstat(join(localWorkspaceRoot, runId))).rejects.toMatchObject({
        code: "ENOENT",
      });
      const ref = await snapshotter.snapshot(runId);
      expect(await readFile(join(runRoot, "project.txt"), "utf8")).toBe("before");

      await chmod(runRoot, 0o750);
      await writeFile(join(runRoot, "project.txt"), "after", { encoding: "utf8" });
      await snapshotter.restore(runId, ref);

      expect(await readFile(join(runRoot, "project.txt"), "utf8")).toBe("before");

      await backend.acquireLease(runId);
      const pinnedRef = await snapshotter.snapshot(runId);
      await snapshotter.restore(runId, pinnedRef);
      await expect(snapshotter.snapshot(otherRunId)).rejects.toMatchObject({
        code: "sandbox_busy",
      });
      await backend.releaseLease(runId);
      await backend.acquireLease(otherRunId);
      await backend.releaseLease(otherRunId);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error === undefined) {
              resolve();
            } else {
              reject(error);
            }
          });
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reports missing, invalid, and oversized workspace transfers safely", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-workspace-errors-"));
    const handler = createRunnerRequestHandler(makeOptions({ workspaceRoot: directory }));
    const authorization = ["Bearer", token].join(" ");
    const requestPayload = (forRun: string) => JSON.stringify({ runId: forRun });

    try {
      const missing = await call(
        handler,
        makeRequest({
          url: "/workspace/exists",
          authorization,
          body: requestPayload(runId),
        }),
      );
      expect(missing.status).toBe(200);
      expect(missing.body).toBe('{"exists":false}');

      const missingSnapshot = await call(
        handler,
        makeRequest({
          url: "/workspace/snapshot",
          authorization,
          body: JSON.stringify({ runId, maxFileBytes: 8, maxSnapshotBytes: 8 }),
        }),
      );
      expect(missingSnapshot.status).toBe(404);

      await writeFile(join(directory, runId), "not a workspace");
      const invalidWorkspace = await call(
        handler,
        makeRequest({
          url: "/workspace/exists",
          authorization,
          body: requestPayload(runId),
        }),
      );
      expect(invalidWorkspace.status).toBe(500);
      await rm(join(directory, runId));

      await mkdir(join(directory, runId), { recursive: true });
      await writeFile(join(directory, runId, "large"), Buffer.alloc(16, 1));
      const oversizedSnapshot = await call(
        handler,
        makeRequest({
          url: "/workspace/snapshot",
          authorization,
          body: JSON.stringify({ runId, maxFileBytes: 8, maxSnapshotBytes: 32 }),
        }),
      );
      expect(oversizedSnapshot.status).toBe(413);

      const oversizedRestore = await call(
        handler,
        makeRequest({
          url: "/workspace/restore",
          authorization,
          workspaceRunId: runId,
          maxFileBytes: 8,
          maxSnapshotBytes: 8,
          body: Buffer.alloc(16, 1),
        }),
      );
      expect(oversizedRestore.status).toBe(413);
      await expect(readFile(join(directory, runId, "large"))).resolves.toEqual(Buffer.alloc(16, 1));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects both token settings and an empty token file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sandbox-runner-token-"));
    const tokenPath = join(directory, "empty-token");
    await writeFile(tokenPath, "", { encoding: "utf8" });
    vi.stubEnv("SANDBOX_RUNNER_TOKEN", token);
    vi.stubEnv("SANDBOX_RUNNER_TOKEN_FILE", tokenPath);
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);

    vi.stubEnv("SANDBOX_RUNNER_TOKEN", "");
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);

    delete process.env.SANDBOX_RUNNER_TOKEN;
    expect(() => startRunnerServer()).toThrow(RunnerConfigurationError);
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses a proxy URL when the egress allowlist is empty", () => {
    vi.stubEnv("SANDBOX_RUNNER_TOKEN", token);
    vi.stubEnv("SANDBOX_RUNNER_PORT", "8080");
    vi.stubEnv("SANDBOX_EGRESS_ALLOW", "[]");
    vi.stubEnv("SANDBOX_EGRESS_PROXY_URL", "http://sandbox-egress-proxy:3128");

    let caught: unknown;
    try {
      startRunnerServer();
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof RunnerConfigurationError)) {
      throw new Error("Expected the proxy-without-allowlist configuration error.");
    }
    expect(caught.code).toBe("proxy_url_without_allowlist");
    expect(caught.message).toBe("proxy_url_without_allowlist");
    expect(formatRunnerConfigurationError(caught)).toBe("proxy_url_without_allowlist\n");
  });
});

async function availablePort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Expected a TCP address.");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
  return address.port;
}
