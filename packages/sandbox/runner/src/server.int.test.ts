// SPDX-License-Identifier: Apache-2.0
import { execFile, execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { Id, parseJson } from "@harness/schemas";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { ExecResultSchema } from "../../src/types.js";
import type { ExecSpec } from "../../src/types.js";
import { FsToolResultSchema } from "../../src/fs-tools.js";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const projectName = `harness-sandbox-runner-${String(process.pid)}`;
const integrationToken = "synthetic-runner-token-for-integration";
const composeFile = "infra/compose/docker-compose.yml";
const integrationUid = 10002;
const integrationGid = 10003;
const composeEnvironment = {
  ...process.env,
  SANDBOX_RUNNER_TOKEN: integrationToken,
  SANDBOX_RUNNER_UID: String(integrationUid),
  SANDBOX_RUNNER_GID: String(integrationGid),
};

const ComposeSchema = z.object({
  networks: z.record(z.string(), z.object({ internal: z.boolean().optional() })),
  secrets: z.record(z.string(), z.unknown()).optional(),
  services: z.record(
    z.string(),
    z.object({
      cpus: z.number().optional(),
      cap_add: z.array(z.string()).optional(),
      cap_drop: z.array(z.string()).optional(),
      entrypoint: z
        .union([z.array(z.string()), z.string()])
        .nullable()
        .optional(),
      environment: z.record(z.string(), z.string()).optional(),
      mem_limit: z.union([z.string(), z.number()]).optional(),
      networks: z.record(z.string(), z.unknown()).optional(),
      pids_limit: z.number().optional(),
      ports: z.array(z.unknown()).optional(),
      privileged: z.boolean().optional(),
      read_only: z.boolean().optional(),
      secrets: z.array(z.unknown()).optional(),
      user: z.string().optional(),
      volumes: z
        .array(
          z.object({
            source: z.string().optional(),
            target: z.string().optional(),
            type: z.string().optional(),
          }),
        )
        .optional(),
    }),
  ),
});
const HttpResponseSchema = z.object({ status: z.number().int(), body: z.string() }).strict();
const ChildCapabilitiesSchema = z
  .object({
    values: z
      .object({
        CapInh: z.string(),
        CapPrm: z.string(),
        CapEff: z.string(),
        CapBnd: z.string(),
        CapAmb: z.string(),
      })
      .strict(),
    uidError: z.string(),
    gidError: z.string(),
    supplementaryGroups: z.array(z.number().int()),
    tokenInChildEnvironment: z.boolean(),
    procOneEnvironmentReadable: z.boolean(),
    serverPidFound: z.boolean(),
    serverEnvironmentReadable: z.boolean(),
    tokenInFiles: z.boolean(),
    signalError: z.string(),
  })
  .strict();

function composeArgs(args: string[]): string[] {
  return [
    "compose",
    "--env-file",
    "infra/collector/VERSION",
    "--project-name",
    projectName,
    "--profile",
    "sandbox",
    "--file",
    composeFile,
    ...args,
  ];
}

async function runCompose(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("docker", composeArgs(args), {
    cwd: root,
    env: composeEnvironment,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  return stdout;
}

function readRenderedComposeConfig(): z.infer<typeof ComposeSchema> {
  const output = execFileSync("docker", composeArgs(["config", "--format", "json"]), {
    cwd: root,
    env: composeEnvironment,
    encoding: "utf8",
  });
  return parseJson(ComposeSchema, output);
}

function renderComposeConfigWithoutRunnerToken(file: string): void {
  const environment: NodeJS.ProcessEnv = { ...composeEnvironment };
  delete environment.SANDBOX_RUNNER_TOKEN;
  execFileSync(
    "docker",
    ["compose", "--env-file", "infra/collector/VERSION", "--file", file, "config"],
    { cwd: root, env: environment, encoding: "utf8" },
  );
}

async function executeInRunner(script: string, user?: string): Promise<string> {
  const { stdout } = await execFileAsync(
    "docker",
    [
      "compose",
      "--env-file",
      "infra/collector/VERSION",
      "--project-name",
      projectName,
      "--profile",
      "sandbox",
      "--file",
      composeFile,
      "exec",
      "--no-TTY",
      ...(user === undefined ? [] : ["--user", user]),
      "sandbox-runner",
      "node",
      "-e",
      script,
    ],
    { cwd: root, env: composeEnvironment, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
  );
  return stdout;
}

async function requestRunner(
  body: unknown,
  options: {
    readonly token?: string;
    readonly host?: string;
    readonly origin?: string;
    readonly path?: string;
  } = {},
): Promise<z.infer<typeof HttpResponseSchema>> {
  const headers = {
    host: options.host ?? "sandbox-runner:8080",
    ...(options.token === undefined ? {} : { authorization: ["Bearer", options.token].join(" ") }),
    ...(options.origin === undefined ? {} : { origin: options.origin }),
    "content-type": "application/json",
  };
  const path = options.path ?? "/exec";
  const script = [
    'const http = require("node:http");',
    `const request = http.request({ hostname: "127.0.0.1", port: 8080, path: ${JSON.stringify(path)}, method: "POST", headers: ${JSON.stringify(headers)} }, (response) => {`,
    '  const chunks = []; response.on("data", (chunk) => chunks.push(chunk));',
    '  response.on("end", () => process.stdout.write(JSON.stringify({ status: response.statusCode, body: Buffer.concat(chunks).toString() })));',
    "});",
    `request.end(${JSON.stringify(JSON.stringify(body))});`,
  ].join("\n");
  const output = await executeInRunner(script);
  return parseJson(HttpResponseSchema, output);
}

function makeSpec(argv: string[], options: Partial<ExecSpec> = {}): ExecSpec {
  return {
    argv,
    timeoutMs: 5000,
    limits: { memoryMb: 2048, pids: 2048, outputBytes: 2048, cpuSeconds: 5 },
    ...options,
  };
}

async function runExec(
  spec: ExecSpec,
  runId = Id.parse("00000000000000000000000001"),
): Promise<z.infer<typeof ExecResultSchema>> {
  const response = await requestRunner({ runId, spec }, { token: integrationToken });
  expect(response.status).toBe(200);
  return parseJson(ExecResultSchema, response.body);
}

describe("sandbox runner Compose service", () => {
  it("renders base and test Compose models without the optional sandbox token", () => {
    expect(() => {
      renderComposeConfigWithoutRunnerToken("infra/compose/docker-compose.yml");
    }).not.toThrow();
    expect(() => {
      renderComposeConfigWithoutRunnerToken("infra/compose/docker-compose.test.yml");
    }).not.toThrow();
  });

  beforeAll(async () => {
    await runCompose(["up", "--detach", "--wait", "--pull=missing", "sandbox-runner"]);
  }, 180_000);

  afterAll(async () => {
    await runCompose(["down", "--volumes", "--remove-orphans"]).catch(() => undefined);
  }, 60_000);

  // threat: T-01
  // threat: T-04
  it("has no host runtime or secret mounts, privileged mode, or published ports", () => {
    const config = readRenderedComposeConfig();
    const runner = config.services["sandbox-runner"];
    expect(runner).toBeDefined();
    expect(runner?.privileged).not.toBe(true);
    expect(runner?.ports ?? []).toHaveLength(0);
    expect(runner?.volumes?.some((volume) => volume.type === "bind")).toBe(false);
    expect(runner?.secrets ?? []).toHaveLength(0);
    expect(config.secrets ?? {}).toEqual({});
    expect(runner?.environment?.SANDBOX_RUNNER_TOKEN).toBe(integrationToken);
    expect(runner?.environment?.SANDBOX_RUNNER_TOKEN_FILE).toBeUndefined();
    expect(
      runner?.volumes?.some(
        (volume) =>
          volume.source?.includes("docker.sock") === true ||
          volume.target?.includes("docker.sock") === true,
      ),
    ).toBe(false);
    expect(config.networks.sandbox?.internal).toBe(true);
    expect(Object.keys(runner?.networks ?? {})).toEqual(["sandbox"]);
    expect(runner?.environment?.SANDBOX_EGRESS_ALLOW).toBeUndefined();
    expect(runner?.environment?.SANDBOX_EGRESS_PROXY_URL).toBeUndefined();
    expect(runner?.read_only).toBe(true);
    expect(runner?.user).toBe("0:0");
    expect(runner?.entrypoint).toContain(`--reuid=${String(integrationUid)}`);
    expect(runner?.entrypoint).toContain(`--regid=${String(integrationGid)}`);
    expect(runner?.cap_drop).toEqual(["ALL"]);
    expect(runner?.cap_add).toEqual(["SETUID", "SETGID", "SETPCAP"]);
    expect(runner?.pids_limit).toBeGreaterThan(0);
    expect(runner?.mem_limit).toBeDefined();
    expect(runner?.cpus).toBeGreaterThan(0);
  });

  it("echoes argv over the authenticated API", async () => {
    const result = await runExec(makeSpec(["/bin/echo", "runner-ready"]));

    expect(result).toMatchObject({ exitCode: 0, stdout: "runner-ready\n" });
  });

  // threat: T-12
  it("runs file tools as the command uid for private command-created files", async () => {
    const ownedRun = Id.parse("00000000000000000000000043");
    const createFiles = await runExec(
      makeSpec([
        "node",
        "-e",
        [
          'const fs = require("node:fs");',
          'fs.writeFileSync("private.txt", "before", { mode: 0o600 });',
          'fs.mkdirSync("private", { mode: 0o700 });',
          'fs.writeFileSync("private/edit.txt", "private-before", { mode: 0o600 });',
        ].join(""),
      ]),
      ownedRun,
    );
    expect(createFiles.exitCode).toBe(0);

    const overwrite = await requestRunner(
      {
        runId: ownedRun,
        request: {
          operation: "write",
          input: { path: "private.txt", content: "after", mode: "overwrite" },
        },
      },
      { token: integrationToken, path: "/fs/write" },
    );
    const edit = await requestRunner(
      {
        runId: ownedRun,
        request: {
          operation: "edit",
          input: {
            path: "private/edit.txt",
            edits: [{ oldText: "private-before", newText: "private-after" }],
          },
        },
      },
      { token: integrationToken, path: "/fs/edit" },
    );
    const createInPrivateDirectory = await requestRunner(
      {
        runId: ownedRun,
        request: {
          operation: "write",
          input: { path: "private/new.txt", content: "created", mode: "create" },
        },
      },
      { token: integrationToken, path: "/fs/write" },
    );

    expect(overwrite.status).toBe(200);
    expect(edit.status).toBe(200);
    expect(createInPrivateDirectory.status).toBe(200);
    expect(parseJson(FsToolResultSchema, overwrite.body)).toMatchObject({ bytes: 5 });
    expect(parseJson(FsToolResultSchema, edit.body)).toMatchObject({ bytes: 13 });
    expect(parseJson(FsToolResultSchema, createInPrivateDirectory.body)).toMatchObject({
      bytes: 7,
    });
  });

  // threat: T-13
  // threat: T-14
  it("denies a run access to files in a released run through relative, absolute, and symlink paths", async () => {
    const runA = Id.parse("00000000000000000000000031");
    const runB = Id.parse("00000000000000000000000032");
    await requestRunner(
      { runId: Id.parse("00000000000000000000000001") },
      { token: integrationToken, path: "/release" },
    );
    const leaseB = await requestRunner(
      { runId: runB, ttlMs: 30_000 },
      {
        token: integrationToken,
        path: "/lease",
      },
    );
    expect(leaseB.status).toBe(200);
    const created = await runExec(
      makeSpec([
        "node",
        "-e",
        'require("node:fs").writeFileSync("private.txt", "synthetic-run-b")',
      ]),
      runB,
    );
    expect(created.exitCode).toBe(0);
    expect(
      (
        await requestRunner(
          { runId: runB },
          {
            token: integrationToken,
            path: "/release",
          },
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await requestRunner(
          { runId: runA, ttlMs: 30_000 },
          {
            token: integrationToken,
            path: "/lease",
          },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await requestRunner(
          { runId: runB, ttlMs: 30_000 },
          {
            token: integrationToken,
            path: "/lease",
          },
        )
      ).status,
    ).toBe(409);

    const probe = [
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      `const target = "/workspaces/${runB}/project/private.txt";`,
      `const relative = "../../${runB}/project/private.txt";`,
      'const volumeArtifact = "/workspaces/exec-root-artifact";',
      'const link = path.join(process.cwd(), "outside-link");',
      'fs.writeFileSync("local.txt", "synthetic");',
      "try { fs.symlinkSync(target, link); } catch {}",
      "const denied = (action) => { try { action(); return false; } catch { return true; } };",
      'const results = [denied(() => fs.readFileSync(relative)), denied(() => fs.readFileSync(target)), denied(() => fs.readdirSync(path.dirname(target))), denied(() => fs.writeFileSync(target, "changed")), denied(() => fs.readFileSync(link)), denied(() => fs.writeFileSync(volumeArtifact, "leak")), denied(() => fs.linkSync("local.txt", volumeArtifact)), denied(() => fs.renameSync("../.harness", "../.harness-renamed"))];',
      "process.stdout.write(JSON.stringify(results));",
    ].join("\n");
    const isolated = await runExec(makeSpec(["node", "-e", probe]), runA);
    expect(isolated).toMatchObject({
      exitCode: 0,
      stdout: "[true,true,true,true,true,true,true,true]",
    });
    expect(
      (
        await requestRunner(
          { runId: runA },
          {
            token: integrationToken,
            path: "/release",
          },
        )
      ).status,
    ).toBe(200);
  }, 30_000);

  // threat: T-14
  it("keeps runner-owned directory modes usable by the harness and execution identities", async () => {
    const harnessFirstRun = Id.parse("00000000000000000000000034");
    const runnerFirstRun = Id.parse("00000000000000000000000035");
    const tryHarnessFirst = [
      "(async () => {",
      'const fs = require("node:fs");',
      'const { FsWorkspace } = await import("@harness/sandbox");',
      'const { Id } = await import("@harness/schemas");',
      `const runId = Id.parse("${harnessFirstRun}");`,
      'try { await new FsWorkspace({ workspaceRoot: "/workspaces", runId }).write(".harness/offload/value", new TextEncoder().encode("x")); } catch {}',
      "process.stdout.write(String(fs.existsSync(`/workspaces/${runId}`))); })().catch(() => process.exit(1));",
    ].join("\n");
    expect(await executeInRunner(tryHarnessFirst, "10001:10003")).toBe("false");
    expect(
      (
        await requestRunner(
          { runId: harnessFirstRun, ttlMs: 30_000 },
          { token: integrationToken, path: "/lease" },
        )
      ).status,
    ).toBe(200);
    const writeFromHarness = [
      "(async () => {",
      'const { FsWorkspace } = await import("@harness/sandbox");',
      'const { Id } = await import("@harness/schemas");',
      `const runId = Id.parse("${harnessFirstRun}");`,
      'await new FsWorkspace({ workspaceRoot: "/workspaces", runId }).write(".harness/offload/value", new TextEncoder().encode("x"));',
      'process.stdout.write("ok"); })().catch(() => process.exit(1));',
    ].join("\n");
    expect(await executeInRunner(writeFromHarness, "10001:10003")).toBe("ok");
    expect(
      (
        await requestRunner(
          { runId: harnessFirstRun },
          { token: integrationToken, path: "/release" },
        )
      ).status,
    ).toBe(200);

    expect(
      (
        await requestRunner(
          { runId: runnerFirstRun, ttlMs: 30_000 },
          { token: integrationToken, path: "/lease" },
        )
      ).status,
    ).toBe(200);
    const writeAfterRunner = [
      "(async () => {",
      'const { FsWorkspace } = await import("@harness/sandbox");',
      'const { Id } = await import("@harness/schemas");',
      `const runId = Id.parse("${runnerFirstRun}");`,
      'await new FsWorkspace({ workspaceRoot: "/workspaces", runId }).write(".harness/offload/value", new TextEncoder().encode("x"));',
      'process.stdout.write("ok"); })().catch(() => process.exit(1));',
    ].join("\n");
    expect(await executeInRunner(writeAfterRunner, "10001:10003")).toBe("ok");
    expect(
      (
        await requestRunner(
          { runId: runnerFirstRun },
          { token: integrationToken, path: "/release" },
        )
      ).status,
    ).toBe(200);
  }, 30_000);

  // threat: T-14
  it("cleans command-owned private scratch trees between leases", async () => {
    const runId = Id.parse("00000000000000000000000033");
    expect(
      (await requestRunner({ runId, ttlMs: 30_000 }, { token: integrationToken, path: "/lease" }))
        .status,
    ).toBe(200);
    const createScratch = [
      'const fs = require("node:fs");',
      "const scratch = `${String(process.env.TMPDIR)}/private`;",
      "fs.mkdirSync(scratch, { mode: 0o700 });",
      'fs.writeFileSync(`${scratch}/file`, "synthetic");',
      'fs.mkdirSync("/tmp/runner-private-tree", { mode: 0o700 });',
      'fs.writeFileSync("/tmp/runner-private-tree/file", "synthetic");',
    ].join("\n");
    const created = await runExec(makeSpec(["node", "-e", createScratch]), runId);
    expect(created.exitCode).toBe(0);
    expect(
      (await requestRunner({ runId }, { token: integrationToken, path: "/release" })).status,
    ).toBe(200);
    expect(
      (await requestRunner({ runId, ttlMs: 30_000 }, { token: integrationToken, path: "/lease" }))
        .status,
    ).toBe(200);
    const verifyCleanup = [
      'const fs = require("node:fs");',
      "const absent = (path) => { try { fs.statSync(path); return false; } catch { return true; } };",
      'process.stdout.write(JSON.stringify([absent(`${String(process.env.TMPDIR)}/private`), absent("/tmp/runner-private-tree")]));',
    ].join("\n");
    await expect(runExec(makeSpec(["node", "-e", verifyCleanup]), runId)).resolves.toMatchObject({
      exitCode: 0,
      stdout: "[true,true]",
    });
    expect(
      (await requestRunner({ runId }, { token: integrationToken, path: "/release" })).status,
    ).toBe(200);
  }, 30_000);

  // threat: T-05
  // threat: T-06
  it("cannot connect directly to external or metadata destinations without an egress profile", async () => {
    const script = [
      'const net = require("node:net");',
      "const probe = (host, port) => new Promise((resolve) => {",
      "  const socket = net.connect({ host, port }); let done = false;",
      "  const finish = (connected) => { if (!done) { done = true; socket.destroy(); resolve(connected); } };",
      '  socket.setTimeout(750, () => finish(false)); socket.once("connect", () => finish(true)); socket.once("error", () => finish(false));',
      "});",
      'Promise.all([probe("1.1.1.1", 443), probe("169.254.169.254", 80)]).then((results) => process.stdout.write(JSON.stringify(results)));',
    ].join("\n");
    const result = await runExec(makeSpec(["node", "-e", script]));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("[false,false]");
  });

  // threat: T-02
  it("runs commands under the dedicated execution uid and gid", async () => {
    const result = await runExec(
      makeSpec([
        "node",
        "-e",
        "process.stdout.write(`${String(process.getuid())}:${String(process.getgid())}`)",
      ]),
    );

    expect(result.stdout).toBe("10003:10003");
    expect(result.stdout).not.toBe(`${String(integrationUid)}:${String(integrationGid)}`);
  });

  // threat: T-02
  // threat: T-18
  it("gives sandbox commands no capabilities and denies credential escalation (T-02, T-18)", async () => {
    const script = [
      'const fs = require("node:fs");',
      'const status = fs.readFileSync("/proc/self/status", "utf8");',
      'const capabilities = ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"];',
      'const values = Object.fromEntries(capabilities.map((name) => [name, status.match(new RegExp(`^${name}:\\\\s+([0-9a-f]+)$`, "m"))?.[1]]));',
      'let uidError = ""; let gidError = "";',
      'try { process.setuid(10002); } catch (error) { uidError = error.code ?? ""; }',
      'try { process.setgid(10002); } catch (error) { gidError = error.code ?? ""; }',
      "const supplementaryGroups = process.getgroups().filter((group) => group !== process.getgid());",
      'const token = "synthetic-runner-token-for-integration";',
      'const tokenInChildEnvironment = Object.entries(process.env).some(([key, value]) => key === "SANDBOX_RUNNER_TOKEN" || value?.includes(token) === true);',
      'let procOneEnvironmentReadable = false; let serverPid = ""; let serverEnvironmentReadable = false; let signalError = "";',
      'try { fs.readFileSync("/proc/1/environ"); procOneEnvironmentReadable = true; } catch {}',
      'for (const pid of fs.readdirSync("/proc").filter((entry) => /^\\d+$/u.test(entry) && entry !== String(process.pid))) { try { if (fs.readFileSync(`/proc/${pid}/cmdline`).includes(Buffer.from("packages/sandbox/dist/runner/src/server.js"))) serverPid = pid; } catch {} }',
      'if (serverPid !== "") { try { fs.readFileSync(`/proc/${serverPid}/environ`); serverEnvironmentReadable = true; } catch {} }',
      "const scannedDirectories = new Set();",
      "function containsToken(directory) {",
      "  let realDirectory; try { realDirectory = fs.realpathSync(directory); } catch { return false; }",
      "  if (scannedDirectories.has(realDirectory)) return false;",
      "  scannedDirectories.add(realDirectory);",
      "  let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }",
      "  for (const entry of entries) {",
      "    const path = `${directory}/${entry.name}`;",
      "    let isDirectory = entry.isDirectory();",
      "    if (entry.isSymbolicLink()) { try { isDirectory = fs.statSync(path).isDirectory(); } catch {} }",
      "    if (isDirectory && containsToken(path)) return true;",
      "    if (!isDirectory && (entry.isFile() || entry.isSymbolicLink())) { try { if (fs.readFileSync(path).includes(token)) return true; } catch {} }",
      "  }",
      "  return false;",
      "}",
      'const tokenInFiles = ["/run", "/app", "/workspaces"].some(containsToken);',
      'try { process.kill(1, "SIGKILL"); } catch (error) { signalError = error.code ?? ""; }',
      'process.stdout.write(JSON.stringify({ values, uidError, gidError, supplementaryGroups, tokenInChildEnvironment, procOneEnvironmentReadable, serverPidFound: serverPid !== "", serverEnvironmentReadable, tokenInFiles, signalError }));',
    ].join("\n");
    const result = await runExec(makeSpec(["node", "-e", script]));
    const parsed = parseJson(ChildCapabilitiesSchema, result.stdout);

    expect(result.exitCode).toBe(0);
    expect(parsed).toEqual({
      values: {
        CapInh: "0000000000000000",
        CapPrm: "0000000000000000",
        CapEff: "0000000000000000",
        CapBnd: "0000000000000000",
        CapAmb: "0000000000000000",
      },
      uidError: "EPERM",
      gidError: "EPERM",
      supplementaryGroups: [],
      tokenInChildEnvironment: false,
      procOneEnvironmentReadable: false,
      serverPidFound: true,
      serverEnvironmentReadable: false,
      tokenInFiles: false,
      signalError: "EPERM",
    });
    expect(await readRunnerHealthStatus()).toBe(200);
  });

  // threat: T-18
  it("rejects requests without a valid runner token", async () => {
    const response = await requestRunner({
      runId: Id.parse("00000000000000000000000001"),
      spec: makeSpec(["/bin/echo", "not-authorized"]),
    });

    expect(response.status).toBe(401);
  });

  // threat: T-19
  it("rejects unapproved Host and Origin authorities", async () => {
    const payload = {
      runId: Id.parse("00000000000000000000000001"),
      spec: makeSpec(["/bin/echo", "not-authorized"]),
    };
    const wrongHost = await requestRunner(payload, {
      token: integrationToken,
      host: "untrusted.test",
    });
    const wrongOrigin = await requestRunner(payload, {
      token: integrationToken,
      origin: "https://untrusted.test",
    });

    expect(wrongHost.status).toBe(400);
    expect(wrongOrigin.status).toBe(400);
  });

  // threat: T-07
  it("contains a process-spawning workload within the per-exec process limit", async () => {
    const script = [
      "(async () => {",
      '  const { spawn } = require("node:child_process");',
      "  const children = [];",
      "  for (let index = 0; index < 64; index += 1) {",
      '    const child = spawn("/bin/sleep", ["5"], { stdio: "ignore" });',
      '    child.once("spawn", () => children.push(child));',
      '    child.once("error", () => undefined);',
      "  }",
      "  await new Promise((resolve) => setTimeout(resolve, 250));",
      '  for (const child of children) child.kill("SIGKILL");',
      "  process.stdout.write(String(children.length));",
      "})().catch(() => { process.exitCode = 1; });",
    ].join("\n");
    const result = await runExec(
      makeSpec(["node", "-e", script], {
        limits: { memoryMb: 2048, pids: 32, outputBytes: 128, cpuSeconds: 5 },
      }),
    );

    expect(result.exitCode).toBe(0);
    expect(Number(result.stdout)).toBeLessThan(32);
    expect(await readRunnerHealthStatus()).toBe(200);
  }, 30_000);

  // threat: T-08
  it("contains a memory-hogging process", async () => {
    const result = await runExec(
      makeSpec(
        ["/usr/bin/dd", "if=/dev/zero", "of=/dev/null", "bs=256M", "count=1", "status=none"],
        {
          limits: { memoryMb: 128, pids: 16, outputBytes: 128, cpuSeconds: 5 },
        },
      ),
    );

    expect(result.exitCode).not.toBe(0);
  }, 30_000);

  // threat: T-10
  it("kills an infinite loop at the request timeout", async () => {
    const result = await runExec(
      makeSpec(["/bin/sleep", "10"], {
        timeoutMs: 500,
        limits: { memoryMb: 2048, pids: 16, outputBytes: 128, cpuSeconds: 5 },
      }),
    );

    expect(result.timedOut).toBe(true);
    expect(result.signal).toBe("SIGKILL");
  }, 30_000);

  // threat: T-16
  it("cannot write to the read-only container root", async () => {
    const script =
      'try { require("node:fs").writeFileSync("/sandbox-runner-root-probe", "test"); process.stdout.write("writable"); } catch (error) { process.stdout.write(error.code ?? "denied"); }';
    const result = await runExec(makeSpec(["node", "-e", script]));

    expect(result.stdout).not.toBe("writable");
  });

  // threat: T-02
  // threat: T-03
  // threat: T-04
  it("keeps the runner token inaccessible to commands (T-02, T-18)", async () => {
    const script = [
      'const fs = require("node:fs");',
      'const token = "synthetic-runner-token-for-integration";',
      'const childEnvironmentContainsToken = Object.entries(process.env).some(([key, value]) => key === "SANDBOX_RUNNER_TOKEN" || value?.includes(token) === true);',
      "const scannedDirectories = new Set();",
      "function containsToken(directory) {",
      "  let realDirectory; try { realDirectory = fs.realpathSync(directory); } catch { return false; }",
      "  if (scannedDirectories.has(realDirectory)) return false;",
      "  scannedDirectories.add(realDirectory);",
      "  let entries; try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }",
      "  for (const entry of entries) {",
      "    const path = `${directory}/${entry.name}`;",
      "    let isDirectory = entry.isDirectory();",
      "    if (entry.isSymbolicLink()) { try { isDirectory = fs.statSync(path).isDirectory(); } catch {} }",
      "    if (isDirectory && containsToken(path)) return true;",
      "    if (!isDirectory && (entry.isFile() || entry.isSymbolicLink())) { try { if (fs.readFileSync(path).includes(token)) return true; } catch {} }",
      "  }",
      "  return false;",
      "}",
      'const tokenInFiles = ["/run", "/app", "/workspaces"].some(containsToken);',
      "process.stdout.write(String(childEnvironmentContainsToken || tokenInFiles));",
    ].join("\n");
    const result = await runExec(makeSpec(["node", "-e", script]));

    expect(result).toMatchObject({ exitCode: 0, stdout: "false" });
  });

  // threat: T-02
  it("cannot signal the runner and leaves health available (T-02, T-18)", async () => {
    const result = await runExec(
      makeSpec([
        "node",
        "-e",
        'try { process.kill(1, "SIGKILL"); process.stdout.write("signaled"); } catch (error) { process.stdout.write(error.code ?? "denied"); }',
      ]),
    );

    expect(result.stdout).toBe("EPERM");
    expect(await readRunnerHealthStatus()).toBe(200);
  });
});

async function readRunnerHealthStatus(): Promise<number> {
  const script = [
    'const http = require("node:http");',
    'http.get({ hostname: "127.0.0.1", port: 8080, path: "/healthz", headers: { host: "sandbox-runner:8080" } }, (response) => {',
    '  response.resume(); response.on("end", () => process.stdout.write(String(response.statusCode)));',
    '}).on("error", () => process.stdout.write("0"));',
  ].join("\n");
  return Number(await executeInRunner(script));
}
