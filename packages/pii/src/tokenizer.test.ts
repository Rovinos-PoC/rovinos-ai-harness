// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";
import {
  EventSchema,
  PiiPresidioConfigSchema,
  PiiActionSummarySchema,
  PiiPolicySchema,
  type Detection,
  type JsonValue,
  type PiiAction,
} from "@harness/schemas";
import { InMemoryVault, type VaultWriter } from "@harness/vault";
import { PresidioDetector } from "./detectors/presidio.js";
import { DetectorRegistry } from "./detectors/registry.js";
import {
  PiiBlockedError,
  PiiDetectorError,
  PiiTokenizerError,
  toPiiActionEvent,
  Tokenizer,
} from "./index.js";
import type { PiiDetectorRegistry } from "./tokenizer.js";

const runA = "A".repeat(26);
const runB = "B".repeat(26);
const resolveContext = { boundary: "tool_input" } as const;
const context = { boundary: "model_input", destination: "hosted" } as const;

function emailDetector(text: string): Detection[] {
  return [...text.matchAll(/[\w.+%-]+@[\w.-]+\.[A-Z]{2,}/giu)].map((match) => ({
    entityType: "email",
    start: match.index,
    end: match.index + match[0].length,
    confidence: 1,
    detectorId: "test.email",
  }));
}

function createTokenizer(
  action: PiiAction = "tokenize",
  vault: VaultWriter = new InMemoryVault(),
  detect: (text: string) => readonly Detection[] | Promise<readonly Detection[]> = emailDetector,
  scopeOf?: (runId: string) => string,
): Tokenizer {
  const policy =
    action === "allow"
      ? PiiPolicySchema.parse({
          rules: [
            {
              entities: ["email"],
              boundaries: ["model_input"],
              destinations: ["hosted"],
              action,
            },
          ],
        })
      : PiiPolicySchema.parse({ defaultAction: action });
  const detectors: PiiDetectorRegistry = { detect };
  return new Tokenizer({ detectors, policy, vault, ...(scopeOf === undefined ? {} : { scopeOf }) });
}

describe("Tokenizer.tokenizeText", () => {
  it.each([
    {
      action: "tokenize" as const,
      expected: "Contact <EMAIL_1>",
      actions: [
        { boundary: "model_input", action: "tokenize", entities: [{ type: "email", count: 1 }] },
      ],
    },
    {
      action: "redact" as const,
      expected: "Contact [REDACTED:email]",
      actions: [
        { boundary: "model_input", action: "redact", entities: [{ type: "email", count: 1 }] },
      ],
    },
    {
      action: "allow" as const,
      expected: "Contact alice@example.test",
      actions: [
        { boundary: "model_input", action: "allow", entities: [{ type: "email", count: 1 }] },
      ],
    },
  ])("applies the $action policy action", async ({ action, expected, actions }) => {
    const vault = new InMemoryVault();
    const tokenizer = createTokenizer(action, vault);
    const result = await tokenizer.tokenizeText(runA, "Contact alice@example.test", context);

    expect(result).toEqual({ text: expected, actions });
    expect(PiiActionSummarySchema.array().parse(result.actions)).toEqual(actions);
    await expect(vault.stats(runA)).resolves.toEqual({ entries: action === "tokenize" ? 1 : 0 });
  });

  it("replaces multiple and adjacent detections from the end without shifting offsets", async () => {
    const tokenizer = createTokenizer();

    await expect(
      tokenizer.tokenizeText(
        runA,
        "alice@example.test,bob@example.test then charlie@example.test",
        context,
      ),
    ).resolves.toMatchObject({
      text: "<EMAIL_1>,<EMAIL_2> then <EMAIL_3>",
      actions: [{ action: "tokenize", entities: [{ type: "email", count: 3 }] }],
    });
  });

  it("writes child tokens into the registered root scope", async () => {
    const vault = new InMemoryVault();
    const tokenizer = createTokenizer("tokenize", vault, emailDetector, () => runA);

    await expect(
      tokenizer.tokenizeText(runB, "Contact alice@example.test", context),
    ).resolves.toMatchObject({ text: "Contact <EMAIL_1>" });

    await expect(vault.stats(runA)).resolves.toEqual({ entries: 1 });
    await expect(vault.stats(runB)).resolves.toEqual({ entries: 0 });
  });

  it("does not scan existing tokens and is idempotent on its output", async () => {
    const detect = vi.fn(emailDetector);
    const tokenizer = createTokenizer("tokenize", new InMemoryVault(), detect);
    const first = await tokenizer.tokenizeText(runA, "alice@example.test <EMAIL_9>", context);
    const second = await tokenizer.tokenizeText(runA, first.text, context);

    expect(first.text).toBe("<EMAIL_1> <EMAIL_9>");
    expect(second).toEqual({ text: first.text, actions: [] });
    expect(detect).toHaveBeenCalledTimes(2);
    expect(detect.mock.calls.every(([text]) => !text.includes("<EMAIL_9>"))).toBe(true);
    expect(detect.mock.calls.map(([text]) => text.length)).toEqual([
      "alice@example.test <EMAIL_9>".length,
      first.text.length,
    ]);
  });

  it("uses independent token mappings per run, including for identical values", async () => {
    const vault = new InMemoryVault();
    const tokenizer = createTokenizer("tokenize", vault);
    const firstA = await tokenizer.tokenizeText(runA, "alice@example.test", context);
    const firstB = await tokenizer.tokenizeText(runB, "bob@example.test", context);
    const repeatedA = await tokenizer.tokenizeText(runA, "alice@example.test", context);
    const sharedA = await tokenizer.tokenizeText(runA, "shared@example.test", context);
    const sharedB = await tokenizer.tokenizeText(runB, "shared@example.test", context);

    expect(firstA.text).toBe("<EMAIL_1>");
    expect(firstB.text).toBe("<EMAIL_1>");
    expect(repeatedA.text).toBe(firstA.text);
    expect(await vault.resolve(runA, "<EMAIL_1>", resolveContext)).toBe("alice@example.test");
    expect(await vault.resolve(runB, "<EMAIL_1>", resolveContext)).toBe("bob@example.test");
    expect(sharedA.text).toBe("<EMAIL_2>");
    expect(sharedB.text).toBe("<EMAIL_2>");
    expect(await vault.resolve(runA, "<EMAIL_2>", resolveContext)).toBe("shared@example.test");
    expect(await vault.resolve(runB, "<EMAIL_2>", resolveContext)).toBe("shared@example.test");
    await expect(vault.stats(runA)).resolves.toEqual({ entries: 2 });
    await expect(vault.stats(runB)).resolves.toEqual({ entries: 2 });
  });

  it("detects token-heavy text once without inspecting token contents", async () => {
    const detect = vi.fn(emailDetector);
    const result = await createTokenizer("tokenize", new InMemoryVault(), detect).tokenizeText(
      runA,
      "<EMAIL_9> alice@example.test ".repeat(1000),
      context,
    );
    expect(result.text).toBe("<EMAIL_9> <EMAIL_1> ".repeat(1000));
    expect(detect).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls[0]?.[0]).not.toContain("<EMAIL_9>");
    expect(result.actions).toMatchObject([{ entities: [{ type: "email", count: 1000 }] }]);
  });

  it("uses the strictest policy action for overlapping detections and replaces their union", async () => {
    const text = "prefix alice@example.test suffix";
    const policy = PiiPolicySchema.parse({
      defaultAction: "tokenize",
      rules: [
        {
          entities: ["custom_org_id"],
          boundaries: ["model_input"],
          destinations: ["hosted"],
          action: "allow",
        },
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["hosted"],
          action: "tokenize",
        },
      ],
    });
    const tokenizer = new Tokenizer({
      detectors: {
        detect: (input) => [
          {
            entityType: "custom_org_id",
            start: 0,
            end: input.length,
            confidence: 1,
            detectorId: "test.custom",
          },
          ...emailDetector(input),
        ],
      },
      policy,
      vault: new InMemoryVault(),
    });

    const result = await tokenizer.tokenizeText(runA, text, context);

    expect(result.text).toBe("<EMAIL_1>");
    expect(result.text).not.toContain("alice@example.test");
    expect(result.actions).toEqual([
      { boundary: "model_input", action: "tokenize", entities: [{ type: "email", count: 1 }] },
    ]);
  });

  it("surfaces a closed-breaker Presidio failure through tokenizeText without output or events", async () => {
    const rawText = "tokenizer-presidio-sensitive-value";
    const fetcher = vi.fn(() => Promise.reject(new Error(rawText)));
    const detector = new PresidioDetector(
      PiiPresidioConfigSchema.parse({ baseUrl: "http://presidio:3000" }),
      { clock: { now: () => 0 }, fetcher },
    );
    const tokenizer = new Tokenizer({
      detectors: new DetectorRegistry({ asyncDetectors: [detector] }),
      policy: PiiPolicySchema.parse({ defaultAction: "tokenize" }),
      vault: new InMemoryVault(),
    });
    const recordedEvents: unknown[] = [];
    let output: string | undefined;
    const failure = await tokenizer
      .tokenizeText(runA, rawText, context)
      .then((result) => {
        output = result.text;
        recordedEvents.push(...result.actions.map(toPiiActionEvent));
        return undefined;
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: "pii_detector_unavailable" });
    expect(String(failure)).not.toContain(rawText);
    expect(JSON.stringify(failure)).not.toContain(rawText);
    expect(output).toBeUndefined();
    expect(recordedEvents).toEqual([]);
    expect(JSON.stringify(recordedEvents)).not.toContain(rawText);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(["open", "half-open"] as const)(
    "fails tokenization without exposing raw text when Presidio fails in the %s breaker state",
    async (breakerState) => {
      let now = 0;
      const rawText = "tokenizer-presidio-sensitive-value";
      const fetcher = vi.fn(() => Promise.reject(new Error(rawText)));
      const detector = new PresidioDetector(
        PiiPresidioConfigSchema.parse({ baseUrl: "http://presidio:3000" }),
        { clock: { now: () => now }, fetcher },
      );
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await expect(detector.detect(rawText)).rejects.toMatchObject({
          code: "pii_detector_unavailable",
        });
      }
      if (breakerState === "half-open") {
        now += 30_000;
      }
      const tokenizer = new Tokenizer({
        detectors: new DetectorRegistry({ asyncDetectors: [detector] }),
        policy: PiiPolicySchema.parse({ defaultAction: "tokenize" }),
        vault: new InMemoryVault(),
      });

      const failure = await tokenizer
        .tokenizeText(runA, rawText, context)
        .catch((error: unknown) => error);

      expect(failure).toMatchObject({ code: "pii_detector_unavailable" });
      expect(String(failure)).not.toContain(rawText);
      expect(JSON.stringify(failure)).not.toContain(rawText);
      expect(fetcher).toHaveBeenCalledTimes(breakerState === "half-open" ? 6 : 5);
    },
  );

  it("exports a converter that produces a valid pii_action event payload", () => {
    const summary = PiiActionSummarySchema.parse({
      boundary: "model_input",
      action: "tokenize",
      entities: [{ type: "email", count: 1 }],
    });
    const event = EventSchema.parse({
      runId: "A".repeat(26),
      segmentId: "B".repeat(26),
      seq: 0,
      ts: 0,
      v: 1,
      traceId: "1".repeat(32),
      spanId: "2".repeat(16),
      type: "pii_action",
      ...toPiiActionEvent(summary),
    });

    expect(event).toMatchObject({ type: "pii_action", action: "tokenized" });
  });

  it("aggregates all blocked detections and does not write any values", async () => {
    const vault = new InMemoryVault();
    const tokenizer = createTokenizer("block", vault);

    let error: PiiBlockedError | undefined;
    try {
      await tokenizer.tokenizeText(runA, "alice@example.test and bob@example.test", context);
    } catch (caught) {
      if (caught instanceof PiiBlockedError) {
        error = caught;
      }
    }

    expect(error).toBeInstanceOf(PiiBlockedError);
    expect(error?.code).toBe("pii_blocked");
    expect(error?.entities).toEqual([{ type: "email", count: 2 }]);
    expect(error?.message).not.toContain("alice@example.test");
    expect(JSON.stringify(error)).not.toContain("bob@example.test");
    await expect(vault.stats(runA)).resolves.toEqual({ entries: 0 });
  });

  it("fails closed with value-free errors when detection or vault writes fail", async () => {
    const detectorFailure = createTokenizer("tokenize", new InMemoryVault(), () => {
      throw new Error("alice@example.test");
    });
    await expect(
      detectorFailure.tokenizeText(runA, "alice@example.test", context),
    ).rejects.toMatchObject({
      code: "pii_detector_failed",
      message: "pii_detector_failed",
    });

    const vaultFailure = createTokenizer("tokenize", {
      put: () => Promise.reject(new Error("alice@example.test")),
    });
    await expect(
      vaultFailure.tokenizeText(runA, "alice@example.test", context),
    ).rejects.toMatchObject({
      code: "pii_vault_failed",
      message: "pii_vault_failed",
    });
  });

  it("preserves the safe unavailable code from the async detector registry", async () => {
    const sensitiveValue = "synthetic-detector-canary";
    const tokenizer = createTokenizer("tokenize", new InMemoryVault(), () =>
      Promise.reject(new PiiDetectorError("pii_detector_unavailable")),
    );

    await expect(tokenizer.tokenizeText(runA, sensitiveValue, context)).rejects.toMatchObject({
      code: "pii_detector_unavailable",
      message: "pii_detector_unavailable",
    });
  });

  it("rejects detector offsets outside the scanned text without exposing content", async () => {
    const tokenizer = createTokenizer("tokenize", new InMemoryVault(), () => [
      {
        entityType: "email",
        start: 0,
        end: 100,
        confidence: 1,
        detectorId: "test.email",
      },
    ]);

    await expect(tokenizer.tokenizeText(runA, "alice@example.test", context)).rejects.toMatchObject(
      {
        code: "pii_detector_invalid_output",
        message: "pii_detector_invalid_output",
      },
    );
  });

  it("has no actions for text without detections", async () => {
    await expect(
      createTokenizer().tokenizeText(runA, "no sensitive data", context),
    ).resolves.toEqual({ text: "no sensitive data", actions: [] });
  });
});

describe("Tokenizer.tokenizeJson", () => {
  class CustomContainer {
    readonly value = "safe";
  }

  it("preserves and scans own __proto__ properties", async () => {
    const input = Object.fromEntries([["__proto__", "alice@example.test"]]);
    await expect(createTokenizer("block").tokenizeJson(runA, input, context)).rejects.toMatchObject(
      {
        code: "pii_blocked",
        entities: [{ type: "email", count: 1 }],
      },
    );
    const result = await createTokenizer().tokenizeJson(runA, input, context);
    expect(result.value).toEqual(Object.fromEntries([["__proto__", "<EMAIL_1>"]]));
  });

  it("bounds copying of shared subtrees before detection", async () => {
    let input: JsonValue = "alice@example.test";
    for (let index = 0; index < 30; index++) {
      input = [input, input];
    }
    const detect = vi.fn(emailDetector);
    await expect(
      createTokenizer("tokenize", new InMemoryVault(), detect).tokenizeJson(runA, input, context),
    ).rejects.toMatchObject({ code: "pii_input_too_large" });
    expect(detect).not.toHaveBeenCalled();
  });

  it("does not invoke custom array iterators while taking the JSON snapshot", async () => {
    const input: JsonValue[] = ["alice@example.test"];
    const iterator = vi.fn(() => {
      throw new Error("alice@example.test");
    });
    Object.defineProperty(input, Symbol.iterator, { value: iterator });

    const result = await createTokenizer().tokenizeJson(runA, input, context);

    expect(result.value).toEqual(["<EMAIL_1>"]);
    expect(iterator).not.toHaveBeenCalled();
  });

  it("rejects oversized sparse arrays before detection", async () => {
    const input: JsonValue[] = [];
    input.length = 2 * 1024 * 1024 + 1;
    const detect = vi.fn(emailDetector);

    await expect(
      createTokenizer("tokenize", new InMemoryVault(), detect).tokenizeJson(runA, input, context),
    ).rejects.toMatchObject({ code: "pii_input_too_large" });
    expect(detect).not.toHaveBeenCalled();
  });

  it("rejects excessive JSON string counts before detection", async () => {
    const input: JsonValue[] = Array.from({ length: 1025 }, () => "safe");
    const detect = vi.fn(emailDetector);

    await expect(
      createTokenizer("tokenize", new InMemoryVault(), detect).tokenizeJson(runA, input, context),
    ).rejects.toMatchObject({ code: "pii_input_too_large" });
    expect(detect).not.toHaveBeenCalled();
  });

  it("preserves JSON structure, leaves safe keys untouched, and summarizes string values", async () => {
    const tokenizer = createTokenizer();
    const input: JsonValue = {
      contacts: ["first alice@example.test", { contact: "bob@example.test" }],
      enabled: true,
      count: 3,
      absent: null,
    };
    const result = await tokenizer.tokenizeJson(runA, input, context);

    expect(result.value).toEqual({
      contacts: ["first <EMAIL_1>", { contact: "<EMAIL_2>" }],
      enabled: true,
      count: 3,
      absent: null,
    });
    expect(result.actions).toEqual([
      { boundary: "model_input", action: "tokenize", entities: [{ type: "email", count: 2 }] },
    ]);
    expect(input).toEqual({
      contacts: ["first alice@example.test", { contact: "bob@example.test" }],
      enabled: true,
      count: 3,
      absent: null,
    });
  });

  it.each(["tokenize", "redact", "block"] as const)(
    "rejects %s PII in keys with counts only and no vault writes",
    async (action) => {
      const vault = new InMemoryVault();
      const tokenizer = createTokenizer(action, vault);
      const input = {
        contact: "value@example.test",
        nested: { "alice@example.test": null, "bob@example.test": true },
      };

      const error = await tokenizer
        .tokenizeJson(runA, input, context)
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PiiTokenizerError);
      expect(error).toMatchObject({
        code: "pii_key_contains_pii",
        message: "pii_key_contains_pii",
        entities: [{ type: "email", count: 2 }],
      });
      expect(JSON.stringify(error)).not.toContain("@example.test");
      await expect(vault.stats(runA)).resolves.toEqual({ entries: 0 });
    },
  );

  it("preserves allow-policy keys and counts their detections", async () => {
    await expect(
      createTokenizer("allow").tokenizeJson(runA, { "alice@example.test": null }, context),
    ).resolves.toEqual({
      value: { "alice@example.test": null },
      actions: [
        { boundary: "model_input", action: "allow", entities: [{ type: "email", count: 1 }] },
      ],
    });
  });

  it("normalizes throwing getters and proxies to value-free input errors", async () => {
    const getter: Record<string, JsonValue> = {};
    Object.defineProperty(getter, "email", {
      enumerable: true,
      get() {
        throw new Error("alice@example.test");
      },
    });
    const proxy = new Proxy<Record<string, JsonValue>>(
      {},
      {
        ownKeys() {
          throw new Error("bob@example.test");
        },
      },
    );
    for (const input of [getter, proxy]) {
      await expect(createTokenizer().tokenizeJson(runA, input, context)).rejects.toMatchObject({
        code: "pii_input_invalid",
        message: "pii_input_invalid",
      });
    }
  });

  it("reads caller accessors once and uses an independent validated copy", async () => {
    const input: Record<string, JsonValue> = {};
    const get = vi.fn(() => "alice@example.test");
    const detect = vi.fn((text: string) => {
      Object.defineProperty(input, "email", { value: "bob@example.test", configurable: true });
      return emailDetector(text);
    });
    Object.defineProperty(input, "email", { enumerable: true, configurable: true, get });

    await expect(
      createTokenizer("tokenize", new InMemoryVault(), detect).tokenizeJson(runA, input, context),
    ).resolves.toMatchObject({ value: { email: "<EMAIL_1>" } });
    expect(get).toHaveBeenCalledTimes(1);
    expect(detect.mock.calls.map(([text]) => text)).toEqual(["email", "alice@example.test"]);
  });

  it("aggregates block decisions across the complete JSON value before writing", async () => {
    const vault = new InMemoryVault();
    const tokenizer = createTokenizer("block", vault);
    const input: JsonValue = ["alice@example.test", { nested: "bob@example.test" }];

    await expect(tokenizer.tokenizeJson(runA, input, context)).rejects.toMatchObject({
      code: "pii_blocked",
      entities: [{ type: "email", count: 2 }],
    });
    await expect(vault.stats(runA)).resolves.toEqual({ entries: 0 });
  });

  it("is idempotent when JSON values already contain tokens", async () => {
    const tokenizer = createTokenizer();
    const first = await tokenizer.tokenizeJson(runA, { email: "alice@example.test" }, context);
    const second = await tokenizer.tokenizeJson(runA, first.value, context);

    expect(second).toEqual({ value: first.value, actions: [] });
  });

  it("accepts depth 64 and rejects depth 65", async () => {
    const tokenizer = createTokenizer();
    let depth64: JsonValue = "alice@example.test";
    let depth65: JsonValue = "alice@example.test";
    for (let index = 0; index < 64; index++) {
      depth64 = [depth64];
      depth65 = [depth65];
    }
    depth65 = [depth65];

    await expect(tokenizer.tokenizeJson(runA, depth64, context)).resolves.toMatchObject({
      actions: [{ action: "tokenize" }],
    });
    await expect(tokenizer.tokenizeJson(runA, depth65, context)).rejects.toMatchObject({
      code: "pii_depth_exceeded",
      message: "pii_depth_exceeded",
    });
  });

  it("rejects JSON larger than 2 MiB before detection", async () => {
    const detect = vi.fn(emailDetector);
    const tokenizer = createTokenizer("tokenize", new InMemoryVault(), detect);
    const input: JsonValue = `alice@example.test${"x".repeat(2 * 1024 * 1024)}`;

    await expect(tokenizer.tokenizeJson(runA, input, context)).rejects.toMatchObject({
      code: "pii_input_too_large",
      message: "pii_input_too_large",
    });
    expect(detect).not.toHaveBeenCalled();

    const oversizedUtf8: JsonValue = "😀".repeat(600_000);
    await expect(tokenizer.tokenizeJson(runA, oversizedUtf8, context)).rejects.toMatchObject({
      code: "pii_input_too_large",
      message: "pii_input_too_large",
    });
  });

  it("converts cyclic or non-JSON values into value-free errors", async () => {
    const cyclic: JsonValue[] = [];
    cyclic.push(cyclic);
    await expect(createTokenizer().tokenizeJson(runA, cyclic, context)).rejects.toBeInstanceOf(
      PiiTokenizerError,
    );
  });

  const dateContainer: Record<string, JsonValue> = {};
  const mapContainer: Record<string, JsonValue> = {};
  const setContainer: Record<string, JsonValue> = {};
  const classContainer: Record<string, JsonValue> = {};
  const customPrototypeContainer: Record<string, JsonValue> = {};
  Object.setPrototypeOf(dateContainer, Date.prototype);
  Object.setPrototypeOf(mapContainer, Map.prototype);
  Object.setPrototypeOf(setContainer, Set.prototype);
  Object.setPrototypeOf(classContainer, CustomContainer.prototype);
  Object.setPrototypeOf(customPrototypeContainer, { inherited: true });

  it.each([
    ["Date", dateContainer],
    ["Map", mapContainer],
    ["Set", setContainer],
    ["class instance", classContainer],
    ["custom-prototype object", customPrototypeContainer],
  ])("rejects a %s as invalid JSON", async (_name, value) => {
    await expect(createTokenizer().tokenizeJson(runA, value, context)).rejects.toMatchObject({
      code: "pii_input_invalid",
      message: "pii_input_invalid",
    });
  });
});
