// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import { PiiConfigSchema, type PiiActionSummary, type JsonValue } from "@harness/schemas";
import { AuditingVaultResolver, InMemoryVault, type VaultAudit } from "@harness/vault";
import { PiiToolPort, type PiiToolPortLike, type PiiToolCall } from "./pii-tool-port.js";
import { Tokenizer } from "./tokenizer.js";
import { PiiBlockedError } from "./errors.js";
import { emailDetector } from "./detectors/email.js";
import { isSanitizedField } from "./pii-event-store.js";

const runId = "00000000000000000000000001";
const call = {
  callId: "00000000000000000000000002",
  toolId: "mail.send",
  args: { to: "canary@example.test", other: "canary@example.test" },
};

function objectArgs(value: JsonValue): Readonly<Record<string, JsonValue>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected JSON object arguments.");
  }
  return value;
}

function fixture(
  options: {
    readonly block?: boolean;
    readonly allow?: boolean;
    readonly result?: JsonValue;
    readonly detectorFailure?: boolean;
    readonly vaultFailure?: boolean;
    readonly resolveFailure?: boolean;
    readonly innerFailure?: boolean;
    readonly innerError?: boolean;
    readonly binary?: boolean;
    readonly detokenizeArgs?: readonly string[];
  } = {},
) {
  const config = PiiConfigSchema.parse({
    defaultAction: options.block === true ? "block" : "tokenize",
    ...(options.allow === true
      ? {
          rules: [
            {
              entities: ["email"],
              boundaries: ["tool_input", "tool_output"],
              destinations: "*",
              action: "allow",
            },
          ],
        }
      : {}),
    detokenize: [{ toolId: "mail.send", args: options.detokenizeArgs ?? ["/to"] }],
  });
  const vault = new InMemoryVault();
  if (options.vaultFailure === true) {
    vi.spyOn(vault, "put").mockRejectedValue(new Error("canary@example.test"));
  }
  if (options.resolveFailure === true) {
    vi.spyOn(vault, "resolve").mockRejectedValue(new Error("canary@example.test"));
  }
  const tokenizer = new Tokenizer({
    policy: config,
    vault,
    detectors: {
      detect: (text) => {
        if (options.detectorFailure === true) {
          throw new Error("canary@example.test");
        }
        return emailDetector.detect(text);
      },
    },
  });
  const execute = vi.fn<PiiToolPortLike["execute"]>(() => {
    if (options.innerFailure === true) {
      return Promise.reject(
        Object.assign(new Error("canary@example.test"), { code: "canary@example.test" }),
      );
    }
    return Promise.resolve({
      outcome: options.innerError === true ? "error" : "ok",
      errorCode: "attacker.canary",
      ...(options.binary === undefined ? {} : { binary: options.binary }),
      result: options.result ?? "canary@example.test",
    });
  });
  const inner: PiiToolPortLike = {
    describe: () => ({ idempotent: true, timeoutMs: 1000 }),
    execute,
  };
  const summaries: PiiActionSummary[] = [];
  const context = {
    runId,
    signal: new AbortController().signal,
    recordPiiAction: (summary: PiiActionSummary) => {
      summaries.push(summary);
      return Promise.resolve();
    },
  };
  const audits: VaultAudit[] = [];
  const port = new PiiToolPort(inner, {
    config,
    tokenizer,
    resolver: new AuditingVaultResolver(vault, (audit) => {
      audits.push(audit);
    }),
  });
  return { port, context, execute, summaries, inner, vault, audits };
}

describe("PiiToolPort", () => {
  it("prepares detached tokens, resolves only an allowlisted pointer, and sanitizes output", async () => {
    const { port, context, execute, summaries } = fixture();
    const prepared = await port.prepare(call, context);
    expect(prepared.args).toEqual({ to: "<EMAIL_1>", other: "<EMAIL_1>" });
    expect(call.args.to).toBe("canary@example.test");
    await expect(port.execute(prepared, context)).resolves.toEqual({
      outcome: "ok",
      result: "<EMAIL_1>",
    });
    expect(execute.mock.calls[0]?.[0].args).toEqual({
      to: "canary@example.test",
      other: "<EMAIL_1>",
    });
    expect(summaries.map(({ boundary }) => boundary)).toEqual(["tool_input", "tool_output"]);
    expect(JSON.stringify(summaries)).not.toContain("canary@example.test");
  });

  it("marks primitive arguments and tool results as sanitized fields", async () => {
    const { port, context } = fixture({ result: "<EMAIL_1>" });
    const prepared = await port.prepare({ ...call, args: "<EMAIL_1>" }, context);
    const result = await port.execute(prepared, context);

    expect(isSanitizedField(prepared, "args")).toBe(true);
    expect(isSanitizedField(result, "result")).toBe(true);
  });

  it("forwards metadata, tool specs and inner preparation on tokens", async () => {
    const { inner, port, context } = fixture();
    const inputSchema = { type: "object" };
    const prepare = vi.fn<(proposed: PiiToolCall) => void>();
    inner.describe = () => ({ idempotent: true, timeoutMs: 1000, inputSchema });
    inner.prepare = (proposed) => {
      prepare(proposed);
      return Promise.resolve(proposed);
    };
    inner.getToolSpecs = () => [];
    expect(port.describe("mail.send")).toEqual({
      idempotent: true,
      timeoutMs: 1000,
      inputSchema,
    });
    expect(port.getToolSpecs()).toEqual([]);
    await port.prepare(call, context);
    expect(prepare.mock.calls[0]?.[0].args).toEqual({ to: "<EMAIL_1>", other: "<EMAIL_1>" });
  });

  it("does not resolve or audit tokens outside the detokenization allowlist during validation", async () => {
    const { port, context, vault, audits } = fixture();
    const prepared = await port.prepare(
      {
        ...call,
        args: { to: "allowed@example.test", other: "forbidden@example.test" },
      },
      context,
    );
    const preparedArgs = objectArgs(prepared.args);
    const resolve = vi.spyOn(vault, "resolve");
    const schema = { type: "object" };

    await expect(
      port.validateInputSchema(call.toolId, prepared.args, schema, context),
    ).resolves.toBe(true);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith(runId, preparedArgs.to, {
      boundary: "tool_input",
      toolId: call.toolId,
    });
    expect(resolve).not.toHaveBeenCalledWith(runId, preparedArgs.other, {
      boundary: "tool_input",
      toolId: call.toolId,
    });
    expect(audits).toEqual([
      {
        runId,
        boundary: "tool_input",
        action: "detokenized",
        toolId: call.toolId,
        entities: [{ type: "email", count: 1 }],
      },
    ]);
  });

  it("validates allowlisted email tokens against their resolved format", async () => {
    const { port, context } = fixture();
    const prepared = await port.prepare(call, context);
    const preparedArgs = objectArgs(prepared.args);
    const schema = {
      type: "object",
      properties: {
        to: { type: "string", format: "email" },
      },
      required: ["to"],
    };

    await expect(
      port.validateInputSchema(call.toolId, prepared.args, schema, context),
    ).resolves.toBe(true);
    expect(preparedArgs.to).toBe("<EMAIL_1>");
  });

  it("validates non-allowlisted token constraints against what execution sends", async () => {
    const { port, context, execute } = fixture();
    const prepared = await port.prepare(
      {
        ...call,
        args: { to: "allowed@example.test", other: "forbidden@example.test" },
      },
      context,
    );
    const preparedArgs = objectArgs(prepared.args);
    const nonAllowlistedToken = preparedArgs.other;
    if (nonAllowlistedToken === undefined) {
      throw new Error("Expected a tokenized non-allowlisted argument.");
    }
    const schema = {
      type: "object",
      properties: {
        to: { type: "string", format: "email" },
        other: { type: "string", const: nonAllowlistedToken },
      },
      required: ["to", "other"],
    };

    await expect(
      port.validateInputSchema(call.toolId, prepared.args, schema, context),
    ).resolves.toBe(true);
    await port.execute(prepared, context);
    expect(execute.mock.calls[0]?.[0].args).toEqual({
      to: "allowed@example.test",
      other: nonAllowlistedToken,
    });
  });

  it("keeps allowed content out of persisted input and output", async () => {
    const { port, context } = fixture({ allow: true });
    const prepared = await port.prepare(call, context);
    expect(JSON.stringify(prepared)).not.toContain("canary@example.test");
    expect(JSON.stringify(await port.execute(prepared, context))).not.toContain(
      "canary@example.test",
    );
  });

  it.each([
    { block: true, code: "pii_blocked" },
    { detectorFailure: true, code: "pii_detector_failed" },
    { vaultFailure: true, code: "pii_vault_failed" },
  ])("fails closed during preparation ($code)", async ({ code, ...options }) => {
    const { port, context, execute } = fixture(options);
    await expect(port.prepare(call, context)).rejects.toMatchObject({ code });
    expect(execute).not.toHaveBeenCalled();
  });

  it("reports blocked input summaries", async () => {
    const { port, context, summaries } = fixture({ block: true });
    await expect(port.prepare(call, context)).rejects.toBeInstanceOf(PiiBlockedError);
    expect(summaries[0]).toMatchObject({ boundary: "tool_input", action: "block" });
  });

  it.each([
    { resolveFailure: true, code: "pii_vault_failed" },
    { innerFailure: true, code: "tool_failed" },
    { innerError: true, code: "tool_failed" },
    { result: "x".repeat(2 * 1024 * 1024), code: "pii_input_too_large" },
  ])("sanitizes execution failures ($code)", async ({ code, ...options }) => {
    const { port, context } = fixture(options);
    const prepared = await port.prepare(call, context);
    const result = await port.execute(prepared, context);
    expect(result).toMatchObject({ outcome: "error", errorCode: code });
    expect(JSON.stringify(result)).not.toContain("canary@example.test");
    expect(JSON.stringify(result)).not.toContain("attacker.canary");
  });

  it.each([
    "tool_reported_error",
    "mcp_internal_error",
    "mcp_timeout",
    "precondition_failed",
    "edit_no_match",
    "edit_ambiguous",
    "workspace_quota_exceeded",
  ] as const)("preserves trusted closed tool error code %s", async (errorCode) => {
    const { port, context, execute } = fixture();
    execute.mockResolvedValue({ outcome: "error", errorCode, result: null });
    const prepared = await port.prepare(call, context);
    await expect(port.execute(prepared, context)).resolves.toMatchObject({
      outcome: "error",
      errorCode,
      result: null,
    });
  });

  it("rejects unresolved tokens before execution", async () => {
    const { port, context, execute } = fixture();
    await expect(port.execute({ ...call, args: { to: "<EMAIL_99>" } }, context)).resolves.toEqual({
      outcome: "error",
      errorCode: "pii_token_unresolvable",
      result: null,
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("blocks raw output, records only counts, and returns no result content", async () => {
    const { port, context, summaries } = fixture({ block: true });
    await expect(port.execute({ ...call, args: {} }, context)).resolves.toEqual({
      outcome: "error",
      errorCode: "pii_blocked",
      result: null,
    });
    expect(summaries[0]).toMatchObject({ boundary: "tool_output", action: "block" });
  });

  it("fails closed when output detection fails", async () => {
    const { port, context } = fixture({ detectorFailure: true });
    await expect(port.execute({ ...call, args: {} }, context)).resolves.toEqual({
      outcome: "error",
      errorCode: "pii_detector_failed",
      result: null,
    });
  });

  it("works without a summary sink and propagates summary persistence failure", async () => {
    const { port, context } = fixture();
    const bare = { runId, signal: context.signal };
    const prepared = await port.prepare(call, bare);
    await expect(port.execute(prepared, bare)).resolves.toMatchObject({ outcome: "ok" });
    const failing = {
      ...context,
      recordPiiAction: () => Promise.reject(new Error("record failed")),
    };
    await expect(port.prepare(call, failing)).rejects.toThrow("record failed");
    await expect(port.execute(prepared, failing)).rejects.toThrow("record failed");
  });

  it("rejects a textual payload falsely flagged binary", async () => {
    const { port, context } = fixture({
      binary: true,
      result: "canary@example.test",
    });

    await expect(port.execute({ ...call, args: {} }, context)).resolves.toEqual({
      outcome: "error",
      errorCode: "pii_input_invalid",
      result: null,
    });
  });

  it("accepts only validated numeric bytes for the binary bypass", async () => {
    const { port, context } = fixture({ binary: true, result: [0, 255] });
    await expect(port.execute({ ...call, args: {} }, context)).resolves.toEqual({
      outcome: "ok",
      result: [0, 255],
      binary: true,
    });
  });

  it("rejects oversized numeric arrays unless explicitly flagged binary", async () => {
    const { port, context } = fixture({ result: Array.from({ length: 530000 }, () => 255) });
    await expect(port.execute({ ...call, args: {} }, context)).resolves.toEqual({
      outcome: "error",
      errorCode: "pii_input_too_large",
      result: null,
    });
  });

  it("preserves cancellation exceptions for the loop's shutdown recovery", async () => {
    const { port, context, inner } = fixture();
    const controller = new AbortController();
    const failure = new Error("synthetic cancellation");
    inner.execute = () => {
      controller.abort("shutdown");
      return Promise.reject(failure);
    };
    const prepared = await port.prepare(call, context);
    await expect(port.execute(prepared, { ...context, signal: controller.signal })).rejects.toBe(
      failure,
    );
  });

  it("fails closed if the output vault write fails", async () => {
    const { port, context, vault } = fixture();
    vi.spyOn(vault, "put").mockRejectedValue(new Error("canary@example.test"));
    await expect(port.execute({ ...call, args: {} }, context)).resolves.toEqual({
      outcome: "error",
      errorCode: "pii_vault_failed",
      result: null,
    });
  });
});
