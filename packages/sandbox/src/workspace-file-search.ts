// SPDX-License-Identifier: Apache-2.0
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { FsListEntry } from "./fs-tools.js";
import {
  assertActive,
  decodeUtf8Prefix,
  fileIdentity,
  projectPath,
  WorkspaceHardLinkError,
  WorkspaceFileError,
} from "./workspace-file-helpers.js";

const MAX_SEARCH_LINE_CHARS = 2048;
const MAX_SEARCH_BYTES = 10 * 1024 * 1024;
const MAX_SEARCH_FILES = 1000;
const NOFOLLOW = constants.O_NOFOLLOW;
const NON_BLOCKING = constants.O_NONBLOCK;

interface ListContext {
  readonly root: string;
  readonly prefix: string;
  readonly remainingDepth: number;
  readonly limit: number;
  readonly entries: FsListEntry[];
  readonly signal: AbortSignal;
}

/** Traverses safe entries up to the requested depth and reports whether the limit was exceeded. */
export async function listEntries(directory: string, context: ListContext): Promise<boolean> {
  const names = await readdir(directory);
  for (const name of names) {
    assertActive(context.signal);
    const relativePath = context.prefix === "." ? name : join(context.prefix, name);
    const resolved = await projectPath(context.root, relativePath).catch((error: unknown) => {
      if (error instanceof WorkspaceFileError && error.code === "fs_path_invalid") {
        return undefined;
      }
      throw error;
    });
    if (resolved === undefined) {
      continue;
    }
    const info = await lstat(resolved).catch(() => {
      throw new WorkspaceFileError("fs_path_invalid");
    });
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      context.entries.push({ path: relativePath, type: "directory" });
      if (context.entries.length > context.limit) {
        return true;
      }
      if (
        context.remainingDepth > 0 &&
        (await listEntries(resolved, {
          ...context,
          prefix: relativePath,
          remainingDepth: context.remainingDepth - 1,
        }))
      ) {
        return true;
      }
    } else if (info.isFile()) {
      context.entries.push({ path: relativePath, type: "file", bytes: info.size });
      if (context.entries.length > context.limit) {
        return true;
      }
    }
  }
  return false;
}

/** One bounded line match returned by workspace search. */
export interface SearchMatch {
  readonly line: string;
  readonly lineNumber: number;
  readonly path: string;
}

interface SearchContext {
  readonly root: string;
  readonly prefix: string;
  readonly matcher: (line: string) => boolean;
  readonly limit: number;
  readonly matches: SearchMatch[];
  readonly signal: AbortSignal;
  readonly state: { filesVisited: number; bytesScanned: number };
}

/** Adds bounded text matches from one file and reports whether any search cap was hit. */
export async function searchFile(
  path: string,
  relativePath: string,
  context: SearchContext,
): Promise<boolean> {
  const handle = await open(path, constants.O_RDONLY | NOFOLLOW | NON_BLOCKING).catch(() => {
    throw new WorkspaceFileError("fs_path_invalid");
  });
  let content: string | undefined;
  let capHit = false;
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      return false;
    }
    fileIdentity(info);
    const state = context.state;
    const remaining = Math.max(0, MAX_SEARCH_BYTES - state.bytesScanned);
    if (remaining === 0) {
      return info.size > 0;
    }
    const length = Math.min(info.size, remaining);
    const bytes = Buffer.alloc(length);
    const result = await handle.read(bytes, 0, length, 0);
    state.bytesScanned += result.bytesRead;
    capHit = info.size > result.bytesRead;
    content = decodeUtf8Prefix(bytes.subarray(0, result.bytesRead), capHit);
  } finally {
    await handle.close();
  }
  if (content === undefined) {
    return capHit;
  }
  let line = "";
  let lineLength = 0;
  let lineNumber = 1;
  const addMatch = (): boolean => {
    if (lineLength > MAX_SEARCH_LINE_CHARS) {
      capHit = true;
    }
    if (context.matcher(line)) {
      context.matches.push({ path: relativePath, lineNumber, line });
      if (context.matches.length > context.limit) {
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < content.length; index += 1) {
    if (index % MAX_SEARCH_LINE_CHARS === 0) {
      assertActive(context.signal);
    }
    const character = content[index] ?? "";
    if (character === "\n") {
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
        lineLength -= 1;
      }
      if (addMatch()) {
        return true;
      }
      lineNumber += 1;
      line = "";
      lineLength = 0;
    } else {
      if (lineLength < MAX_SEARCH_LINE_CHARS) {
        line += character;
      }
      lineLength += 1;
    }
  }
  if (addMatch()) {
    return true;
  }
  return capHit;
}

/** Searches files recursively while skipping unsafe symlink entries. */
export async function searchDirectory(directory: string, context: SearchContext): Promise<boolean> {
  const state = context.state;
  for (const name of await readdir(directory)) {
    assertActive(context.signal);
    const relativePath = context.prefix === "." ? name : join(context.prefix, name);
    const path = await projectPath(context.root, relativePath).catch((error: unknown) => {
      if (error instanceof WorkspaceFileError && error.code === "fs_path_invalid") {
        return undefined;
      }
      throw error;
    });
    if (path === undefined) {
      continue;
    }
    const info = await lstat(path).catch(() => {
      throw new WorkspaceFileError("fs_path_invalid");
    });
    if (info.isSymbolicLink()) {
      continue;
    }
    if (info.isDirectory()) {
      if (
        await searchDirectory(path, {
          ...context,
          prefix: relativePath,
        })
      ) {
        return true;
      }
    } else if (info.isFile()) {
      try {
        fileIdentity(info);
      } catch (error) {
        if (error instanceof WorkspaceHardLinkError) {
          continue;
        }
        throw error;
      }
      if (state.filesVisited >= MAX_SEARCH_FILES) {
        return true;
      }
      state.filesVisited += 1;
      if (await searchFile(path, relativePath, context)) {
        return true;
      }
    }
  }
  return false;
}
