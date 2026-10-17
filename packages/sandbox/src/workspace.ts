// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { HarnessError, Id, type Id as IdValue } from "@harness/schemas";
import { WorkspaceFileNotFoundError, WorkspacePathError } from "@harness/context";
import type { WorkspacePort, WorkspaceReadRange } from "@harness/context";
import type { Clock } from "./types.js";

const DEFAULT_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_RUN_QUOTA_BYTES = 500 * 1024 * 1024;
const DEFAULT_RECOUNT_INTERVAL_MS = 60_000;
const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};
const NOFOLLOW = constants.O_NOFOLLOW;
const NON_BLOCKING = constants.O_NONBLOCK;

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function assertDirectory(path: string): Promise<void> {
  const info = await lstat(path).catch(() => {
    throw new SandboxWorkspacePathError();
  });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new SandboxWorkspacePathError();
  }
}

/** Raised when a workspace write exceeds its per-file or per-run byte limit. */
export class WorkspaceQuotaExceededError extends HarnessError {
  readonly code = "workspace_quota_exceeded";

  constructor() {
    super("The workspace quota was exceeded.");
  }
}

/** Raised when the workspace path or file type is unsafe. */
export class SandboxWorkspacePathError extends HarnessError {
  readonly code = "sandbox_workspace_path_invalid";

  constructor() {
    super("The requested workspace path is invalid.");
  }
}

function isWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
  );
}

function validateRelativePath(value: string): void {
  const segments = value.split(/[\\/]/u);
  if (
    value.length > 4096 ||
    value.includes("\0") ||
    isAbsolute(value) ||
    win32.isAbsolute(value) ||
    /^[A-Za-z]:/u.test(value) ||
    segments.some((segment) => segment === ".." || segment.length > 255)
  ) {
    throw new SandboxWorkspacePathError();
  }
}

async function assertNoSymlinkComponents(root: string, candidate: string): Promise<void> {
  let current = root;
  for (const segment of relative(root, candidate)
    .split(sep)
    .filter((part) => part !== "")) {
    current = join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new SandboxWorkspacePathError();
      }
    } catch (error) {
      if (error instanceof SandboxWorkspacePathError) {
        throw error;
      }
      if (codeOf(error) !== "ENOENT") {
        throw new SandboxWorkspacePathError();
      }
    }
  }
}

async function resolveFinalPath(
  root: string,
  candidate: string,
  allowMissing: boolean,
): Promise<string> {
  try {
    const resolved = await realpath(candidate);
    if (!isWithin(root, resolved)) {
      throw new SandboxWorkspacePathError();
    }
    return resolved;
  } catch (error) {
    if (allowMissing && codeOf(error) === "ENOENT") {
      return candidate;
    }
    throw error instanceof SandboxWorkspacePathError ? error : new SandboxWorkspacePathError();
  }
}

/**
 * Resolves a workspace-relative path after validating its parent and every existing component.
 *
 * @param root - Trusted per-run workspace root.
 * @param workspacePath - Relative file or directory path.
 * @returns The canonical in-root path, or an in-root path whose final component does not exist yet.
 */
export async function resolveWorkspacePath(
  root: string,
  workspacePath = ".",
  options: { readonly allowMissing?: boolean } = {},
): Promise<string> {
  validateRelativePath(workspacePath);
  const realRoot = await realpath(root).catch(() => {
    throw new SandboxWorkspacePathError();
  });
  const candidate = resolve(realRoot, workspacePath);
  if (!isWithin(realRoot, candidate)) {
    throw new SandboxWorkspacePathError();
  }
  const parentPath = candidate === realRoot ? realRoot : dirname(candidate);
  const parent = await realpath(parentPath).catch(() => {
    throw new SandboxWorkspacePathError();
  });
  if (!isWithin(realRoot, parent)) {
    throw new SandboxWorkspacePathError();
  }
  await assertNoSymlinkComponents(realRoot, candidate);
  return resolveFinalPath(realRoot, candidate, options.allowMissing === true);
}

/** Ensures the documented project and private harness directories exist for a run. */
export async function ensureRunWorkspace(workspacesRoot: string, runId: IdValue): Promise<string> {
  const validatedRunId = Id.parse(runId);
  await mkdir(workspacesRoot, { recursive: true, mode: 0o750 });
  const realWorkspacesRoot = await realpath(workspacesRoot).catch(() => {
    throw new SandboxWorkspacePathError();
  });
  const runRoot = join(realWorkspacesRoot, validatedRunId);
  await mkdir(runRoot, { recursive: true, mode: 0o2750 });
  await assertDirectory(runRoot);
  for (const [directory, mode] of [
    [join(runRoot, "project"), 0o2770],
    [join(runRoot, ".harness"), 0o750],
    [join(runRoot, ".harness", "offload"), 0o2770],
    [join(runRoot, ".harness", "tmp"), 0o2770],
  ] as const) {
    await mkdir(directory, { recursive: true, mode });
    await assertDirectory(directory);
    const info = await lstat(directory);
    if ((info.mode & 0o7777) !== mode) {
      // mkdir applies the process umask (often 022), which would drop group write.
      await chmod(directory, mode);
    }
  }
  return join(runRoot, "project");
}

/** Removes only the run-specific scratch directory, leaving project and offload data intact. */
export async function clearRunScratch(
  workspacesRoot: string,
  runId: IdValue,
  removeTree: (path: string) => Promise<void> = (path) =>
    rm(path, { force: true, recursive: true }),
): Promise<void> {
  const validatedRunId = Id.parse(runId);
  const runRoot = join(await realpath(workspacesRoot), validatedRunId);
  await assertDirectory(runRoot);
  const harnessDirectory = join(runRoot, ".harness");
  await assertDirectory(harnessDirectory);
  const temporaryDirectory = join(harnessDirectory, "tmp");
  await assertDirectory(temporaryDirectory);
  for (const entry of await readdir(temporaryDirectory)) {
    await removeTree(join(temporaryDirectory, entry));
  }
}

/** Filesystem-backed offload workspace bound to one run and enforcing byte quotas. */
export class FsWorkspace implements WorkspacePort {
  #runRoot: string;
  readonly #workspaceRoot: string;
  readonly #runId: IdValue;
  readonly #maxFileBytes: number;
  readonly #quotaBytes: number;
  readonly #recountIntervalMs: number;
  readonly #clock: Clock;
  readonly #accountedFileSizes = new Map<string, number>();
  #usedBytes = 0;
  #lastRecount = Number.NEGATIVE_INFINITY;
  #ready: Promise<void> | undefined;
  #writes: Promise<void> = Promise.resolve();

  /**
   * Creates a workspace for one run.
   *
   * @param options - Shared workspace volume, run ID, quota, and clock settings.
   */
  constructor(options: {
    readonly workspaceRoot: string;
    readonly runId: IdValue;
    readonly maxFileBytes?: number;
    readonly quotaBytes?: number;
    readonly recountIntervalMs?: number;
    readonly clock?: Clock;
  }) {
    this.#runId = Id.parse(options.runId);
    this.#workspaceRoot = options.workspaceRoot;
    this.#runRoot = resolve(options.workspaceRoot, this.#runId);
    this.#maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.#quotaBytes = options.quotaBytes ?? DEFAULT_RUN_QUOTA_BYTES;
    this.#recountIntervalMs = options.recountIntervalMs ?? DEFAULT_RECOUNT_INTERVAL_MS;
    this.#clock = options.clock ?? DEFAULT_CLOCK;
    if (
      !Number.isSafeInteger(this.#maxFileBytes) ||
      this.#maxFileBytes < 0 ||
      !Number.isSafeInteger(this.#quotaBytes) ||
      this.#quotaBytes < 0 ||
      !Number.isSafeInteger(this.#recountIntervalMs) ||
      this.#recountIntervalMs < 0
    ) {
      throw new RangeError("Workspace limits must be non-negative safe integers.");
    }
  }

  /** {@inheritDoc WorkspacePort.write} */
  write(path: string, data: Uint8Array): Promise<void> {
    const write = this.#writes.then(() => this.#write(path, data));
    this.#writes = write.catch(() => undefined);
    return write;
  }

  async #write(path: string, data: Uint8Array): Promise<void> {
    if (data.byteLength > this.#maxFileBytes) {
      throw new WorkspaceQuotaExceededError();
    }
    await this.#ensureReady();
    const filePath = await this.#resolveOffloadPath(path, true);
    const accountedBytes = this.#accountedFileSizes.get(filePath) ?? 0;
    const nextBytes = this.#usedBytes - accountedBytes + data.byteLength;
    if (nextBytes > this.#quotaBytes) {
      throw new WorkspaceQuotaExceededError();
    }
    const handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW,
      0o660,
    ).catch(() => {
      throw new WorkspacePathError();
    });
    try {
      await handle.writeFile(data);
    } finally {
      await handle.close();
    }
    this.#usedBytes = nextBytes;
    this.#accountedFileSizes.set(filePath, data.byteLength);
  }

  /** {@inheritDoc WorkspacePort.read} */
  async read(path: string, range?: WorkspaceReadRange): Promise<Uint8Array> {
    await this.#ensureReady();
    if (range !== undefined) {
      if (
        !Number.isSafeInteger(range.offset) ||
        !Number.isSafeInteger(range.length) ||
        range.offset < 0 ||
        range.length < 0
      ) {
        throw new RangeError("Workspace read range must use non-negative safe integers.");
      }
    }
    const filePath = await this.#resolveOffloadPath(path, true);
    const handle = await open(filePath, constants.O_RDONLY | NOFOLLOW | NON_BLOCKING).catch(
      (error: unknown) => {
        if (codeOf(error) === "ENOENT") {
          throw new WorkspaceFileNotFoundError();
        }
        throw new WorkspacePathError();
      },
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        throw new WorkspacePathError();
      }
      if (info.size > this.#maxFileBytes) {
        throw new WorkspaceQuotaExceededError();
      }
      if (range === undefined) {
        return await handle.readFile();
      }
      const bytes = Buffer.alloc(Math.min(range.length, Math.max(0, info.size - range.offset)));
      let bytesRead = 0;
      while (bytesRead < bytes.byteLength) {
        const result = await handle.read(
          bytes,
          bytesRead,
          bytes.byteLength - bytesRead,
          range.offset + bytesRead,
        );
        if (result.bytesRead === 0) {
          break;
        }
        bytesRead += result.bytesRead;
      }
      return bytes.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  async #ensureReady(): Promise<void> {
    this.#ready ??= this.#assertReady().then(async () => {
      this.#usedBytes = await this.#recount();
      this.#lastRecount = this.#clock.now();
    });
    await this.#ready;
    if (this.#clock.now() - this.#lastRecount >= this.#recountIntervalMs) {
      this.#usedBytes = await this.#recount();
      this.#lastRecount = this.#clock.now();
    }
  }

  async #assertReady(): Promise<void> {
    this.#runRoot = await realpath(join(await realpath(this.#workspaceRoot), this.#runId));
    await assertDirectory(this.#runRoot);
    await assertDirectory(join(this.#runRoot, ".harness"));
    await assertDirectory(join(this.#runRoot, ".harness", "offload"));
  }

  async #resolveOffloadPath(path: string, allowMissing = false): Promise<string> {
    if (!path.startsWith(".harness/offload/")) {
      throw new WorkspacePathError();
    }
    const filename = path.slice(".harness/offload/".length);
    if (filename.length === 0 || /[\\/]/u.test(filename)) {
      throw new WorkspacePathError();
    }
    const resolved = await resolveWorkspacePath(this.#runRoot, path, { allowMissing });
    const offloadRoot = await realpath(join(this.#runRoot, ".harness", "offload"));
    if (!isWithin(offloadRoot, resolved)) {
      throw new WorkspacePathError();
    }
    return resolved;
  }

  async #recount(): Promise<number> {
    this.#accountedFileSizes.clear();
    const walk = async (directory: string): Promise<number> => {
      let total = 0;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) {
          throw new WorkspacePathError();
        }
        if (info.isDirectory()) {
          total += await walk(path);
        } else if (info.isFile()) {
          total += info.size;
          this.#accountedFileSizes.set(path, info.size);
        }
        if (total > this.#quotaBytes) {
          throw new WorkspaceQuotaExceededError();
        }
      }
      return total;
    };
    return walk(this.#runRoot);
  }
}

/** Activates a run's directory for the shared runner group. */
export async function activateRunWorkspace(
  workspacesRoot: string,
  runId: IdValue,
): Promise<string> {
  const project = await ensureRunWorkspace(workspacesRoot, runId);
  const runRoot = join(await realpath(workspacesRoot), Id.parse(runId));
  await chmod(runRoot, 0o2750);
  await chmod(join(runRoot, ".harness"), 0o750);
  return project;
}

/** Locks a completed run's top-level directory away from the execution group. */
export async function lockRunWorkspace(workspacesRoot: string, runId: IdValue): Promise<void> {
  const runRoot = join(await realpath(workspacesRoot), Id.parse(runId));
  await assertDirectory(runRoot);
  await chmod(runRoot, 0o700);
}

/** Locks every persisted run workspace after a runner restart. */
export async function sealPersistedRunWorkspaces(workspacesRoot: string): Promise<void> {
  const realRoot = await realpath(workspacesRoot).catch(() => {
    throw new SandboxWorkspacePathError();
  });
  if (((await stat(realRoot)).mode & 0o022) !== 0) {
    throw new SandboxWorkspacePathError();
  }
  for (const entry of await readdir(realRoot, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      throw new SandboxWorkspacePathError();
    }
    if (!entry.isDirectory() || !Id.safeParse(entry.name).success) {
      continue;
    }
    await lockRunWorkspace(realRoot, Id.parse(entry.name));
  }
}
