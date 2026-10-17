// SPDX-License-Identifier: Apache-2.0
import { lstat } from "node:fs/promises";
import type { Id } from "@harness/schemas";
import { ensureRunWorkspace } from "./workspace.js";
import {
  MAX_FS_READ_BYTES,
  MAX_FS_WRITE_BYTES,
  FsEditInputSchema,
  FsListInputSchema,
  FsReadInputSchema,
  FsSearchInputSchema,
  FsWriteInputSchema,
} from "./fs-tools.js";
import type {
  FsEditInput,
  FsListEntry,
  FsListInput,
  FsOperation,
  FsReadInput,
  FsSearchInput,
  FsToolResult,
  FsWriteInput,
} from "./fs-tools.js";
import {
  assertActive,
  decodeText,
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_RUN_QUOTA_BYTES,
  EMPTY_SHA256,
  fileAt,
  projectPath,
  readFileSnapshotAt,
  readTextRangeAt,
  sha256,
  WorkspaceFileError,
  writeFileAt,
} from "./workspace-file-helpers.js";
import { countWorkspaceBytes } from "./workspace-file-quota.js";
import { listEntries, searchDirectory, searchFile } from "./workspace-file-search.js";
import type { SearchMatch } from "./workspace-file-search.js";
export { WorkspaceFileError } from "./workspace-file-helpers.js";

function validateWritePrecondition(
  input: FsWriteInput,
  current: Awaited<ReturnType<typeof fileAt>>,
  bytes: Uint8Array,
): void {
  if (input.mode === "create" && current.exists && input.expectedSha256 === undefined) {
    throw new WorkspaceFileError("fs_file_exists");
  }
  if (input.mode === "overwrite" && !current.exists) {
    throw new WorkspaceFileError("fs_file_not_found");
  }
  if (input.expectedSha256 === undefined) {
    return;
  }
  const currentHash = current.exists ? sha256(current.bytes) : EMPTY_SHA256;
  if (
    currentHash !== input.expectedSha256 ||
    (input.mode === "create" && current.exists) ||
    sha256(bytes) === input.expectedSha256
  ) {
    throw new WorkspaceFileError("precondition_failed");
  }
}

/**
 * Provides quota-checked, symlink-safe workspace file operations for one backend.
 *
 * @param workspaceRoot - Shared run workspace parent directory.
 */
export class WorkspaceFileSystem {
  readonly #workspaceRoot: string;
  readonly #mutations = new Map<string, Promise<void>>();

  /** Creates an operation service bound to the shared workspaces directory. */
  constructor(workspaceRoot: string) {
    this.#workspaceRoot = workspaceRoot;
  }

  /** Runs one validated workspace operation for the requested run. */
  async execute(
    runId: Id,
    operation: FsOperation,
    input: unknown,
    signal: AbortSignal,
  ): Promise<FsToolResult> {
    assertActive(signal);
    switch (operation) {
      case "read":
        return this.#read(runId, FsReadInputSchema.parse(input), signal);
      case "write":
        return this.#mutate(runId, signal, () =>
          this.#write(runId, FsWriteInputSchema.parse(input), signal),
        );
      case "edit":
        return this.#mutate(runId, signal, () =>
          this.#edit(runId, FsEditInputSchema.parse(input), signal),
        );
      case "list":
        return this.#list(runId, FsListInputSchema.parse(input), signal);
      case "search":
        return this.#search(runId, FsSearchInputSchema.parse(input), signal);
    }
  }

  async #projectRoot(runId: Id): Promise<string> {
    try {
      return await ensureRunWorkspace(this.#workspaceRoot, runId);
    } catch {
      throw new WorkspaceFileError("fs_path_invalid");
    }
  }

  async #read(runId: Id, input: FsReadInput, signal: AbortSignal): Promise<FsToolResult> {
    const root = await this.#projectRoot(runId);
    const path = await projectPath(root, input.path, true);
    const range = await readTextRangeAt(path, input.offset ?? 0, input.length ?? MAX_FS_READ_BYTES);
    assertActive(signal);
    if (range.binary) {
      return { binary: true, bytes: range.fileBytes };
    }
    return {
      binary: false,
      bytes: range.bytes,
      content: range.content,
      offset: range.offset,
      path: input.path,
    };
  }

  async #write(runId: Id, input: FsWriteInput, signal: AbortSignal): Promise<FsToolResult> {
    const bytes = new TextEncoder().encode(input.content);
    if (bytes.byteLength > MAX_FS_WRITE_BYTES) {
      throw new WorkspaceFileError("fs_invalid_input");
    }
    const root = await this.#projectRoot(runId);
    const path = await projectPath(root, input.path, true);
    const current = await fileAt(path);
    validateWritePrecondition(input, current, bytes);
    const usedBytes = await countWorkspaceBytes(root, signal);
    const replacedBytes = current.exists ? current.bytes.byteLength : 0;
    if (usedBytes - replacedBytes + bytes.byteLength > DEFAULT_RUN_QUOTA_BYTES) {
      throw new WorkspaceFileError("workspace_quota_exceeded");
    }
    await writeFileAt(path, bytes, {
      mode: input.mode,
      signal,
      ...(current.exists ? { expectedIdentity: current.identity } : {}),
    });
    return {
      bytes: bytes.byteLength,
      path: input.path,
      sha256: sha256(bytes),
    };
  }

  async #edit(runId: Id, input: FsEditInput, signal: AbortSignal): Promise<FsToolResult> {
    const root = await this.#projectRoot(runId);
    const path = await projectPath(root, input.path, true);
    const snapshot = await readFileSnapshotAt(path);
    const original = snapshot.bytes;
    if (input.expectedSha256 !== undefined && sha256(original) !== input.expectedSha256) {
      throw new WorkspaceFileError("precondition_failed");
    }
    const decoded = decodeText(original);
    if (decoded === undefined) {
      throw new WorkspaceFileError("fs_not_file");
    }
    let content = decoded;
    for (const edit of input.edits) {
      const start = content.indexOf(edit.oldText);
      if (start < 0) {
        throw new WorkspaceFileError("edit_no_match");
      }
      if (content.includes(edit.oldText, start + 1)) {
        throw new WorkspaceFileError("edit_ambiguous");
      }
      content = `${content.slice(0, start)}${edit.newText}${content.slice(start + edit.oldText.length)}`;
    }
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > DEFAULT_MAX_FILE_BYTES) {
      throw new WorkspaceFileError("workspace_quota_exceeded");
    }
    if (input.expectedSha256 !== undefined && sha256(bytes) === input.expectedSha256) {
      throw new WorkspaceFileError("precondition_failed");
    }
    const usedBytes = await countWorkspaceBytes(root, signal);
    if (usedBytes - original.byteLength + bytes.byteLength > DEFAULT_RUN_QUOTA_BYTES) {
      throw new WorkspaceFileError("workspace_quota_exceeded");
    }
    await writeFileAt(path, bytes, {
      mode: "overwrite",
      signal,
      expectedIdentity: snapshot.identity,
    });
    return {
      bytes: bytes.byteLength,
      path: input.path,
      sha256: sha256(bytes),
    };
  }

  async #list(runId: Id, input: FsListInput, signal: AbortSignal): Promise<FsToolResult> {
    const root = await this.#projectRoot(runId);
    const directory = await projectPath(root, input.path);
    const info = await lstat(directory);
    if (!info.isDirectory()) {
      throw new WorkspaceFileError("fs_not_directory");
    }
    const entries: FsListEntry[] = [];
    const truncated = await listEntries(directory, {
      root,
      prefix: input.path,
      remainingDepth: input.depth,
      limit: input.limit,
      entries,
      signal,
    });
    return { entries: entries.slice(0, input.limit), truncated };
  }

  async #search(runId: Id, input: FsSearchInput, signal: AbortSignal): Promise<FsToolResult> {
    const root = await this.#projectRoot(runId);
    const searchPath = input.path ?? ".";
    const resolved = await projectPath(root, searchPath);
    const info = await lstat(resolved);
    const matches: SearchMatch[] = [];
    const expression = input.regex ? new RegExp(input.query, "u") : undefined;
    const matcher =
      expression === undefined
        ? (line: string) => line.includes(input.query)
        : (line: string) => expression.test(line);
    let truncated: boolean;
    if (info.isDirectory()) {
      truncated = await searchDirectory(resolved, {
        root,
        prefix: searchPath,
        matcher,
        limit: input.limit,
        matches,
        signal,
        state: { filesVisited: 0, bytesScanned: 0 },
      });
    } else if (info.isFile()) {
      truncated = await searchFile(resolved, searchPath, {
        root,
        prefix: searchPath,
        matcher,
        limit: input.limit,
        matches,
        signal,
        state: { filesVisited: 0, bytesScanned: 0 },
      });
    } else {
      throw new WorkspaceFileError("fs_not_file");
    }
    return { matches: matches.slice(0, input.limit), truncated };
  }

  async #mutate(
    runId: Id,
    signal: AbortSignal,
    mutation: () => Promise<FsToolResult>,
  ): Promise<FsToolResult> {
    const key = `${this.#workspaceRoot}:${runId}`;
    const previous = this.#mutations.get(key) ?? Promise.resolve();
    let release = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.#mutations.set(key, queued);
    await previous;
    try {
      assertActive(signal);
      return await mutation();
    } finally {
      release();
      if (this.#mutations.get(key) === queued) {
        this.#mutations.delete(key);
      }
    }
  }
}
