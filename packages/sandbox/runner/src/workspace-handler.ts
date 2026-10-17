// SPDX-License-Identifier: Apache-2.0
import { randomInt } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Writable, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Id } from "@harness/schemas";
import {
  assertWorkspaceArchiveLimits,
  createWorkspaceArchive,
  SnapshotTooLargeError,
  WorkspaceSnapshotError,
} from "../../src/snapshot-archive.js";
import { restoreWorkspaceArchive } from "../../src/snapshot-restore.js";
import type { RunnerPayload, RunnerResponse } from "./request-handler.js";
import type { RunnerServerOptions } from "./server.js";
import type { RunnerLeaseManager } from "./lease.js";
import { withRunnerProcessLock } from "./process-lock.js";

const ID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

interface WorkspaceRequestContext {
  readonly options: RunnerServerOptions;
  readonly leases: RunnerLeaseManager;
  readonly setBusy: (busy: boolean) => void;
}

function nextTemporaryId(): Id {
  return Id.parse(
    Array.from({ length: 26 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)] ?? "0").join(""),
  );
}

async function hasWorkspace(root: string, runId: Id): Promise<boolean> {
  const info = await lstat(join(root, runId)).catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw new WorkspaceSnapshotError();
  });
  if (info === undefined) {
    return false;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new WorkspaceSnapshotError();
  }
  return true;
}

function responseWritable(response: RunnerResponse): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (response.write(chunk)) {
        callback();
      } else {
        response.once("drain", callback);
      }
    },
  });
}

function boundedArchive(archive: Readable, maxSnapshotBytes: number): Readable {
  let bytes = 0;
  return Readable.from(
    (async function* () {
      for await (const chunk of archive) {
        const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += data.byteLength;
        if (bytes > maxSnapshotBytes) {
          throw new SnapshotTooLargeError();
        }
        yield data;
      }
    })(),
  );
}

async function sendWorkspaceSnapshot(
  context: WorkspaceRequestContext,
  payload: Extract<RunnerPayload, { kind: "workspace-snapshot" }>,
  response: RunnerResponse,
): Promise<void> {
  const runRoot = join(context.options.workspaceRoot, payload.runId);
  await assertWorkspaceArchiveLimits(runRoot, payload.maxFileBytes, payload.maxSnapshotBytes);
  const archive = createWorkspaceArchive(runRoot);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.byteLength;
      callback(bytes > payload.maxSnapshotBytes ? new SnapshotTooLargeError() : null, chunk);
    },
  });
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "application/gzip",
  });
  const controller = new AbortController();
  response.once("close", () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  });
  await pipeline(archive, limit, responseWritable(response), { signal: controller.signal });
  response.end();
}

async function restoreWorkspace(
  context: WorkspaceRequestContext,
  payload: Extract<RunnerPayload, { kind: "workspace-restore" }>,
): Promise<void> {
  await restoreWorkspaceArchive({
    archive: boundedArchive(payload.archive, payload.maxSnapshotBytes),
    workspaceRoot: context.options.workspaceRoot,
    runId: payload.runId,
    temporaryId: nextTemporaryId(),
    maxFileBytes: payload.maxFileBytes,
    maxSnapshotBytes: payload.maxSnapshotBytes,
  });
}

/** Handles authenticated workspace transfers while retaining runner lease ownership. */
export async function handleWorkspacePayload(input: {
  readonly context: WorkspaceRequestContext;
  readonly payload: Extract<
    RunnerPayload,
    { kind: "workspace-snapshot" | "workspace-exists" | "workspace-restore" }
  >;
  readonly response: RunnerResponse;
  readonly sendJson: (response: RunnerResponse, status: number, body: unknown) => void;
  readonly sendError: (response: RunnerResponse, status: number, code: string) => void;
}): Promise<boolean> {
  const { context, payload, response, sendJson, sendError } = input;
  if (payload.kind === "workspace-exists") {
    try {
      sendJson(response, 200, {
        exists: await hasWorkspace(context.options.workspaceRoot, payload.runId),
      });
    } catch {
      sendError(response, 500, "sandbox_workspace_failed");
    }
    return true;
  }
  if (payload.kind === "workspace-snapshot") {
    try {
      if (!(await hasWorkspace(context.options.workspaceRoot, payload.runId))) {
        sendError(response, 404, "sandbox_workspace_not_found");
        return true;
      }
    } catch {
      sendError(response, 500, "sandbox_workspace_failed");
      return true;
    }
  }
  response.once("close", () => {
    if (!response.writableEnded) {
      if (payload.kind === "workspace-restore") {
        payload.archive.destroy();
      }
    }
  });
  try {
    const acquired = await context.leases.withWorkspaceLease(payload.runId, async () => {
      context.setBusy(true);
      try {
        await withRunnerProcessLock(async () => {
          if (payload.kind === "workspace-snapshot") {
            await sendWorkspaceSnapshot(context, payload, response);
          } else {
            await restoreWorkspace(context, payload);
            sendJson(response, 200, { status: "ok" });
          }
        });
      } finally {
        context.setBusy(false);
      }
    });
    if (!acquired) {
      sendError(response, 409, "sandbox_busy");
    }
  } catch (error) {
    if (response.headersSent) {
      response.destroy();
    } else {
      const oversized = error instanceof SnapshotTooLargeError;
      sendError(
        response,
        oversized ? 413 : 500,
        oversized ? "snapshot_too_large" : "sandbox_workspace_failed",
      );
    }
  }
  return true;
}
