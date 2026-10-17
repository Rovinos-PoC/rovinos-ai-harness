// SPDX-License-Identifier: Apache-2.0
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import {
  link as createHardLink,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { Code, Id, JsonValue } from "@harness/schemas";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FsEditInputSchema,
  FsListInputSchema,
  FsReadInputSchema,
  FsSearchInputSchema,
  FsToolResultSchema,
  FsTools,
  FsWriteInputSchema,
  InProcessBackend,
  RemoteSandboxBackend,
  WorkspaceFileSystem,
  ensureRunWorkspace,
} from "./index.js";
import type { FsOperation } from "./fs-tools.js";
import { readFileSnapshotAt, writeFileAt } from "./workspace-file-helpers.js";
import { countWorkspaceBytes } from "./workspace-file-quota.js";
import { searchFile } from "./workspace-file-search.js";
import { createRunnerRequestHandler } from "../runner/src/server.js";
import type { RunnerResponse, RunnerRequest } from "../runner/src/request-handler.js";

const runId = Id.parse("00000000000000000000000001");
const runnerToken = "synthetic-runner-token-for-filesystem-tests";
const roots: string[] = [];

class MemoryResponse extends EventEmitter implements RunnerResponse {
  headersSent = false;
  writableEnded = false;
  status = 0;
  body = "";

  writeHead(status: number): this {
    this.status = status;
    this.headersSent = true;
    return this;
  }

  write(chunk: Buffer): boolean {
    this.body += chunk.toString();
    return true;
  }

  end(body?: string): void {
    this.body = body ?? "";
    this.writableEnded = true;
    this.emit("close");
  }

  destroy(): void {
    this.body = "";
  }
}

async function workspaceRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "sandbox-fs-tools-")));
  roots.push(root);
  return root;
}

async function remoteBackend(root: string): Promise<{
  readonly backend: RemoteSandboxBackend;
  readonly close: () => Promise<void>;
}> {
  const handler = createRunnerRequestHandler({
    token: runnerToken,
    allowedHosts: ["sandbox-runner:8080"],
    workspaceRoot: root,
    execute: () =>
      Promise.resolve({
        exitCode: 0,
        stdout: "",
        stderr: "",
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        timedOut: false,
        durationMs: 0,
      }),
  });
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = typeof init?.body === "string" ? init.body : "";
    const headers = new Headers(init?.headers);
    const request: RunnerRequest = Object.assign(Readable.from([Buffer.from(body)]), {
      method: init?.method ?? "POST",
      url: url.pathname,
      headers: {
        host: url.host,
        authorization: headers.get("authorization") ?? undefined,
      },
    });
    const response = new MemoryResponse();
    await handler(request, response);
    return new Response(response.body, { status: response.status });
  };
  const backend = new RemoteSandboxBackend({
    url: "http://sandbox-runner:8080",
    token: runnerToken,
    fetcher,
  });
  await backend.acquireLease(runId);
  return {
    backend,
    close: async () => {
      await backend.releaseLease(runId);
    },
  };
}

async function makeBackend(
  kind: "in-process" | "remote",
  root: string,
): Promise<{
  readonly backend: InProcessBackend | RemoteSandboxBackend;
  readonly close: () => Promise<void>;
}> {
  if (kind === "remote") {
    return remoteBackend(root);
  }
  return {
    backend: new InProcessBackend({
      workspaceRoot: root,
      logger: { log: () => undefined },
    }),
    close: () => Promise.resolve(),
  };
}

function toolCall(tool: FsTools, toolId: string, args: unknown): ReturnType<FsTools["execute"]> {
  return tool.execute(
    {
      callId: runId,
      toolId: Code.parse(toolId),
      args: JsonValue.parse(args),
    },
    { runId, signal: new AbortController().signal },
  );
}

async function expectFileError(
  operation: FsOperation,
  root: string,
  input: unknown,
  code: string,
): Promise<void> {
  const files = new WorkspaceFileSystem(root);
  await expect(
    files.execute(runId, operation, input, new AbortController().signal),
  ).rejects.toMatchObject({
    code,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.each(["in-process", "remote"] as const)("workspace tools on the %s backend", (kind) => {
  it("provides identical read, write, edit, list, and search behavior", async () => {
    const root = await workspaceRoot();
    const { backend, close } = await makeBackend(kind, root);
    const tools = new FsTools(backend);
    try {
      expect(tools.getToolSpecs().map(({ toolId }) => toolId)).toEqual([
        "fs.read",
        "fs.write",
        "fs.edit",
        "fs.list",
        "fs.search",
      ]);
      expect(
        await toolCall(tools, "fs.write", {
          path: "notes.txt",
          content: "alpha\nbeta",
          mode: "create",
        }),
      ).toMatchObject({ outcome: "ok" });
      expect(
        await toolCall(tools, "fs.read", { path: "notes.txt", offset: 6, length: 4 }),
      ).toMatchObject({
        outcome: "ok",
        result: { binary: false, content: "beta", offset: 6 },
      });
      expect(
        await toolCall(tools, "fs.edit", {
          path: "notes.txt",
          edits: [{ oldText: "beta", newText: "gamma" }],
        }),
      ).toMatchObject({ outcome: "ok" });
      expect(await toolCall(tools, "fs.list", { path: ".", depth: 0, limit: 10 })).toMatchObject({
        outcome: "ok",
        result: { entries: [{ path: "notes.txt", type: "file" }], truncated: false },
      });
      expect(
        await toolCall(tools, "fs.search", { query: "gamma", regex: false, limit: 10 }),
      ).toMatchObject({
        outcome: "ok",
        result: { matches: [{ path: "notes.txt", line: "gamma", lineNumber: 2 }] },
      });
      expect(
        await toolCall(tools, "fs.search", {
          query: "g.mma",
          regex: true,
          path: "notes.txt",
          limit: 10,
        }),
      ).toMatchObject({
        outcome: "ok",
        result: { matches: [{ path: "notes.txt", lineNumber: 2, line: "gamma" }] },
      });
      expect(tools.describe("fs.read")).toMatchObject({ idempotent: true });
      expect(
        tools.describe(
          "fs.write",
          JsonValue.parse({
            path: "notes.txt",
            content: "new",
            mode: "overwrite",
            expectedSha256: "0".repeat(64),
          }),
        ),
      ).toMatchObject({ idempotent: true });
      expect(
        tools.describe(
          "fs.write",
          JsonValue.parse({
            path: "notes.txt",
            content: "new",
            mode: "overwrite",
          }),
        ),
      ).toMatchObject({ idempotent: false });
      expect(tools.describe(Code.parse("fs.unknown"))).toBeUndefined();
      expect(await toolCall(tools, "fs.read", { path: "../outside" })).toMatchObject({
        outcome: "error",
        errorCode: "fs_path_invalid",
        result: null,
      });
    } finally {
      await close();
    }
  });

  it("transports escaped writes and aggregate multi-edit input within the shared contract", async () => {
    const root = await workspaceRoot();
    const { backend, close } = await makeBackend(kind, root);
    const tools = new FsTools(backend);
    const project = await ensureRunWorkspace(root, runId);
    try {
      await expect(
        toolCall(tools, "fs.write", {
          path: "escaped.txt",
          content: "\n".repeat(1024 * 1024),
          mode: "create",
        }),
      ).resolves.toMatchObject({ outcome: "ok" });
      await writeFile(
        join(project, "multi-edit.txt"),
        "a".repeat(512 * 1024) + "b".repeat(512 * 1024),
      );
      await expect(
        toolCall(tools, "fs.edit", {
          path: "multi-edit.txt",
          edits: [
            { oldText: "a".repeat(512 * 1024), newText: "\n".repeat(512 * 1024) },
            { oldText: "b".repeat(512 * 1024), newText: "\n".repeat(512 * 1024) },
          ],
        }),
      ).resolves.toMatchObject({ outcome: "ok" });
    } finally {
      await close();
    }
  });
});

describe("workspace file operation contracts and safety", () => {
  it("enforces input sizes, counts, offsets, depths, limits, and safe regexes", () => {
    expect(FsReadInputSchema.safeParse({ path: "a", length: 256 * 1024 }).success).toBe(true);
    expect(FsReadInputSchema.safeParse({ path: "a", length: 256 * 1024 + 1 }).success).toBe(false);
    expect(
      FsWriteInputSchema.safeParse({
        path: "a",
        content: "é".repeat(524_289),
        mode: "create",
      }).success,
    ).toBe(false);
    expect(
      FsEditInputSchema.safeParse({
        path: "a",
        edits: Array.from({ length: 21 }, () => ({ oldText: "a", newText: "b" })),
      }).success,
    ).toBe(false);
    expect(
      FsEditInputSchema.safeParse({
        path: "a",
        edits: [
          { oldText: "a".repeat(1024 * 1024), newText: "b".repeat(1024 * 1024) },
          { oldText: "a".repeat(1024 * 1024), newText: "b".repeat(1024 * 1024) },
        ],
      }).success,
    ).toBe(true);
    expect(
      FsEditInputSchema.safeParse({
        path: "a",
        edits: Array.from({ length: 3 }, () => ({
          oldText: "a".repeat(1024 * 1024),
          newText: "b".repeat(1024 * 1024),
        })),
      }).success,
    ).toBe(false);
    expect(FsListInputSchema.safeParse({ path: ".", depth: 4, limit: 10 }).success).toBe(false);
    expect(
      FsSearchInputSchema.safeParse({
        query: "(a+)+$",
        regex: true,
        limit: 10,
      }).success,
    ).toBe(false);
    expect(
      FsSearchInputSchema.safeParse({
        query: "[",
        regex: true,
        limit: 10,
      }).success,
    ).toBe(false);
  });

  it("returns only binary metadata and supports byte offsets", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    await writeFile(join(project, "binary.dat"), Buffer.from([0, 1, 2]));
    await writeFile(join(project, "text.txt"), "éclair");
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;

    expect(await files.execute(runId, "read", { path: "binary.dat" }, signal)).toEqual({
      binary: true,
      bytes: 3,
    });
    expect(
      await files.execute(runId, "read", { path: "text.txt", offset: 3, length: 1 }, signal),
    ).toMatchObject({
      binary: false,
      content: "l",
      offset: 3,
      bytes: 1,
    });
    await writeFile(join(project, "unicode.txt"), "éx");
    expect(
      await files.execute(runId, "read", { path: "unicode.txt", offset: 1, length: 1 }, signal),
    ).toMatchObject({
      binary: false,
      content: "x",
      offset: 2,
      bytes: 1,
    });
    await writeFile(join(project, "multibyte.txt"), "é");
    expect(
      await files.execute(runId, "read", { path: "multibyte.txt", offset: 1, length: 1 }, signal),
    ).toMatchObject({
      binary: false,
      content: "",
      offset: 2,
      bytes: 0,
    });
    await writeFile(join(project, "prefix-multibyte.txt"), "aé");
    expect(
      await files.execute(
        runId,
        "read",
        { path: "prefix-multibyte.txt", offset: 1, length: 2 },
        signal,
      ),
    ).toMatchObject({ binary: false, content: "é", offset: 1, bytes: 2 });
    await writeFile(join(project, "leading-multibyte.txt"), "éa");
    expect(
      await files.execute(
        runId,
        "read",
        { path: "leading-multibyte.txt", offset: 0, length: 2 },
        signal,
      ),
    ).toMatchObject({ binary: false, content: "é", offset: 0, bytes: 2 });
    expect(
      await files.execute(
        runId,
        "read",
        { path: "leading-multibyte.txt", offset: 1, length: 2 },
        signal,
      ),
    ).toMatchObject({ binary: false, content: "a", offset: 2, bytes: 1 });
    expect(FsToolResultSchema.safeParse({ binary: true, bytes: 3, path: "secret" }).success).toBe(
      false,
    );
  });

  it("reads only the requested range from a maximum-size file", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    await writeFile(join(project, "large.txt"), `${"x".repeat(10 * 1024 * 1024 - 1)}z`);
    const files = new WorkspaceFileSystem(root);
    const allocationSpy = vi.spyOn(Buffer, "alloc");

    try {
      await expect(
        files.execute(
          runId,
          "read",
          { path: "large.txt", offset: 10 * 1024 * 1024 - 1, length: 1 },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ binary: false, content: "z", bytes: 1 });
      expect(allocationSpy.mock.calls.every(([size]) => size < 1024 * 1024)).toBe(true);
    } finally {
      allocationSpy.mockRestore();
    }
  });

  it("rejects missing and non-file targets while skipping symlinks in traversal", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "sandbox-fs-outside-")));
    roots.push(outside);
    await mkdir(join(project, "directory"));
    await writeFile(join(project, "file.txt"), "visible");
    await writeFile(join(outside, "secret.txt"), "hidden");
    await symlink(join(outside, "secret.txt"), join(project, "linked.txt"));
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;

    await expectFileError("read", root, { path: "missing.txt" }, "fs_file_not_found");
    await expectFileError("read", root, { path: "directory" }, "fs_not_file");
    await expectFileError(
      "write",
      root,
      {
        path: "file.txt",
        content: "replacement",
        mode: "create",
      },
      "fs_file_exists",
    );
    await expectFileError(
      "write",
      root,
      {
        path: "missing.txt",
        content: "replacement",
        mode: "overwrite",
      },
      "fs_file_not_found",
    );
    await expectFileError(
      "write",
      root,
      {
        path: "linked.txt",
        content: "replacement",
        mode: "overwrite",
      },
      "fs_path_invalid",
    );
    await expectFileError(
      "list",
      root,
      { path: "file.txt", depth: 0, limit: 10 },
      "fs_not_directory",
    );
    await expect(
      files.execute(runId, "list", { path: ".", depth: 0, limit: 10 }, signal),
    ).resolves.toMatchObject({
      entries: [
        { path: "directory", type: "directory" },
        { path: "file.txt", type: "file" },
      ],
    });
    await expect(
      files.execute(
        runId,
        "search",
        {
          query: "visible",
          regex: false,
          path: "directory",
          limit: 10,
        },
        signal,
      ),
    ).resolves.toMatchObject({ matches: [], truncated: false });
    await expect(
      files.execute(
        runId,
        "search",
        {
          query: "hidden",
          regex: false,
          path: ".",
          limit: 10,
        },
        signal,
      ),
    ).resolves.toMatchObject({ matches: [], truncated: false });
    await expect(readFile(join(outside, "secret.txt"), "utf8")).resolves.toBe("hidden");
  });

  // threat: T-12
  it("rejects traversal, absolute paths, symlinks, and all .harness paths", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "sandbox-fs-outside-")));
    roots.push(outside);
    await writeFile(join(outside, "target.txt"), "unchanged");
    await symlink(join(outside, "target.txt"), join(project, "linked.txt"));

    for (const path of ["../outside", "/etc/passwd", "linked.txt", ".harness/offload/item"]) {
      await expectFileError("read", root, { path }, "fs_path_invalid");
    }
    await expectFileError(
      "write",
      root,
      {
        path: ".harness/tmp/item",
        content: "blocked",
        mode: "create",
      },
      "fs_path_invalid",
    );
    await expect(readFile(join(outside, "target.txt"), "utf8")).resolves.toBe("unchanged");
  });

  it("rejects targeted hard links but skips them during recursive search", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const protectedPath = join(root, runId, ".harness", "offload", "protected.txt");
    await writeFile(protectedPath, "protected content");
    await createHardLink(protectedPath, join(project, "alias.txt"));

    await expectFileError("read", root, { path: "alias.txt" }, "fs_path_invalid");
    const files = new WorkspaceFileSystem(root);
    await expect(
      files.execute(
        runId,
        "search",
        { path: "alias.txt", query: "protected", regex: false, limit: 1 },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "fs_path_invalid" });
    await writeFile(join(project, "ordinary.txt"), "public content");
    await expect(
      files.execute(
        runId,
        "search",
        { path: ".", query: "public", regex: false, limit: 1 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      matches: [{ path: "ordinary.txt", line: "public content" }],
      truncated: false,
    });
    await expectFileError(
      "write",
      root,
      { path: "alias.txt", content: "changed", mode: "overwrite" },
      "fs_path_invalid",
    );
    await expectFileError(
      "edit",
      root,
      { path: "alias.txt", edits: [{ oldText: "protected", newText: "changed" }] },
      "fs_path_invalid",
    );
    await expect(readFile(protectedPath, "utf8")).resolves.toBe("protected content");
  });

  it("enforces edit uniqueness and prevents a preconditioned retry from applying twice", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const path = join(project, "edit.txt");
    await writeFile(path, "first second second");
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;

    await expectFileError(
      "edit",
      root,
      {
        path: "edit.txt",
        edits: [{ oldText: "absent", newText: "value" }],
      },
      "edit_no_match",
    );
    await expectFileError(
      "edit",
      root,
      {
        path: "edit.txt",
        edits: [{ oldText: "second", newText: "third" }],
      },
      "edit_ambiguous",
    );

    const originalSha256 = createHash("sha256").update("first second second").digest("hex");
    const input = {
      path: "edit.txt",
      edits: [{ oldText: "first", newText: "updated" }],
      expectedSha256: originalSha256,
    };
    await expect(files.execute(runId, "edit", input, signal)).resolves.toMatchObject({
      path: "edit.txt",
    });
    await expect(files.execute(runId, "edit", input, signal)).rejects.toMatchObject({
      code: "precondition_failed",
    });
    await expect(readFile(path, "utf8")).resolves.toBe("updated second second");
  });

  it("applies write preconditions once and rejects a same-content retry", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    await writeFile(join(project, "existing.txt"), "before");
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;
    const expectedSha256 = createHash("sha256").update("before").digest("hex");
    const input = {
      path: "existing.txt",
      content: "after",
      mode: "overwrite",
      expectedSha256,
    };
    await files.execute(runId, "write", input, signal);
    await expect(files.execute(runId, "write", input, signal)).rejects.toMatchObject({
      code: "precondition_failed",
    });
    const unchanged = {
      ...input,
      content: "before",
    };
    await expect(files.execute(runId, "write", unchanged, signal)).rejects.toMatchObject({
      code: "precondition_failed",
    });
  });

  it("creates a preconditioned new file once", async () => {
    const root = await workspaceRoot();
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;
    const input = {
      path: "created.txt",
      content: "created",
      mode: "create",
      expectedSha256: createHash("sha256").update(new Uint8Array()).digest("hex"),
    };

    await expect(files.execute(runId, "write", input, signal)).resolves.toMatchObject({
      path: "created.txt",
    });
    await expect(files.execute(runId, "write", input, signal)).rejects.toMatchObject({
      code: "precondition_failed",
    });
  });

  it("reports an oversized preconditioned edit as a quota error without changing the file", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const path = join(project, "oversized-edit.txt");
    const markers = Array.from({ length: 5 }, (_, index) => `[edit-${String(index)}]`);
    const markerText = markers.join("");
    const original = `${markerText}${"x".repeat(10 * 1024 * 1024 - markerText.length)}`;
    await writeFile(path, original);
    const edits = markers.map((oldText) => ({ oldText, newText: "z".repeat(800_000) }));

    await expect(
      new WorkspaceFileSystem(root).execute(
        runId,
        "edit",
        {
          path: "oversized-edit.txt",
          edits,
          expectedSha256: createHash("sha256").update(original).digest("hex"),
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "workspace_quota_exceeded" });
    const unchanged = await readFile(path);
    expect(createHash("sha256").update(unchanged).digest("hex")).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
  });

  it("keeps the prior bytes and hash when atomic replacement detects a stale target", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const path = join(project, "atomic.txt");
    const original = "original";
    await writeFile(path, original);
    const snapshot = await readFileSnapshotAt(path);
    const staleIdentity = { ...snapshot.identity, mtimeMs: snapshot.identity.mtimeMs + 1 };

    await expect(
      writeFileAt(path, Buffer.from("replacement"), {
        mode: "overwrite",
        signal: new AbortController().signal,
        expectedIdentity: staleIdentity,
      }),
    ).rejects.toMatchObject({ code: "precondition_failed" });
    const unchanged = await readFile(path);
    expect(unchanged.toString("utf8")).toBe(original);
    expect(createHash("sha256").update(unchanged).digest("hex")).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
    expect((await readdir(project)).filter((name) => name.startsWith(".harness-fs-"))).toEqual([]);
  });

  it("keeps the prior bytes and hash when an atomic replacement is aborted", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const path = join(project, "aborted-atomic.txt");
    const original = "original bytes";
    await writeFile(path, original);
    const snapshot = await readFileSnapshotAt(path);
    const controller = new AbortController();

    await expect(
      writeFileAt(path, Buffer.from("replacement"), {
        mode: "overwrite",
        signal: controller.signal,
        expectedIdentity: snapshot.identity,
        onTemporaryFileCreated: () => {
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ code: "fs_operation_failed" });
    const unchanged = await readFile(path);
    expect(createHash("sha256").update(unchanged).digest("hex")).toBe(
      createHash("sha256").update(snapshot.bytes).digest("hex"),
    );
    expect((await readdir(project)).filter((name) => name.startsWith(".harness-fs-"))).toEqual([]);
  });

  // threat: T-09
  it("enforces the existing per-file and per-run quotas", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    await Promise.all(
      Array.from({ length: 50 }, (_, index) =>
        (async () => {
          const path = join(project, `quota-${String(index)}.bin`);
          await writeFile(path, "");
          await truncate(path, 10 * 1024 * 1024);
        })(),
      ),
    );
    const files = new WorkspaceFileSystem(root);
    await expect(
      files.execute(
        runId,
        "write",
        { path: "over-quota.txt", content: "x", mode: "create" },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "workspace_quota_exceeded" });

    const tooLargePath = join(project, "too-large.bin");
    await writeFile(tooLargePath, "");
    await truncate(tooLargePath, 10 * 1024 * 1024 + 1);
    await expect(
      files.execute(runId, "read", { path: "too-large.bin" }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "workspace_quota_exceeded" });
  });

  it("skips symlinks and counts oversized command-created files without blocking a small write", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const outside = await realpath(await mkdtemp(join(tmpdir(), "sandbox-fs-quota-")));
    roots.push(outside);
    const oversized = join(project, "exec-large.bin");
    await writeFile(oversized, "");
    await truncate(oversized, 11 * 1024 * 1024);
    const external = join(outside, "secret.txt");
    await writeFile(external, "outside");
    await symlink(external, join(project, "external-link"));

    await expect(
      new WorkspaceFileSystem(root).execute(
        runId,
        "write",
        { path: "small.txt", content: "small", mode: "create" },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ path: "small.txt" });
  });

  it("reports bounded list/search results, ignores binary search input, and rejects aborted work", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    await mkdir(join(project, "nested", "deeper"), { recursive: true });
    await writeFile(join(project, "nested", "deeper", "match.txt"), "needle\nneedle");
    await writeFile(join(project, "binary.dat"), Buffer.from([0, 0, 1]));
    const files = new WorkspaceFileSystem(root);
    const signal = new AbortController().signal;

    await expect(
      files.execute(runId, "list", { path: ".", depth: 3, limit: 1 }, signal),
    ).resolves.toMatchObject({
      truncated: true,
    });
    await expect(
      files.execute(runId, "list", { path: ".", depth: 3, limit: 2 }, signal),
    ).resolves.toMatchObject({ truncated: true });
    const listed = await files.execute(runId, "list", { path: ".", depth: 3, limit: 20 }, signal);
    expect(listed).toMatchObject({ truncated: false });
    expect(listed).toHaveProperty(
      "entries",
      expect.arrayContaining([{ path: "nested/deeper/match.txt", type: "file", bytes: 13 }]),
    );
    await expect(
      files.execute(
        runId,
        "search",
        { query: "needle", regex: false, path: "nested/deeper/match.txt", limit: 1 },
        signal,
      ),
    ).resolves.toMatchObject({ matches: [{ lineNumber: 1 }], truncated: true });
    await expect(
      files.execute(
        runId,
        "search",
        {
          query: "needle",
          regex: false,
          path: ".",
          limit: 10,
        },
        signal,
      ),
    ).resolves.toMatchObject({
      matches: [
        { path: "nested/deeper/match.txt", lineNumber: 1 },
        { path: "nested/deeper/match.txt", lineNumber: 2 },
      ],
    });

    const controller = new AbortController();
    controller.abort();
    await expect(
      files.execute(runId, "read", { path: "binary.dat" }, controller.signal),
    ).rejects.toMatchObject({
      code: "fs_operation_failed",
    });
  });

  it("counts nested project files while excluding the protected workspace directory", async () => {
    const root = await workspaceRoot();
    await mkdir(join(root, ".harness", "offload"), { recursive: true });
    await writeFile(join(root, ".harness", "offload", "private.txt"), "not counted");
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(join(root, "nested", "file.txt"), "counted");

    await expect(countWorkspaceBytes(root, new AbortController().signal)).resolves.toBe(7);

    const oversized = join(root, "oversized.bin");
    await writeFile(oversized, "");
    await truncate(oversized, 500 * 1024 * 1024 + 1);
    await expect(countWorkspaceBytes(root, new AbortController().signal)).rejects.toMatchObject({
      code: "workspace_quota_exceeded",
    });
  });

  it("rejects an explicitly targeted file that disappears before opening", async () => {
    const root = await workspaceRoot();
    const matches: { path: string; lineNumber: number; line: string }[] = [];
    await expect(
      searchFile(join(root, "missing.txt"), "missing.txt", {
        root,
        prefix: ".",
        matcher: () => false,
        limit: 10,
        matches,
        signal: new AbortController().signal,
        state: { filesVisited: 0, bytesScanned: 0 },
      }),
    ).rejects.toMatchObject({ code: "fs_path_invalid" });
  });

  it("caps total search input and regex line lengths across many large files", async () => {
    const root = await workspaceRoot();
    const project = await ensureRunWorkspace(root, runId);
    const maximum = 10 * 1024 * 1024;
    await writeFile(join(project, "first.txt"), `needle\n${"x".repeat(maximum - 7)}`);
    await Promise.all(
      Array.from({ length: 8 }, async (_, index) => {
        const path = join(project, `large-${String(index)}.txt`);
        await writeFile(path, "");
        await truncate(path, maximum);
      }),
    );
    const files = new WorkspaceFileSystem(root);

    await expect(
      files.execute(
        runId,
        "search",
        { query: "needle", regex: false, limit: 1 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      matches: [{ path: "first.txt", lineNumber: 1 }],
      truncated: true,
    });

    await writeFile(join(project, "long-line.txt"), `${"x".repeat(2048)}needle`);
    await expect(
      files.execute(
        runId,
        "search",
        { path: "long-line.txt", query: "needle", regex: false, limit: 1 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ matches: [], truncated: true });
  });
});
