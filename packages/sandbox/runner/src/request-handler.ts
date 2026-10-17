// SPDX-License-Identifier: Apache-2.0
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { Id, parseJson } from "@harness/schemas";
import { z } from "zod";
import { ExecResultSchema, ExecSpecSchema } from "../../src/types.js";
import type { ExecResult, ExecSpec } from "../../src/types.js";
import {
  MAX_FS_REQUEST_TRANSPORT_BYTES,
  FsOperationRequestSchema,
  FsOperationSchema,
} from "../../src/fs-tools.js";
import type { FsOperationRequest } from "../../src/fs-tools.js";
import type { WorkspaceFileSystem } from "../../src/workspace-files.js";
import { WorkspaceFileError } from "../../src/workspace-file-helpers.js";
import { WebFetchRequestSchema } from "../../src/web-fetch-contracts.js";
import { executeRunnerFetch, WebFetchError } from "./web-fetch.js";
import type { RunnerServerOptions } from "./server.js";
import type { RunnerCredentialApi } from "./process-lock.js";

/** Maximum UTF-8 request body accepted by runner endpoints. */
export const MAX_RUNNER_REQUEST_BYTES = 2 * 1024 * 1024;

const RunnerExecRequestSchema = z.object({ runId: Id, spec: ExecSpecSchema }).strict();
const RunnerFetchRequestSchema = z.object({ runId: Id, request: WebFetchRequestSchema }).strict();
const RunnerFsRequestSchema = z.object({ runId: Id, request: FsOperationRequestSchema }).strict();
const RunnerLeaseRequestSchema = z
  .object({ runId: Id, ttlMs: z.number().int().positive().max(600_000).optional() })
  .strict();
const RunnerReleaseRequestSchema = z.object({ runId: Id }).strict();
const RunnerWorkspaceSnapshotRequestSchema = z
  .object({
    runId: Id,
    maxFileBytes: z.number().int().positive(),
    maxSnapshotBytes: z.number().int().positive(),
  })
  .strict();
const RunnerWorkspaceExistsRequestSchema = z.object({ runId: Id }).strict();

/** Minimal request shape used by the independently testable runner handler. */
export interface RunnerRequest extends AsyncIterable<Buffer | string> {
  readonly headers: Pick<IncomingMessage["headers"], "authorization" | "host" | "origin"> & {
    readonly "x-run-id"?: string;
    readonly "x-max-file-bytes"?: string;
    readonly "x-max-snapshot-bytes"?: string;
  };
  readonly method?: string | undefined;
  readonly url?: string | undefined;
  resume(): this;
}

/** Minimal response shape used by the independently testable runner handler. */
export interface RunnerResponse {
  readonly headersSent: boolean;
  readonly writableEnded: boolean;
  writeHead(status: number, headers: Record<string, string>): this;
  write(chunk: Buffer): boolean;
  end(body?: string): void;
  once(event: "close" | "drain", listener: () => void): this;
  destroy(): void;
}

/** Parsed, authenticated runner payload. */
export type RunnerPayload =
  | { readonly kind: "fetch"; readonly runId: z.infer<typeof Id>; readonly body: string }
  | {
      readonly kind: "fs";
      readonly runId: z.infer<typeof Id>;
      readonly request: FsOperationRequest;
    }
  | { readonly kind: "lease"; readonly runId: z.infer<typeof Id>; readonly ttlMs?: number }
  | { readonly kind: "release"; readonly runId: z.infer<typeof Id> }
  | {
      readonly kind: "workspace-snapshot";
      readonly runId: z.infer<typeof Id>;
      readonly maxFileBytes: number;
      readonly maxSnapshotBytes: number;
    }
  | { readonly kind: "workspace-exists"; readonly runId: z.infer<typeof Id> }
  | {
      readonly kind: "workspace-restore";
      readonly runId: z.infer<typeof Id>;
      readonly maxFileBytes: number;
      readonly maxSnapshotBytes: number;
      readonly archive: Readable;
    }
  | { readonly kind: "exec"; readonly runId: z.infer<typeof Id>; readonly spec: ExecSpec };
/** Runner payload kinds handled by the execution and fetch dispatcher. */
export type RunnerExecutionPayload = Extract<
  RunnerPayload,
  { readonly kind: "exec" | "fetch" | "fs" }
>;

type SendError = (response: RunnerResponse, status: number, code: string) => void;
type SendJson = (response: RunnerResponse, status: number, body: unknown) => void;
type IsAuthorized = (request: RunnerRequest) => boolean;
type ExecuteSpec = (
  runId: z.infer<typeof Id>,
  spec: ExecSpec,
  signal: AbortSignal,
) => Promise<ExecResult>;

interface ExecuteRunnerPayloadOptions {
  readonly options: RunnerServerOptions;
  readonly payload: RunnerExecutionPayload;
  readonly response: RunnerResponse;
  readonly signal: AbortSignal;
  readonly executeSpec: ExecuteSpec;
  readonly workspaceFiles: WorkspaceFileSystem;
  readonly executionUid: number | undefined;
  readonly executionGid: number | undefined;
  readonly credentials: RunnerCredentialApi;
  readonly sendJson: SendJson;
  readonly sendError: SendError;
}

async function readRequestBody(
  request: RunnerRequest,
  maxBytes: number,
): Promise<{ readonly body: string } | { readonly status: 400 | 413 }> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += data.byteLength;
    if (bytes > maxBytes) {
      request.resume();
      return { status: 413 };
    }
    chunks.push(data);
  }
  try {
    return { body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { status: 400 };
  }
}

function isSupportedRoute(method: string | undefined, path: string | undefined): boolean {
  if (method !== "POST") {
    return false;
  }
  if (
    path === "/exec" ||
    path === "/fetch" ||
    path === "/lease" ||
    path === "/release" ||
    path === "/workspace/snapshot" ||
    path === "/workspace/exists" ||
    path === "/workspace/restore"
  ) {
    return true;
  }
  return (
    path !== undefined &&
    path.startsWith("/fs/") &&
    FsOperationSchema.safeParse(path.slice("/fs/".length)).success
  );
}

function parseFilePayload(
  path: string,
  body: string,
  response: RunnerResponse,
  sendError: SendError,
): RunnerPayload | undefined {
  const operation = FsOperationSchema.parse(path.slice("/fs/".length));
  const parsed = parseJson(RunnerFsRequestSchema, body, {
    maxBytes: MAX_FS_REQUEST_TRANSPORT_BYTES,
  });
  if (parsed.request.operation !== operation) {
    sendError(response, 400, "sandbox_request_invalid");
    return undefined;
  }
  return { kind: "fs", runId: parsed.runId, request: parsed.request };
}

function parseRunnerBody(path: string | undefined, body: string): RunnerPayload {
  if (path === "/fetch") {
    const parsed = parseJson(RunnerFetchRequestSchema, body, {
      maxBytes: MAX_RUNNER_REQUEST_BYTES,
    });
    return { kind: "fetch", runId: parsed.runId, body };
  }
  if (path === "/lease") {
    const parsed = parseJson(RunnerLeaseRequestSchema, body, {
      maxBytes: MAX_RUNNER_REQUEST_BYTES,
    });
    return {
      kind: "lease",
      runId: parsed.runId,
      ...(parsed.ttlMs === undefined ? {} : { ttlMs: parsed.ttlMs }),
    };
  }
  if (path === "/release") {
    const parsed = parseJson(RunnerReleaseRequestSchema, body, {
      maxBytes: MAX_RUNNER_REQUEST_BYTES,
    });
    return { kind: "release", runId: parsed.runId };
  }
  if (path === "/workspace/snapshot") {
    const parsed = parseJson(RunnerWorkspaceSnapshotRequestSchema, body, {
      maxBytes: MAX_RUNNER_REQUEST_BYTES,
    });
    return { kind: "workspace-snapshot", ...parsed };
  }
  if (path === "/workspace/exists") {
    const parsed = parseJson(RunnerWorkspaceExistsRequestSchema, body, {
      maxBytes: MAX_RUNNER_REQUEST_BYTES,
    });
    return { kind: "workspace-exists", ...parsed };
  }
  const parsed = parseJson(RunnerExecRequestSchema, body, { maxBytes: MAX_RUNNER_REQUEST_BYTES });
  return { kind: "exec", runId: parsed.runId, spec: parsed.spec };
}

function parseWorkspaceRestore(request: RunnerRequest): RunnerPayload {
  const parsed = RunnerWorkspaceSnapshotRequestSchema.parse({
    runId: request.headers["x-run-id"],
    maxFileBytes: Number(request.headers["x-max-file-bytes"]),
    maxSnapshotBytes: Number(request.headers["x-max-snapshot-bytes"]),
  });
  return { kind: "workspace-restore", ...parsed, archive: Readable.from(request) };
}

/** Reads and validates the authenticated endpoint payload, writing bounded errors as needed. */
export async function readRunnerPayload(
  request: RunnerRequest,
  response: RunnerResponse,
  isAuthorized: IsAuthorized,
  sendError: SendError,
): Promise<RunnerPayload | undefined> {
  if (!isSupportedRoute(request.method, request.url)) {
    sendError(response, 404, "sandbox_route_not_found");
    return undefined;
  }
  if (!isAuthorized(request)) {
    sendError(response, 401, "sandbox_unauthorized");
    return undefined;
  }
  if (request.url === "/workspace/restore") {
    try {
      return parseWorkspaceRestore(request);
    } catch {
      request.resume();
      sendError(response, 400, "sandbox_request_invalid");
      return undefined;
    }
  }
  const body = await readRequestBody(
    request,
    request.url?.startsWith("/fs/") === true
      ? MAX_FS_REQUEST_TRANSPORT_BYTES
      : MAX_RUNNER_REQUEST_BYTES,
  );
  if ("status" in body) {
    sendError(
      response,
      body.status,
      body.status === 413 ? "sandbox_request_too_large" : "sandbox_request_invalid",
    );
    return undefined;
  }
  try {
    if (request.url?.startsWith("/fs/") === true) {
      return parseFilePayload(request.url, body.body, response, sendError);
    }
    return parseRunnerBody(request.url, body.body);
  } catch {
    sendError(response, 400, "sandbox_request_invalid");
    return undefined;
  }
}

function fetchFailure(error: unknown): { readonly status: number; readonly code: string } {
  if (!(error instanceof WebFetchError)) {
    return { status: 502, code: "sandbox_fetch_failed" };
  }
  const denied =
    error.code === "sandbox_fetch_denied" || error.code === "sandbox_fetch_egress_disabled";
  return { status: denied ? 403 : 502, code: error.code };
}

function fileOperationFailure(error: unknown): { readonly status: number; readonly code: string } {
  if (!(error instanceof WorkspaceFileError)) {
    return { status: 500, code: "fs_operation_failed" };
  }
  if (error.code === "fs_file_not_found") {
    return { status: 404, code: error.code };
  }
  if (error.code === "fs_file_exists" || error.code === "precondition_failed") {
    return { status: 409, code: error.code };
  }
  if (error.code === "workspace_quota_exceeded") {
    return { status: 413, code: error.code };
  }
  if (error.code === "edit_no_match" || error.code === "edit_ambiguous") {
    return { status: 422, code: error.code };
  }
  if (error.code.startsWith("fs_")) {
    return { status: 400, code: error.code };
  }
  return { status: 500, code: "fs_operation_failed" };
}

function setExecutionIdentity(
  credentials: RunnerCredentialApi,
  requested: { readonly uid: number | undefined; readonly gid: number | undefined },
  original: { readonly uid: number; readonly gid: number },
): void {
  if (requested.gid !== undefined && requested.gid !== original.gid) {
    credentials.setegid?.(requested.gid);
  }
  if (requested.uid !== undefined && requested.uid !== original.uid) {
    credentials.seteuid?.(requested.uid);
  }
}

function restoreExecutionIdentity(
  credentials: RunnerCredentialApi,
  original: { readonly uid: number; readonly gid: number },
  requested: { readonly uid: number; readonly gid: number },
): void {
  if (original.uid !== requested.uid) {
    credentials.seteuid?.(original.uid);
  }
  if (original.gid !== requested.gid) {
    credentials.setegid?.(original.gid);
  }
}

async function withExecutionIdentity<T>(
  uid: number | undefined,
  gid: number | undefined,
  credentials: RunnerCredentialApi,
  operation: () => Promise<T>,
): Promise<T> {
  const originalUid = credentials.geteuid();
  const originalGid = credentials.getegid();
  if (originalUid === undefined || originalGid === undefined) {
    return operation();
  }
  try {
    const original = { uid: originalUid, gid: originalGid };
    const requested = { uid, gid };
    setExecutionIdentity(credentials, requested, original);
    return await operation();
  } finally {
    restoreExecutionIdentity(
      credentials,
      { uid: originalUid, gid: originalGid },
      { uid: uid ?? originalUid, gid: gid ?? originalGid },
    );
  }
}

function executionFailure(
  payload: RunnerExecutionPayload,
  error: unknown,
): { readonly status: number; readonly code: string } {
  if (payload.kind === "fetch") {
    return fetchFailure(error);
  }
  if (payload.kind === "fs") {
    return fileOperationFailure(error);
  }
  return { status: 500, code: "sandbox_exec_failed" };
}

/** Executes a parsed runner request and maps failures to closed response codes. */
export async function executeRunnerPayload(input: ExecuteRunnerPayloadOptions): Promise<void> {
  const { options, payload, response, signal, executeSpec, sendJson, sendError } = input;
  try {
    if (payload.kind === "fetch") {
      sendJson(response, 200, await executeRunnerFetch(payload.body, options, signal));
      return;
    }
    if (payload.kind === "fs") {
      sendJson(
        response,
        200,
        await withExecutionIdentity(input.executionUid, input.executionGid, input.credentials, () =>
          input.workspaceFiles.execute(
            payload.runId,
            payload.request.operation,
            payload.request.input,
            signal,
          ),
        ),
      );
      return;
    }
    const result = ExecResultSchema.parse(await executeSpec(payload.runId, payload.spec, signal));
    sendJson(response, 200, result);
  } catch (error: unknown) {
    const failure = executionFailure(payload, error);
    sendError(response, failure.status, failure.code);
  }
}
