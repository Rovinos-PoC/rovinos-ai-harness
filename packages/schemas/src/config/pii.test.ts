// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { JsonPointerSchema, PiiConfigSchema } from "./pii.js";

describe("JSON Pointer and PII detokenization config", () => {
  it("enables runtime PII boundaries by default and accepts an explicit disable", () => {
    expect(PiiConfigSchema.parse({}).enabled).toBe(true);
    expect(PiiConfigSchema.parse({ enabled: false }).enabled).toBe(false);
  });

  it("defaults to fail-closed detection and validates optional Presidio settings", () => {
    expect(PiiConfigSchema.parse({}).failMode).toBe("closed");
    expect(PiiConfigSchema.parse({ failMode: "regex_only" }).failMode).toBe("regex_only");
    expect(
      PiiConfigSchema.parse({ presidio: { baseUrl: "http://presidio-analyzer:3000" } }).presidio,
    ).toEqual({
      baseUrl: "http://presidio-analyzer:3000",
      language: "en",
      scoreThreshold: 0.5,
    });
    expect(
      PiiConfigSchema.safeParse({
        presidio: { baseUrl: "https://example.test?token=synthetic" },
      }).success,
    ).toBe(false);
    expect(PiiConfigSchema.safeParse({ presidio: { baseUrl: "http://example.com" } }).success).toBe(
      false,
    );
    expect(
      PiiConfigSchema.safeParse({ presidio: { baseUrl: "http://127.0.0.1:3000" } }).success,
    ).toBe(true);
    expect(
      PiiConfigSchema.safeParse({ presidio: { baseUrl: "https://example.com" } }).success,
    ).toBe(true);
    expect(
      PiiConfigSchema.safeParse({
        presidio: { baseUrl: "******example.test" },
      }).success,
    ).toBe(false);
    expect(
      PiiConfigSchema.safeParse({ presidio: { baseUrl: "file:///tmp/analyzer" } }).success,
    ).toBe(false);
  });

  it.each(["", "/to", "/attachments/0/name", "/a~1b", "/a~0b", "/recipients/*"])(
    "accepts pointer %s",
    (pointer) => {
      expect(JsonPointerSchema.safeParse(pointer).success).toBe(true);
    },
  );

  it.each(["to", "a/b", "/bad~2escape", "/bad~"])("rejects invalid pointer %s", (pointer) => {
    expect(JsonPointerSchema.safeParse(pointer).success).toBe(false);
  });

  it("keeps the allowlist optional and defaults entries to fail-closed", () => {
    expect(PiiConfigSchema.parse({}).detokenize).toBeUndefined();
    expect(
      PiiConfigSchema.parse({
        detokenize: [{ toolId: "mail.send", args: ["/to"] }],
      }).detokenize,
    ).toEqual([{ toolId: "mail.send", args: ["/to"], onUnresolvable: "fail" }]);
  });

  it("rejects the root pointer in a detokenization allowlist", () => {
    expect(
      PiiConfigSchema.safeParse({
        detokenize: [{ toolId: "mail.send", args: [""] }],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate tool IDs with a value-free issue path", () => {
    const result = PiiConfigSchema.safeParse({
      detokenize: [
        { toolId: "mail.send", args: ["/to"] },
        { toolId: "mail.send", args: ["/body"] },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("Expected duplicate tool IDs to fail validation");
    }
    expect(result.error.issues).toEqual([
      expect.objectContaining({
        path: ["detokenize", 1, "toolId"],
        code: "custom",
        message: "Duplicate toolId",
      }),
    ]);
    expect(JSON.stringify(result.error.issues)).not.toContain("mail.send");
  });
});
