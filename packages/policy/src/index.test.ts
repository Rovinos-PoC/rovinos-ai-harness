// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseYaml } from "@harness/schemas";
import {
  ArgMatcherSchema,
  compilePolicy,
  loadPolicy,
  PolicyDocumentSchema,
  policyVersion,
} from "./index.js";

const validYaml = `
version: 1
defaultDecision: ask
rules:
  - id: ask_email_send
    description: Ask before sending to a tokenized email address
    match:
      tools:
        - mail.send
      args:
        - pointer: /to
          op: tokenType
          value: email
    decision: ask
    reason: outbound_email
    editable:
      - /subject
    approvalTtlMs: 300000
    escalateAfterMs: 60000
`;

describe("PolicyDocumentSchema", () => {
  it("accepts the documented YAML policy", () => {
    expect(parseYaml(PolicyDocumentSchema, validYaml)).toMatchObject({
      version: 1,
      defaultDecision: "ask",
      rules: [{ match: { args: [{ op: "tokenType", value: "email" }] }, decision: "ask" }],
    });
  });

  it("rejects default allow", () => {
    expect(
      PolicyDocumentSchema.safeParse({ version: 1, defaultDecision: "allow", rules: [] }).success,
    ).toBe(false);
  });

  it("rejects duplicate rule ids", () => {
    const rule = { id: "same", match: { tools: "mail.send" }, decision: "deny", reason: "blocked" };
    expect(
      PolicyDocumentSchema.safeParse({ version: 1, defaultDecision: "deny", rules: [rule, rule] })
        .success,
    ).toBe(false);
  });

  it.each([
    {
      id: "allow_all",
      match: { tools: "*" },
      decision: "allow",
      reason: "bad",
    },
    {
      id: "allow_all_array",
      match: { tools: ["*"] },
      decision: "allow",
      reason: "bad",
    },
    {
      id: "editable_allow",
      match: { tools: "mail.send" },
      decision: "allow",
      reason: "bad",
      editable: ["/to"],
    },
    {
      id: "escalate_deny",
      match: { tools: "mail.send" },
      decision: "deny",
      reason: "bad",
      escalateAfterMs: 10,
    },
  ])("rejects unsafe rule $id", (rule) => {
    expect(
      PolicyDocumentSchema.safeParse({ version: 1, defaultDecision: "deny", rules: [rule] })
        .success,
    ).toBe(false);
  });

  it.each([["mail.*"], "*", ["mail.send", "fs.*"]])("accepts tool pattern %s", (tools) => {
    expect(
      PolicyDocumentSchema.safeParse({
        version: 1,
        defaultDecision: "deny",
        rules: [{ id: "valid", match: { tools }, decision: "deny", reason: "blocked" }],
      }).success,
    ).toBe(true);
  });

  it.each(["mail.send", "mail.*"])("rejects scalar tool pattern %s", (tools) => {
    expect(
      PolicyDocumentSchema.safeParse({
        version: 1,
        defaultDecision: "deny",
        rules: [{ id: "invalid", match: { tools }, decision: "deny", reason: "blocked" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a global wildcard inside the tool pattern array", () => {
    expect(
      PolicyDocumentSchema.safeParse({
        version: 1,
        defaultDecision: "deny",
        rules: [{ id: "invalid", match: { tools: ["*"] }, decision: "deny", reason: "blocked" }],
      }).success,
    ).toBe(false);
  });

  it.each(["mail.*.send", "mail.*send", "*.*", "mail.**", "bad~pattern"])(
    "rejects invalid tool pattern %s",
    (tools) => {
      expect(
        PolicyDocumentSchema.safeParse({
          version: 1,
          defaultDecision: "deny",
          rules: [{ id: "invalid", match: { tools }, decision: "deny", reason: "blocked" }],
        }).success,
      ).toBe(false);
    },
  );

  it.each(["", "/valid~1pointer", "/valid~0pointer"])("accepts JSON Pointer %s", (pointer) => {
    expect(ArgMatcherSchema.safeParse({ pointer, op: "exists" }).success).toBe(true);
  });

  it.each(["not/a/pointer", "/bad~2escape", "/bad~"])(
    "rejects invalid JSON Pointer %s",
    (pointer) => {
      expect(ArgMatcherSchema.safeParse({ pointer, op: "exists" }).success).toBe(false);
    },
  );

  it("rejects unsafe and syntactically invalid matches expressions", () => {
    expect(
      ArgMatcherSchema.safeParse({ pointer: "/value", op: "matches", value: "(a+)+$" }).success,
    ).toBe(false);
    expect(
      ArgMatcherSchema.safeParse({ pointer: "/value", op: "matches", value: "[" }).success,
    ).toBe(false);
    expect(
      ArgMatcherSchema.safeParse({ pointer: "/value", op: "matches", value: "\\-" }).success,
    ).toBe(false);
  });

  it("requires operation-specific values and strict object keys", () => {
    expect(ArgMatcherSchema.safeParse({ pointer: "/value", op: "equals" }).success).toBe(false);
    expect(ArgMatcherSchema.safeParse({ pointer: "/value", op: "in", value: "x" }).success).toBe(
      false,
    );
    expect(
      ArgMatcherSchema.safeParse({ pointer: "/value", op: "startsWith", value: 1 }).success,
    ).toBe(false);
    expect(
      ArgMatcherSchema.safeParse({ pointer: "/value", op: "exists", extra: true }).success,
    ).toBe(false);
    const existsWithValue = ArgMatcherSchema.safeParse({
      pointer: "/value",
      op: "exists",
      value: false,
    });
    expect(existsWithValue.success).toBe(false);
    expect(existsWithValue.success ? [] : existsWithValue.error.issues).toContainEqual(
      expect.objectContaining({
        code: "custom",
        params: { errorCode: "policy_match_value_unexpected" },
      }),
    );
  });

  it("requires positive approval timings and escalation before expiry", () => {
    const rule = {
      id: "timed_approval",
      match: { tools: ["mail.send"] },
      decision: "ask",
      reason: "approval_required",
    };
    const document = (timedRule: unknown) =>
      PolicyDocumentSchema.safeParse({
        version: 1,
        defaultDecision: "deny",
        rules: [timedRule],
      });

    expect(document({ ...rule, approvalTtlMs: 0 }).success).toBe(false);
    expect(document({ ...rule, escalateAfterMs: 0 }).success).toBe(false);
    const escalationAtExpiry = document({
      ...rule,
      approvalTtlMs: 10,
      escalateAfterMs: 10,
    });
    expect(escalationAtExpiry.success).toBe(false);
    expect(escalationAtExpiry.success ? [] : escalationAtExpiry.error.issues).toContainEqual(
      expect.objectContaining({
        code: "custom",
        params: { errorCode: "policy_escalation_after_expiry" },
      }),
    );
    expect(document({ ...rule, approvalTtlMs: 10, escalateAfterMs: 9 }).success).toBe(true);
  });
});

describe("loadPolicy and policyVersion", () => {
  it("loads the documented example policy", async () => {
    const examplePath = fileURLToPath(new URL("../../../examples/policy.yaml", import.meta.url));
    const policy = await loadPolicy(examplePath);
    expect(policy).toMatchObject({
      version: 1,
      defaultDecision: "ask",
    });
    const compiled = compilePolicy(policy);
    const evaluate = (input: Parameters<typeof compiled.evaluate>[0]) => compiled.evaluate(input);
    expect(
      evaluate({
        toolId: "fs.read",
        args: { path: "README.md" },
        context: { subagent: false },
      }).decision,
    ).toBe("allow");
    expect(
      evaluate({
        toolId: "fs.write",
        args: { path: "src/notes.txt" },
        context: { subagent: false },
      }).decision,
    ).toBe("allow");
    expect(
      evaluate({
        toolId: "fs.write",
        args: { path: "secrets/.env.local" },
        context: { subagent: false },
      }).decision,
    ).toBe("ask");
    for (const path of ["secrets/.ENV", "certificates/id.PEM"]) {
      expect(
        evaluate({
          toolId: "fs.write",
          args: { path },
          context: { subagent: false },
        }).decision,
      ).toBe("ask");
    }
    expect(
      evaluate({
        toolId: "fs.write",
        args: { path: "src/.environment" },
        context: { subagent: false },
      }).decision,
    ).toBe("allow");
  });

  it("loads YAML and JSON policy files from disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "policy-schema-"));
    try {
      const yamlPath = join(directory, "policy.yaml");
      const jsonPath = join(directory, "policy.json");
      await writeFile(yamlPath, validYaml);
      await writeFile(jsonPath, JSON.stringify(parseYaml(PolicyDocumentSchema, validYaml)));
      await expect(loadPolicy(yamlPath)).resolves.toEqual(
        parseYaml(PolicyDocumentSchema, validYaml),
      );
      await expect(loadPolicy(jsonPath)).resolves.toEqual(
        parseYaml(PolicyDocumentSchema, validYaml),
      );
      await writeFile(
        yamlPath,
        `version: 1\ndefaultDecision: deny\nrules:\n  - id: allow_all\n    match:\n      tools: "*"\n    decision: allow\n    reason: unsafe\n`,
      );
      await expect(loadPolicy(yamlPath)).rejects.toMatchObject({ code: "contract_invalid" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("produces the same policy version regardless of object key order", () => {
    const first = parseYaml(PolicyDocumentSchema, validYaml);
    const second = {
      rules: first.rules.map((rule) => ({
        reason: rule.reason,
        decision: rule.decision,
        match: {
          args: rule.match.args?.map((matcher) => ({
            value: matcher.value,
            op: matcher.op,
            pointer: matcher.pointer,
          })),
          tools: rule.match.tools,
        },
        id: rule.id,
        description: rule.description,
        editable: rule.editable,
        approvalTtlMs: rule.approvalTtlMs,
        escalateAfterMs: rule.escalateAfterMs,
      })),
      defaultDecision: first.defaultDecision,
      version: first.version,
    };
    expect(policyVersion(first)).toBe(policyVersion(second));
    expect(policyVersion(first)).toMatch(/^pol-[0-9a-f]{12}$/u);
  });

  it("ignores explicitly undefined optional properties when versioning", () => {
    const document = parseYaml(PolicyDocumentSchema, validYaml);
    const withoutDescription = {
      ...document,
      rules: document.rules.map((rule) => {
        const result = { ...rule };
        delete result.description;
        return result;
      }),
    };
    const withUndefinedDescription = {
      ...withoutDescription,
      rules: withoutDescription.rules.map((rule) => ({ ...rule, description: undefined })),
    };
    expect(policyVersion(withUndefinedDescription)).toBe(policyVersion(withoutDescription));
  });
});
