// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink, link, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import process from "node:process";
import { dirname, join } from "node:path";
import { HarnessError } from "@harness/schemas";
import { resolveWorkspacePath } from "./workspace.js";
import type { FsOperationErrorCode } from "./fs-tools.js";

export const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DEFAULT_RUN_QUOTA_BYTES = 500 * 1024 * 1024;
const NOFOLLOW = constants.O_NOFOLLOW;
const NON_BLOCKING = constants.O_NONBLOCK;
export const EMPTY_SHA256 = createHash("sha256").update(new Uint8Array()).digest("hex");
let temporaryFileSequence = 0;

/** Stable file metadata used to revalidate an atomic workspace mutation. */
export interface WorkspaceFileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mtimeMs: number;
  readonly size: number;
  readonly mode: number;
}

/** File bytes paired with the identity observed while reading them. */
export interface WorkspaceFileSnapshot {
  readonly bytes: Buffer;
  readonly identity: WorkspaceFileIdentity;
}

/** Captures identity for a regular file while rejecting hard-link aliases. */
export function fileIdentity(info: Stats): WorkspaceFileIdentity {
  if (info.nlink > 1) {
    throw new WorkspaceHardLinkError();
  }
  return {
    dev: info.dev,
    ino: info.ino,
    mtimeMs: info.mtimeMs,
    size: info.size,
    mode: info.mode,
  };
}

/** Compares the stable identity fields used to protect a mutation precondition. */
function sameFile(left: WorkspaceFileIdentity, right: WorkspaceFileIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

/** Raised when a workspace file operation is invalid or cannot be completed safely. */
export class WorkspaceFileError extends HarnessError {
  readonly code: FsOperationErrorCode;

  /** Creates a safe workspace operation failure. */
  constructor(code: FsOperationErrorCode) {
    super("The workspace file operation failed.");
    this.code = code;
  }
}

/** Marks a hard-link rejection so recursive search can skip only that case. */
export class WorkspaceHardLinkError extends WorkspaceFileError {
  constructor() {
    super("fs_path_invalid");
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

/** Throws the closed operation failure code when cancellation has been requested. */
export function assertActive(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new WorkspaceFileError("fs_operation_failed");
  }
}

/** Returns the lowercase SHA-256 digest of file bytes. */
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertProjectPath(path: string): void {
  if (path.split(/[\\/]/u).some((part) => part === ".harness")) {
    throw new WorkspaceFileError("fs_path_invalid");
  }
}

/** Resolves an allowed path under the project root, optionally allowing a missing leaf. */
export async function projectPath(
  root: string,
  path: string,
  allowMissing = false,
): Promise<string> {
  assertProjectPath(path);
  try {
    return await resolveWorkspacePath(root, path, { allowMissing });
  } catch {
    throw new WorkspaceFileError("fs_path_invalid");
  }
}

/** Reads a regular, bounded file without following a final symlink or hard-link alias. */
export async function readFileSnapshotAt(path: string): Promise<WorkspaceFileSnapshot> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW | NON_BLOCKING);
  } catch (error) {
    throw new WorkspaceFileError(
      errorCode(error) === "ENOENT" ? "fs_file_not_found" : "fs_path_invalid",
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new WorkspaceFileError("fs_not_file");
    }
    const identity = fileIdentity(info);
    if (info.size > DEFAULT_MAX_FILE_BYTES) {
      throw new WorkspaceFileError("workspace_quota_exceeded");
    }
    return { bytes: await handle.readFile(), identity };
  } finally {
    await handle.close();
  }
}

/** Reads a regular, bounded file without following a final symlink or hard-link alias. */
export async function readFileAt(path: string): Promise<Buffer> {
  return (await readFileSnapshotAt(path)).bytes;
}

/** Reads a UTF-8 range while returning only bytes consumed at character boundaries. */
export async function readTextRangeAt(
  path: string,
  requestedOffset: number,
  requestedLength: number,
): Promise<
  | { readonly binary: true; readonly fileBytes: number }
  | {
      readonly binary: false;
      readonly fileBytes: number;
      readonly bytes: number;
      readonly content: string;
      readonly offset: number;
    }
> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW | NON_BLOCKING);
  } catch (error) {
    throw new WorkspaceFileError(
      errorCode(error) === "ENOENT" ? "fs_file_not_found" : "fs_path_invalid",
    );
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      throw new WorkspaceFileError("fs_not_file");
    }
    fileIdentity(info);
    if (info.size > DEFAULT_MAX_FILE_BYTES) {
      throw new WorkspaceFileError("workspace_quota_exceeded");
    }
    const sniffLength = Math.min(info.size, 8192);
    const sniff = Buffer.alloc(sniffLength);
    const sniffResult = await handle.read(sniff, 0, sniffLength, 0);
    const sample = sniff.subarray(0, sniffResult.bytesRead);
    if (isBinarySample(sample, sniffResult.bytesRead < info.size)) {
      return { binary: true, fileBytes: info.size };
    }
    const offset = await alignUtf8Offset(handle, requestedOffset, info.size);
    if (requestedLength === 0) {
      return { binary: false, fileBytes: info.size, bytes: 0, content: "", offset };
    }
    const rangeLength = Math.min(info.size - offset, requestedLength + 3);
    const range = Buffer.alloc(rangeLength);
    const result = await handle.read(range, 0, rangeLength, offset);
    let consumed = Math.min(result.bytesRead, requestedLength);
    while (consumed > 0 && decodeText(range.subarray(0, consumed)) === undefined) {
      consumed -= 1;
    }
    const content = decodeText(range.subarray(0, consumed));
    if (content === undefined) {
      return { binary: true, fileBytes: info.size };
    }
    return {
      binary: false,
      fileBytes: info.size,
      bytes: consumed,
      content,
      offset,
    };
  } finally {
    await handle.close();
  }
}

function isBinarySample(sample: Buffer, mayBeTruncated: boolean): boolean {
  return sample.includes(0) || decodeUtf8Prefix(sample, mayBeTruncated) === undefined;
}

async function alignUtf8Offset(
  handle: FileHandle,
  requestedOffset: number,
  fileSize: number,
): Promise<number> {
  let offset = Math.min(requestedOffset, fileSize);
  const prefixLength = Math.min(3, fileSize - offset);
  if (prefixLength > 0) {
    const prefix = Buffer.alloc(prefixLength);
    const result = await handle.read(prefix, 0, prefixLength, offset);
    let skip = 0;
    while (skip < result.bytesRead && (prefix[skip] ?? 0) >= 0x80 && (prefix[skip] ?? 0) <= 0xbf) {
      skip += 1;
    }
    offset += skip;
  }
  return offset;
}

/** Decodes a UTF-8 prefix, dropping an incomplete trailing code point only at a bounded edge. */
export function decodeUtf8Prefix(bytes: Uint8Array, mayBeTruncated: boolean): string | undefined {
  const content = decodeText(bytes);
  if (content !== undefined || !mayBeTruncated) {
    return content;
  }
  for (let suffix = 1; suffix <= 3 && suffix <= bytes.byteLength; suffix += 1) {
    const prefix = decodeText(bytes.subarray(0, bytes.byteLength - suffix));
    if (prefix !== undefined) {
      return prefix;
    }
  }
  return undefined;
}

/** Reads a file if present, returning a discriminated missing-file result. */
export async function fileAt(
  path: string,
): Promise<
  | { readonly bytes: Buffer; readonly exists: true; readonly identity: WorkspaceFileIdentity }
  | { readonly exists: false }
> {
  try {
    const snapshot = await readFileSnapshotAt(path);
    return { exists: true, ...snapshot };
  } catch (error) {
    if (error instanceof WorkspaceFileError && error.code === "fs_file_not_found") {
      return { exists: false };
    }
    throw error;
  }
}

/** Decodes valid UTF-8 text, returning undefined for binary or invalid byte sequences. */
export function decodeText(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

interface WriteFileOptions {
  readonly mode: "create" | "overwrite";
  readonly signal: AbortSignal;
  readonly expectedIdentity?: WorkspaceFileIdentity;
  readonly onTemporaryFileCreated?: () => void;
}

async function createTemporaryFile(
  path: string,
  expectedIdentity: WorkspaceFileIdentity | undefined,
): Promise<{ readonly handle: FileHandle; readonly path: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    temporaryFileSequence += 1;
    const candidatePath = join(
      dirname(path),
      `.harness-fs-${String(process.pid)}-${String(temporaryFileSequence)}`,
    );
    let handle: FileHandle;
    try {
      handle = await open(
        candidatePath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW | NON_BLOCKING,
        expectedIdentity === undefined ? 0o660 : expectedIdentity.mode & 0o777,
      );
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        continue;
      }
      throw error;
    }
    try {
      if (expectedIdentity !== undefined) {
        await handle.chmod(expectedIdentity.mode & 0o777);
      }
      return { handle, path: candidatePath };
    } catch (error) {
      await handle.close();
      await unlink(candidatePath).catch(() => undefined);
      throw error;
    }
  }
  throw new WorkspaceFileError("fs_operation_failed");
}

async function publishTemporaryFile(
  temporaryPath: string,
  path: string,
  options: WriteFileOptions,
): Promise<void> {
  const target = await lstat(path).catch((error: unknown) => {
    if (errorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (options.mode === "create") {
    if (target !== undefined) {
      throw new WorkspaceFileError("fs_file_exists");
    }
    try {
      await link(temporaryPath, path);
    } catch (error) {
      if (errorCode(error) === "EEXIST") {
        throw new WorkspaceFileError("fs_file_exists");
      }
      throw error;
    }
    await unlink(temporaryPath);
    return;
  }
  if (target === undefined) {
    throw new WorkspaceFileError("fs_file_not_found");
  }
  if (!target.isFile()) {
    throw new WorkspaceFileError("fs_not_file");
  }
  const currentIdentity = fileIdentity(target);
  if (
    options.expectedIdentity === undefined ||
    !sameFile(currentIdentity, options.expectedIdentity)
  ) {
    throw new WorkspaceFileError("precondition_failed");
  }
  await rename(temporaryPath, path);
}

/** Atomically creates or replaces a regular file after validating its prior identity. */
export async function writeFileAt(
  path: string,
  bytes: Uint8Array,
  options: WriteFileOptions,
): Promise<void> {
  let handle: FileHandle | undefined;
  let temporaryPath: string | undefined;
  try {
    const temporary = await createTemporaryFile(path, options.expectedIdentity);
    handle = temporary.handle;
    temporaryPath = temporary.path;
    options.onTemporaryFileCreated?.();
    assertActive(options.signal);
    await handle.writeFile(bytes, { signal: options.signal });
    await handle.sync();
    await handle.close();
    handle = undefined;
    assertActive(options.signal);
    await publishTemporaryFile(temporaryPath, path, options);
    temporaryPath = undefined;
  } finally {
    if (handle !== undefined) {
      await handle.close();
    }
    if (temporaryPath !== undefined) {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }
}
