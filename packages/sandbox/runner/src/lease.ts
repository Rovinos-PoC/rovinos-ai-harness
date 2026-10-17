// SPDX-License-Identifier: Apache-2.0
import { spawn } from "node:child_process";
import process from "node:process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Id as IdValue } from "@harness/schemas";
import {
  activateRunWorkspace,
  clearRunScratch,
  lockRunWorkspace,
  sealPersistedRunWorkspaces,
} from "../../src/workspace.js";
import type { Clock } from "../../src/types.js";
import { withRunnerProcessLock } from "./process-lock.js";

/** Default duration of a runner lease in milliseconds. */
export const DEFAULT_RUNNER_LEASE_TTL_MS = 10 * 60 * 1000;

const systemClock: Clock = {
  now: () => Date.now(),
  schedule: (callback, delayMs) => {
    const timer = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(timer);
    };
  },
};

/** Runner lease configuration required by the lease manager. */
export interface RunnerLeaseOptions {
  /** Root containing the per-run workspace directories. */
  readonly workspaceRoot: string;
  /** Optional runner scratch root wiped when a new lease begins. */
  readonly temporaryRoot?: string;
  /** Injectable clock used for deterministic lease expiry tests. */
  readonly clock?: Clock;
  /** Execution credentials that own command-created private trees. */
  readonly executionUid?: number;
  /** Execution credentials that own command-created private trees. */
  readonly executionGid?: number;
  /** Indicates that a process group is currently using the active workspace. */
  readonly isBusy?: () => boolean;
  /** Workspace operations injectable for controlled transition tests. */
  readonly workspaceOperations?: {
    readonly activate: typeof activateRunWorkspace;
    readonly clearScratch: typeof clearRunScratch;
    readonly lock: typeof lockRunWorkspace;
    readonly sealPersisted: typeof sealPersistedRunWorkspaces;
  };
}

interface ActiveRunLease {
  readonly runId: IdValue;
  readonly ttlMs: number;
  readonly expiresAt: number;
  readonly pinned: boolean;
}

/** Maintains the exclusive run lease and seals workspace permissions at release. */
export class RunnerLeaseManager {
  readonly #workspaceRoot: string;
  readonly #temporaryRoot: string | undefined;
  readonly #clock: Clock;
  readonly #executionUid: number | undefined;
  readonly #executionGid: number | undefined;
  readonly #isBusy: () => boolean;
  readonly #operations: NonNullable<RunnerLeaseOptions["workspaceOperations"]>;
  #active: ActiveRunLease | undefined;
  #cancelExpiry: (() => void) | undefined;
  #transitions: Promise<void> = Promise.resolve();
  #reconciled = false;

  constructor(options: RunnerLeaseOptions) {
    this.#workspaceRoot = options.workspaceRoot;
    this.#temporaryRoot = options.temporaryRoot;
    this.#clock = options.clock ?? systemClock;
    this.#executionUid = options.executionUid ?? process.getuid?.();
    this.#executionGid = options.executionGid ?? process.getgid?.();
    this.#isBusy = options.isBusy ?? (() => false);
    this.#operations = options.workspaceOperations ?? {
      activate: activateRunWorkspace,
      clearScratch: clearRunScratch,
      lock: lockRunWorkspace,
      sealPersisted: sealPersistedRunWorkspaces,
    };
  }

  /** Acquires the lease, or renews it when it already belongs to this run. */
  acquire(runId: IdValue, ttlMs = DEFAULT_RUNNER_LEASE_TTL_MS): Promise<boolean> {
    return this.#serialize(async () => {
      await this.#expireIfDue();
      if (!this.#reconciled) {
        await this.#operations.sealPersisted(this.#workspaceRoot);
        this.#reconciled = true;
      }
      return this.#acquireLocked(runId, ttlMs, true);
    });
  }

  /** Releases the lease only when it is owned by the requesting run. */
  release(runId: IdValue): Promise<boolean> {
    return this.#serialize(async () => {
      await this.#expireIfDue();
      if (this.#active === undefined) {
        return true;
      }
      if (this.#active.runId !== runId || this.#isBusy()) {
        return false;
      }
      await this.#dropActive(this.#active);
      return true;
    });
  }

  /** Runs one workspace transfer under an exclusive lease, preserving pinned ownership. */
  async withWorkspaceLease(runId: IdValue, operation: () => Promise<void>): Promise<boolean> {
    const acquisition = await this.#serialize(async () => {
      await this.#expireIfDue();
      if (this.#isBusy()) {
        return { acquired: false, temporary: false };
      }
      if (!this.#reconciled) {
        await this.#operations.sealPersisted(this.#workspaceRoot);
        this.#reconciled = true;
      }
      const current = this.#active?.runId === runId ? this.#active : undefined;
      const acquired = await this.#acquireLocked(
        runId,
        current?.ttlMs ?? DEFAULT_RUNNER_LEASE_TTL_MS,
        true,
      );
      return {
        acquired,
        temporary: acquired && current?.pinned !== true,
      };
    });
    if (!acquisition.acquired) {
      return false;
    }
    try {
      await operation();
      return true;
    } finally {
      if (acquisition.temporary) {
        await this.release(runId);
      } else {
        await this.expireDue();
      }
    }
  }

  /** Renews the current lease for an execution request, claiming it if unowned. */
  renew(runId: IdValue): Promise<boolean> {
    return this.#serialize(async () => {
      await this.#expireIfDue();
      if (!this.#reconciled) {
        await this.#operations.sealPersisted(this.#workspaceRoot);
        this.#reconciled = true;
      }
      const ttlMs =
        this.#active?.runId === runId ? this.#active.ttlMs : DEFAULT_RUNNER_LEASE_TTL_MS;
      const pinned = this.#active?.runId === runId && this.#active.pinned;
      return this.#acquireLocked(runId, ttlMs, pinned);
    });
  }

  /** Releases an execution-scoped lease after its process group has exited. */
  finishExecution(runId: IdValue): Promise<void> {
    return this.#serialize(async () => {
      const active = this.#active;
      if (
        active?.runId === runId &&
        !this.#isBusy() &&
        (!active.pinned || active.expiresAt <= this.#clock.now())
      ) {
        await this.#dropActive(active);
      }
    });
  }

  /** Applies expiry that was deferred while a process group was using its workspace. */
  expireDue(): Promise<void> {
    return this.#serialize(() => this.#expireIfDue());
  }

  async #acquireLocked(runId: IdValue, ttlMs: number, pinned: boolean): Promise<boolean> {
    if (this.#active !== undefined && this.#active.runId !== runId) {
      return false;
    }
    const isRenewal = this.#active?.runId === runId;
    const active = this.#setActive(runId, ttlMs, pinned);
    try {
      if (!isRenewal) {
        await this.#operations.activate(this.#workspaceRoot, runId);
        await this.#operations.clearScratch(this.#workspaceRoot, runId, (path) =>
          this.#removeAsExecutionUser(path),
        );
        await this.#clearTemporaryRoot();
      }
      await this.#expireIfDue();
      return this.#active === active;
    } catch (error) {
      if (!isRenewal && this.#active === active) {
        await this.#dropActive(active);
      }
      throw error;
    }
  }

  async #dropActive(active: ActiveRunLease): Promise<void> {
    if (this.#active !== active || this.#isBusy()) {
      return;
    }
    await this.#operations.lock(this.#workspaceRoot, active.runId);
    if (this.#active !== active) {
      return;
    }
    this.#cancelExpiry?.();
    this.#cancelExpiry = undefined;
    this.#active = undefined;
  }

  async #expireIfDue(): Promise<void> {
    const active = this.#active;
    if (active !== undefined && active.expiresAt <= this.#clock.now() && !this.#isBusy()) {
      await this.#dropActive(active);
    }
  }

  #setActive(runId: IdValue, ttlMs: number, pinned: boolean): ActiveRunLease {
    this.#cancelExpiry?.();
    const active = { runId, ttlMs, expiresAt: this.#clock.now() + ttlMs, pinned };
    this.#active = active;
    this.#cancelExpiry = this.#clock.schedule(() => {
      void this.#serialize(async () => {
        if (this.#active === active) {
          await this.#expireIfDue();
        }
      });
    }, ttlMs);
    return active;
  }

  async #clearTemporaryRoot(): Promise<void> {
    const temporaryRoot = this.#temporaryRoot;
    if (temporaryRoot === undefined) {
      return;
    }
    for (const entry of await readdir(temporaryRoot)) {
      await this.#removeAsExecutionUser(join(temporaryRoot, entry));
    }
  }

  #removeAsExecutionUser(path: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // /bin/rm exists on Debian (merged /usr) and macOS; /usr/bin/rm is missing on macOS.
      const child = spawn("/bin/rm", ["-rf", "--", path], {
        shell: false,
        stdio: "ignore",
        ...(this.#executionUid === undefined ? {} : { uid: this.#executionUid }),
        ...(this.#executionGid === undefined ? {} : { gid: this.#executionGid }),
      });
      child.once("error", () => {
        reject(new Error("Workspace cleanup failed."));
      });
      child.once("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error("Workspace cleanup failed."));
        }
      });
    });
  }

  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#transitions;
    const result = withRunnerProcessLock(() => previous.then(operation));
    this.#transitions = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}
