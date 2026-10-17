// SPDX-License-Identifier: Apache-2.0

import process from "node:process";

let pendingOperations: Promise<void> = Promise.resolve();

/** Process credential access used by the runner and injectable by tests. */
export interface RunnerCredentialApi {
  readonly geteuid: () => number | undefined;
  readonly getegid: () => number | undefined;
  readonly seteuid?: (uid: number) => void;
  readonly setegid?: (gid: number) => void;
}

export const systemRunnerCredentials: RunnerCredentialApi = {
  geteuid: () => process.geteuid?.(),
  getegid: () => process.getegid?.(),
  seteuid: (uid) => process.seteuid?.(uid),
  setegid: (gid) => process.setegid?.(gid),
};

/** Serializes operations that may observe or change process-wide runner credentials. */
export function withRunnerProcessLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingOperations.then(operation);
  pendingOperations = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
