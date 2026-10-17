// SPDX-License-Identifier: Apache-2.0
import { Id, SandboxRunnerUrlSchema, parseJson } from "@harness/schemas";
import type { Id as IdValue } from "@harness/schemas";
import type { Readable } from "node:stream";
import { z } from "zod";
import { ExecResultSchema, MAX_EXEC_TIMEOUT_MS } from "./types.js";
import type { ExecResult, ExecSpec, SandboxBackend } from "./types.js";
import type { RemoteWorkspaceSnapshotPort } from "./snapshot.js";
import { RemoteSandboxError } from "./remote-errors.js";
import { RemoteWorkspaceClient } from "./remote-workspace.js";
export { RemoteSandboxError } from "./remote-errors.js";
import {
  FsOperationErrorCodeSchema,
  FsOperationRequestSchema,
  FsToolResultSchema,
  MAX_FS_TOOL_TIMEOUT_MS,
} from "./fs-tools.js";
import type { FsOperation, FsToolResult, WorkspaceFileToolBackend } from "./fs-tools.js";
import { WorkspaceFileError } from "./workspace-files.js";
import {
  MAX_WEB_FETCH_BYTES,
  MAX_WEB_FETCH_TIMEOUT_MS,
  WebFetchRequestSchema,
  WebFetchResultSchema,
} from "./web-fetch-contracts.js";
import type { WebFetchRequest, WebFetchResult } from "./web-fetch-contracts.js";

const RemoteOptionsSchema = z
  .object({
    url: SandboxRunnerUrlSchema,
    token: z.string().refine((token) => new TextEncoder().encode(token).byteLength >= 32),
    timeoutGraceMs: z.number().int().nonnegative().max(10_000).optional(),
  })
  .strict();
const RunnerLeaseResponseSchema = z.object({ status: z.literal("ok") }).strict();
const RunnerLeaseRequestSchema = z
  .object({
    runId: Id,
    ttlMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict();
const RunnerReleaseRequestSchema = z.object({ runId: Id }).strict();
/** Options for the authenticated HTTP sandbox backend. */
export interface RemoteSandboxBackendOptions {
  /** Base URL of the internal runner service. */
  readonly url: string;
  /** Resolved runner token; configuration stores this as a SecretRef. */
  readonly token: string;
  /** Extra time allowed for the runner to return after its command timeout. */
  readonly timeoutGraceMs?: number;
  /** Fetch implementation, injectable for tests. */
  readonly fetcher?: typeof fetch;
}

function wasAborted(candidate: AbortSignal): boolean {
  return candidate.aborted;
}

function abortedResult(): ExecResult {
  return {
    exitCode: null,
    signal: "SIGKILL",
    stdout: "",
    stderr: "",
    stdoutBytes: 0,
    stderrBytes: 0,
    truncated: false,
    timedOut: false,
    durationMs: 0,
  };
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let finished = false;
  try {
    while (!finished) {
      const chunk = await reader.read();
      if (chunk.done) {
        text += decoder.decode();
        finished = true;
      } else {
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          await reader.cancel();
          throw new RemoteSandboxError("sandbox_unavailable");
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    }
    return text;
  } finally {
    reader.releaseLock();
  }
}

/**
 * Implements {@link SandboxBackend} over the token-authenticated runner API.
 *
 * @param options - Internal runner URL, resolved token, and optional fetch settings.
 */
export class RemoteSandboxBackend
  implements SandboxBackend, WorkspaceFileToolBackend, RemoteWorkspaceSnapshotPort
{
  readonly #url: string;
  readonly #token: string;
  readonly #timeoutGraceMs: number;
  readonly #fetcher: typeof fetch;
  readonly #workspace: RemoteWorkspaceClient;

  constructor(options: RemoteSandboxBackendOptions) {
    const parsed = RemoteOptionsSchema.safeParse({
      url: options.url,
      token: options.token,
      timeoutGraceMs: options.timeoutGraceMs,
    });
    if (!parsed.success) {
      throw new RemoteSandboxError("sandbox_runner_config_invalid");
    }
    this.#url = new URL(parsed.data.url).origin;
    this.#token = parsed.data.token;
    this.#timeoutGraceMs = parsed.data.timeoutGraceMs ?? 1000;
    this.#fetcher = options.fetcher ?? fetch;
    this.#workspace = new RemoteWorkspaceClient({
      url: this.#url,
      token: this.#token,
      timeoutGraceMs: this.#timeoutGraceMs,
      fetcher: this.#fetcher,
    });
  }

  /** Acquires or renews the runner lease for a run. */
  async acquireLease(runId: IdValue, ttlMs = 10 * 60 * 1000): Promise<void> {
    const lease = RunnerLeaseRequestSchema.safeParse({ runId, ttlMs });
    if (!lease.success) {
      throw new RemoteSandboxError("sandbox_runner_config_invalid");
    }
    await this.#requestLease("/lease", lease.data);
  }

  /** Releases the runner lease for a run. */
  async releaseLease(runId: IdValue): Promise<void> {
    const release = RunnerReleaseRequestSchema.safeParse({ runId });
    if (!release.success) {
      throw new RemoteSandboxError("sandbox_runner_config_invalid");
    }
    await this.#requestLease("/release", release.data);
  }

  /** Streams a runner-owned workspace archive into the local snapshot store. */
  async createArchive(
    runId: IdValue,
    maxFileBytes: number,
    maxSnapshotBytes: number,
  ): Promise<Readable> {
    return this.#workspace.createArchive(runId, maxFileBytes, maxSnapshotBytes);
  }

  /** Safely streams a verified snapshot into the runner-owned workspace. */
  async restoreArchive(
    runId: IdValue,
    archive: Readable,
    maxFileBytes: number,
    maxSnapshotBytes: number,
  ): Promise<void> {
    return this.#workspace.restoreArchive(runId, archive, maxFileBytes, maxSnapshotBytes);
  }

  /** Checks for a real workspace without activating or creating it. */
  async hasWorkspace(runId: IdValue): Promise<boolean> {
    return this.#workspace.hasWorkspace(runId);
  }

  async #requestLease(path: "/lease" | "/release", body: unknown): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, 10_000);
    try {
      const response = await this.#fetcher(new URL(path, this.#url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: ["Bearer", this.#token].join(" "),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (response.status === 409) {
        throw new RemoteSandboxError("sandbox_busy");
      }
      if (!response.ok) {
        throw new RemoteSandboxError("sandbox_unavailable");
      }
      const text = await readBoundedResponse(response, 1024);
      parseJson(RunnerLeaseResponseSchema, text, { maxBytes: 1024 });
    } catch (error) {
      if (error instanceof RemoteSandboxError) {
        throw error;
      }
      throw new RemoteSandboxError("sandbox_unavailable");
    } finally {
      clearTimeout(timer);
    }
  }

  /** {@inheritDoc SandboxBackend.exec} */
  async exec(runId: Id, spec: ExecSpec, signal: AbortSignal): Promise<ExecResult> {
    if (signal.aborted) {
      return abortedResult();
    }
    const controller = new AbortController();
    const timeoutReason = new DOMException("The sandbox request timed out.", "TimeoutError");
    const timeoutMs = Math.min(
      MAX_EXEC_TIMEOUT_MS + this.#timeoutGraceMs,
      spec.timeoutMs + this.#timeoutGraceMs,
    );
    const timer = setTimeout(() => {
      controller.abort(timeoutReason);
    }, timeoutMs);
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      const response = await this.#fetcher(new URL("/exec", this.#url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: ["Bearer", this.#token].join(" "),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ runId, spec }),
        signal: controller.signal,
      });
      if (response.status === 409) {
        throw new RemoteSandboxError("sandbox_busy");
      }
      if (response.status === 408 || response.status === 504) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      if (!response.ok) {
        throw new RemoteSandboxError("sandbox_unavailable");
      }
      const maxResponseBytes = Math.min(
        Number.MAX_SAFE_INTEGER,
        spec.limits.outputBytes * 6 + 1_048_576,
      );
      return parseJson(ExecResultSchema, await readBoundedResponse(response, maxResponseBytes), {
        maxBytes: maxResponseBytes,
      });
    } catch (error) {
      if (error instanceof RemoteSandboxError) {
        throw error;
      }
      if (controller.signal.reason === timeoutReason) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      if (wasAborted(signal)) {
        return abortedResult();
      }
      throw new RemoteSandboxError("sandbox_unavailable");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  /** Fetches allowlisted content through the runner's authenticated `/fetch` endpoint. */
  async fetch(runId: Id, request: WebFetchRequest, signal: AbortSignal): Promise<WebFetchResult> {
    const parsed = WebFetchRequestSchema.safeParse(request);
    if (!parsed.success) {
      throw new RemoteSandboxError("sandbox_runner_config_invalid");
    }
    if (signal.aborted) {
      throw new RemoteSandboxError("sandbox_timeout");
    }
    const controller = new AbortController();
    const timeoutReason = new DOMException("The sandbox fetch timed out.", "TimeoutError");
    const timeoutMs = MAX_WEB_FETCH_TIMEOUT_MS + this.#timeoutGraceMs;
    const timer = setTimeout(() => {
      controller.abort(timeoutReason);
    }, timeoutMs);
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener("abort", abort, { once: true });

    try {
      const response = await this.#fetcher(new URL("/fetch", this.#url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: ["Bearer", this.#token].join(" "),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ runId, request: parsed.data }),
        signal: controller.signal,
      });
      if (response.status === 409) {
        throw new RemoteSandboxError("sandbox_busy");
      }
      if (response.status === 408 || response.status === 504) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      if (!response.ok) {
        throw new RemoteSandboxError("sandbox_unavailable");
      }
      const maxResponseBytes = MAX_WEB_FETCH_BYTES * 6 + 1_048_576;
      return parseJson(
        WebFetchResultSchema,
        await readBoundedResponse(response, maxResponseBytes),
        { maxBytes: maxResponseBytes },
      );
    } catch (error) {
      if (error instanceof RemoteSandboxError) {
        throw error;
      }
      if (controller.signal.reason === timeoutReason) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      if (wasAborted(signal)) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      throw new RemoteSandboxError("sandbox_unavailable");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }

  /** Performs a workspace file operation through the authenticated runner endpoint. */
  async fileOperation(
    runId: IdValue,
    operation: FsOperation,
    input: unknown,
    signal: AbortSignal,
  ): Promise<FsToolResult> {
    const parsed = FsOperationRequestSchema.safeParse({ operation, input });
    if (!parsed.success) {
      throw new WorkspaceFileError("fs_invalid_input");
    }
    if (signal.aborted) {
      throw new RemoteSandboxError("sandbox_timeout");
    }
    const controller = new AbortController();
    const timeoutReason = new DOMException("The sandbox file request timed out.", "TimeoutError");
    const timer = setTimeout(() => {
      controller.abort(timeoutReason);
    }, MAX_FS_TOOL_TIMEOUT_MS + this.#timeoutGraceMs);
    const abort = (): void => {
      controller.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.#fetcher(new URL(`/fs/${operation}`, this.#url), {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: ["Bearer", this.#token].join(" "),
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify({ runId: Id.parse(runId), request: parsed.data }),
        signal: controller.signal,
      });
      if (response.status === 408 || response.status === 504) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      const maxResponseBytes = 8 * 1024 * 1024;
      const responseText = await readBoundedResponse(response, maxResponseBytes);
      if (!response.ok) {
        const failure = parseJson(
          z
            .object({
              code: FsOperationErrorCodeSchema.or(z.literal("sandbox_busy")),
            })
            .strict(),
          responseText,
          { maxBytes: maxResponseBytes },
        );
        if (failure.code === "sandbox_busy") {
          throw new RemoteSandboxError("sandbox_busy");
        }
        throw new WorkspaceFileError(failure.code);
      }
      return parseJson(FsToolResultSchema, responseText, { maxBytes: maxResponseBytes });
    } catch (error) {
      if (error instanceof WorkspaceFileError || error instanceof RemoteSandboxError) {
        throw error;
      }
      if (controller.signal.reason === timeoutReason) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      if (wasAborted(signal)) {
        throw new RemoteSandboxError("sandbox_timeout");
      }
      throw new RemoteSandboxError("sandbox_unavailable");
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    }
  }
}
