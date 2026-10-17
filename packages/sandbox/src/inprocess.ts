// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import process from "node:process";
import { HarnessError, Id, type Code, type Id as IdValue } from "@harness/schemas";
import { ensureRunWorkspace, resolveWorkspacePath } from "./workspace.js";
import { WorkspaceFileSystem, WorkspaceFileError } from "./workspace-files.js";
import type { FsOperation, FsToolResult } from "./fs-tools.js";
import { ExecTimeoutMsSchema, MAX_EXEC_TIMEOUT_MS } from "./types.js";
import type { Clock, ExecResult, ExecSpec, SandboxBackend } from "./types.js";

export { resolveWorkspacePath, SandboxWorkspacePathError } from "./workspace.js";

const UNSAFE_LOG_CODE: Code = "sandbox_inprocess_unsafe";
const UNENFORCED_LIMITS_LOG_CODE: Code = "sandbox_inprocess_limits_unenforced";
const TRUSTED_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const DEFAULT_CLOCK: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Logger that accepts only a safe code and never receives command contents. */
export interface InProcessLogger {
  /** Emits stable in-process backend warning codes. */
  log(code: Code): void;
}

/** Configuration for the development-only local process backend. */
export interface InProcessBackendOptions {
  /** Trusted workspace root used to resolve every requested working directory. */
  readonly workspaceRoot: string;
  /** Explicitly permits the development backend in a production Node environment. */
  readonly allowUnsafeInProcess?: boolean;
  /** Maximum timeout this host permits for one execution; defaults to 300 seconds. */
  readonly maxTimeoutMs?: number;
  /** Clock used to measure duration and schedule timeout enforcement. */
  readonly clock?: Clock;
  /** Required safe-code logger notified whenever this backend starts. */
  readonly logger: InProcessLogger;
}

/** Error raised when the unsafe development backend is enabled in production. */
export class InProcessBackendError extends HarnessError {
  readonly code = "sandbox_inprocess_production";

  constructor() {
    super("The in-process sandbox backend is disabled in production.");
  }
}

class SandboxSpawnError extends HarnessError {
  readonly code = "sandbox_exec_spawn_failed";

  /** Create a closed error without exposing command or path contents. */
  constructor() {
    super("The command could not be started.");
  }
}

function spawnCommand(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv,
) {
  try {
    return spawn(command, args, {
      shell: false,
      detached: true,
      cwd,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new SandboxSpawnError();
  }
}

class CapturedOutput {
  readonly #maxBytes: number;
  readonly #stdout: Buffer[] = [];
  readonly #stderr: Buffer[] = [];
  #capturedBytes = 0;
  #stdoutBytes = 0;
  #stderrBytes = 0;
  #truncated = false;

  constructor(maxBytes: number) {
    this.#maxBytes = maxBytes;
  }

  add(stream: "stdout" | "stderr", chunk: Buffer): void {
    const chunks = stream === "stdout" ? this.#stdout : this.#stderr;
    if (stream === "stdout") {
      this.#stdoutBytes += chunk.byteLength;
    } else {
      this.#stderrBytes += chunk.byteLength;
    }
    const remaining = Math.max(0, this.#maxBytes - this.#capturedBytes);
    const captured = chunk.subarray(0, remaining);
    if (captured.byteLength > 0) {
      chunks.push(captured);
      this.#capturedBytes += captured.byteLength;
    }
    if (captured.byteLength < chunk.byteLength) {
      this.#truncated = true;
    }
  }

  result(): Pick<ExecResult, "stdout" | "stderr" | "stdoutBytes" | "stderrBytes" | "truncated"> {
    return {
      stdout: new TextDecoder().decode(Buffer.concat(this.#stdout), { stream: true }),
      stderr: new TextDecoder().decode(Buffer.concat(this.#stderr), { stream: true }),
      stdoutBytes: this.#stdoutBytes,
      stderrBytes: this.#stderrBytes,
      truncated: this.#truncated,
    };
  }
}

function killProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group may already have exited before the timeout or abort was observed.
  }
}

/**
 * Development-only backend. It enforces only outputBytes and timeoutMs locally; it does not
 * enforce memoryMb, pids, cpuSeconds, network, or filesystem restrictions and is not an
 * isolation boundary. Use the remote runner when those restrictions are required.
 */
export class InProcessBackend implements SandboxBackend {
  readonly #workspaceRoot: string;
  readonly #clock: Clock;
  readonly #maxTimeoutMs: number;
  readonly #workspaceFiles: WorkspaceFileSystem;

  /**
   * Create the local backend, recording its safety and unenforced-limit codes at startup.
   *
   * @param options - Workspace, opt-in, clock, and safe-code logger.
   * @throws InProcessBackendError if production use has not been explicitly enabled.
   */
  constructor(options: InProcessBackendOptions) {
    options.logger.log(UNSAFE_LOG_CODE);
    options.logger.log(UNENFORCED_LIMITS_LOG_CODE);
    if (process.env.NODE_ENV === "production" && options.allowUnsafeInProcess !== true) {
      throw new InProcessBackendError();
    }
    this.#workspaceRoot = options.workspaceRoot;
    this.#workspaceFiles = new WorkspaceFileSystem(options.workspaceRoot);
    this.#clock = options.clock ?? DEFAULT_CLOCK;
    this.#maxTimeoutMs = ExecTimeoutMsSchema.parse(options.maxTimeoutMs ?? MAX_EXEC_TIMEOUT_MS);
  }

  /** {@inheritDoc SandboxBackend.exec} */
  async exec(runId: Id, spec: ExecSpec, signal: AbortSignal): Promise<ExecResult> {
    const startedAt = this.#clock.now();
    if (signal.aborted) {
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
    const command = spec.argv[0];
    if (command === undefined || command.length === 0) {
      throw new SandboxSpawnError();
    }
    const projectRoot = await ensureRunWorkspace(this.#workspaceRoot, runId);
    const cwd = await resolveWorkspacePath(projectRoot, spec.cwd);
    const output = new CapturedOutput(spec.limits.outputBytes);
    const child = spawnCommand(command, spec.argv.slice(1), cwd, {
      ...spec.env,
      PATH: TRUSTED_PATH,
      TMPDIR: resolvePath(projectRoot, "..", ".harness", "tmp"),
    });

    return new Promise((resolve, reject) => {
      let timedOut = false;
      let spawnFailed = false;
      const cancelTimeout = this.#clock.schedule(
        () => {
          timedOut = true;
          if (child.pid !== undefined) {
            killProcessGroup(child.pid);
          }
        },
        Math.min(spec.timeoutMs, this.#maxTimeoutMs),
      );
      const abort = (): void => {
        if (child.pid !== undefined) {
          killProcessGroup(child.pid);
        }
      };
      child.stdout.on("data", (chunk: Buffer) => {
        output.add("stdout", chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        output.add("stderr", chunk);
      });
      child.stdin.on("error", () => undefined);
      child.once("error", () => {
        spawnFailed = true;
      });
      child.once("close", (exitCode, childSignal) => {
        cancelTimeout();
        if (child.pid !== undefined) {
          killProcessGroup(child.pid);
        }
        signal.removeEventListener("abort", abort);
        if (spawnFailed) {
          reject(new SandboxSpawnError());
          return;
        }
        resolve({
          exitCode,
          ...(childSignal === null ? {} : { signal: childSignal }),
          ...output.result(),
          timedOut,
          durationMs: Math.max(0, Math.round(this.#clock.now() - startedAt)),
        });
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
      }
      child.stdin.end(spec.stdin ?? "");
    });
  }

  /** Performs one shell-free workspace file operation for the active run. */
  async fileOperation(
    runId: IdValue,
    operation: FsOperation,
    input: unknown,
    signal: AbortSignal,
  ): Promise<FsToolResult> {
    if (signal.aborted) {
      throw new WorkspaceFileError("fs_operation_failed");
    }
    return this.#workspaceFiles.execute(Id.parse(runId), operation, input, signal);
  }
}
