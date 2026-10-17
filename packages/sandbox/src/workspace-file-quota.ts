// SPDX-License-Identifier: Apache-2.0
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  assertActive,
  DEFAULT_RUN_QUOTA_BYTES,
  WorkspaceFileError,
} from "./workspace-file-helpers.js";

/** Counts regular workspace file bytes while enforcing the per-run quota. */
export async function countWorkspaceBytes(root: string, signal: AbortSignal): Promise<number> {
  let total = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assertActive(signal);
      const path = join(directory, entry.name);
      const info = await lstat(path).catch(() => {
        throw new WorkspaceFileError("fs_path_invalid");
      });
      if (info.isSymbolicLink()) {
        continue;
      }
      if (info.isDirectory()) {
        if (directory === root && entry.name === ".harness") {
          continue;
        }
        await visit(path);
      } else if (info.isFile()) {
        total += info.size;
        if (total > DEFAULT_RUN_QUOTA_BYTES) {
          throw new WorkspaceFileError("workspace_quota_exceeded");
        }
      }
    }
  };
  await visit(root);
  return total;
}
