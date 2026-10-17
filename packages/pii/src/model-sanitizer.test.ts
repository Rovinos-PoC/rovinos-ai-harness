// SPDX-License-Identifier: Apache-2.0
import { Code, Id, PiiConfigSchema, PiiPresidioConfigSchema, type Message } from "@harness/schemas";
import * as telemetry from "@harness/telemetry";
import { AuditingVaultResolver, InMemoryVault, Token, type VaultAudit } from "@harness/vault";
import { Response as UndiciResponse } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emailDetector } from "./detectors/email.js";
import {
  PresidioDetector,
  type PresidioClock,
  type PresidioFetcher,
} from "./detectors/presidio.js";
import { DetectorRegistry } from "./detectors/registry.js";
import { PiiDetectorError } from "./detectors/types.js";
import { PiiBlobContainsPiiError } from "./errors.js";
import { PiiMessageSanitizer } from "./model-sanitizer.js";
import { Tokenizer, type PiiDetectorRegistry } from "./tokenizer.js";

const runId = Id.parse("11111111111111111111111111");
const canary = "model-input-canary@example.test";
const target = (trust: "hosted" | "local") => ({
  provider: Code.parse(trust),
  model: Code.parse("test-model"),
  trust,
});

function createSanitizer(
  config = PiiConfigSchema.parse({}),
  detect: PiiDetectorRegistry["detect"] = (text) => emailDetector.detect(text),
) {
  const vault = new InMemoryVault();
  const audits: VaultAudit[] = [];
  const resolver = new AuditingVaultResolver(vault, (audit) => {
    audits.push(audit);
  });
  const detectors = { detect };
  const tokenizer = new Tokenizer({ detectors, policy: config, vault });
  return {
    audits,
    resolver,
    sanitizer: new PiiMessageSanitizer({
      tokenizer,
      detectors,
      policy: config,
      resolver,
    }),
    tokenizer,
    vault,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PiiMessageSanitizer", () => {
  it("tokenizes text and tool-result JSON for hosted targets even when allow is configured", async () => {
    const { sanitizer } = createSanitizer(
      PiiConfigSchema.parse({
        rules: [
          {
            entities: ["email"],
            boundaries: ["model_input"],
            destinations: ["hosted"],
            action: "allow",
          },
        ],
      }),
    );
    const input: Message[] = [
      {
        role: "user",
        parts: [
          { type: "text", text: `Contact ${canary}` },
          {
            type: "tool_result",
            callId: Id.parse("22222222222222222222222222"),
            isError: false,
            result: { contact: canary },
          },
        ],
      },
    ];
    const result = await sanitizer.sanitize(input, target("hosted"), runId);

    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).toContain("<EMAIL_1>");
    expect(JSON.stringify(input)).toContain(canary);
  });

  it("resolves existing tokens for local allow and audits model-input detokenization", async () => {
    const config = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    });
    const { audits, sanitizer, vault } = createSanitizer(config);
    const token = await vault.put(runId, "email", canary);
    const recordPiiAction = vi.fn(() => Promise.resolve());
    const result = await sanitizer.sanitize(
      [
        {
          role: "user",
          parts: [
            { type: "text", text: `Contact ${token}` },
            {
              type: "tool_result",
              callId: Id.parse("22222222222222222222222222"),
              isError: false,
              result: { contact: token },
            },
          ],
        },
      ],
      target("local"),
      runId,
      { recordPiiAction },
    );

    expect(JSON.stringify(result)).toContain(canary);
    expect(audits).toMatchObject([
      { boundary: "model_input", action: "detokenized", entities: [{ type: "email", count: 1 }] },
      { boundary: "model_input", action: "detokenized", entities: [{ type: "email", count: 1 }] },
    ]);
    expect(recordPiiAction).toHaveBeenCalledWith({
      boundary: "model_input",
      action: "allow",
      entities: [{ type: "email", count: 1 }],
    });
  });

  it("sanitizes model-visible tool and output schemas using the target policy", async () => {
    const config = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    });
    const { sanitizer } = createSanitizer(config);
    const request = {
      requestId: runId,
      model: { provider: "test", model: "test-model" },
      messages: [{ role: "user" as const, parts: [{ type: "text" as const, text: canary }] }],
      tools: [
        {
          toolId: Code.parse("test.tool"),
          description: `Tool contact ${canary}`,
          inputSchema: {
            type: "object",
            title: `Schema ${canary}`,
            properties: {
              contact: {
                type: "string",
                description: `Contact ${canary}`,
                default: canary,
                examples: [canary],
                enum: [canary],
              },
            },
          },
        },
      ],
      output: {
        name: Code.parse("test.output"),
        schema: { title: `Output ${canary}`, examples: [canary] },
        schemaHash: "a".repeat(64),
      },
    };
    const hosted = await sanitizer.sanitizeRequest(request, target("hosted"), runId);
    const local = await sanitizer.sanitizeRequest(request, target("local"), runId);

    expect(JSON.stringify(hosted)).not.toContain(canary);
    expect(JSON.stringify(hosted)).toContain("<EMAIL_1>");
    expect(JSON.stringify(local)).toContain(canary);
    expect(JSON.stringify(request)).toContain(canary);
  });

  it("applies model-input policy to tool-call arguments", async () => {
    const { sanitizer, vault } = createSanitizer(PiiConfigSchema.parse({ defaultAction: "block" }));
    const token = await vault.put(runId, "email", canary);

    await expect(
      sanitizer.sanitize(
        [
          {
            role: "assistant",
            parts: [
              {
                type: "tool_call",
                callId: Id.parse("22222222222222222222222222"),
                toolId: Code.parse("emit_result"),
                args: { contact: token },
              },
            ],
          },
        ],
        target("hosted"),
        runId,
      ),
    ).rejects.toMatchObject({ code: "pii_blocked" });
  });

  it("re-checks detokenized text and JSON for blocked overlapping entities", async () => {
    const config = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["custom_contact"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "block",
        },
      ],
    });
    const { audits, sanitizer, vault } = createSanitizer(config);
    const token = await vault.put(runId, "custom_contact", canary);
    const summaries: unknown[] = [];
    const recordPiiAction = (summary: unknown) => {
      summaries.push(summary);
      return Promise.resolve();
    };
    const textMessage: Message[] = [{ role: "user", parts: [{ type: "text", text: token }] }];
    const jsonMessage: Message[] = [
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: Id.parse("22222222222222222222222222"),
            isError: false,
            result: { contact: token },
          },
        ],
      },
    ];

    await expect(
      sanitizer.sanitize(textMessage, target("local"), runId, { recordPiiAction }),
    ).rejects.toMatchObject({ code: "pii_blocked" });
    await expect(
      sanitizer.sanitize(jsonMessage, target("local"), runId, { recordPiiAction }),
    ).rejects.toMatchObject({ code: "pii_blocked" });

    expect(audits).toHaveLength(2);
    expect(summaries).toContainEqual({
      boundary: "model_input",
      action: "block",
      entities: [{ type: "email", count: 1 }],
    });
  });

  it("re-sanitizes the original messages when a local attempt falls back to hosted", async () => {
    const config = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    });
    const { sanitizer, vault } = createSanitizer(config);
    const token = await vault.put(runId, "email", canary);
    const messages: Message[] = [{ role: "user", parts: [{ type: "text", text: token }] }];
    const local = await sanitizer.sanitize(messages, target("local"), runId);
    const hosted = await sanitizer.sanitize(messages, target("hosted"), runId);

    expect(JSON.stringify(local)).toContain(canary);
    expect(JSON.stringify(hosted)).not.toContain(canary);
    expect(JSON.stringify(hosted)).toContain(token);
  });

  it("blocks policy-denied raw PII and emits only metadata summaries", async () => {
    const { sanitizer } = createSanitizer(PiiConfigSchema.parse({ defaultAction: "block" }));
    const summaries: unknown[] = [];

    await expect(
      sanitizer.sanitize(
        [{ role: "user", parts: [{ type: "text", text: canary }] }],
        target("hosted"),
        runId,
        {
          recordPiiAction: (summary) => {
            summaries.push(summary);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toMatchObject({ code: "pii_blocked" });
    expect(JSON.stringify(summaries)).not.toContain(canary);
    expect(summaries).toEqual([
      { boundary: "model_input", action: "block", entities: [{ type: "email", count: 1 }] },
    ]);
  });

  it("does not send raw data to a hosted target when an allow rule matches", async () => {
    const config = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: "*",
          action: "allow",
        },
      ],
    });
    const { sanitizer } = createSanitizer(config);

    const result = await sanitizer.sanitize(
      [{ role: "user", parts: [{ type: "text", text: canary }] }],
      target("hosted"),
      runId,
    );

    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("fails closed and counts an opaque provider blob containing raw PII", async () => {
    const { sanitizer } = createSanitizer();
    const count = vi.spyOn(telemetry, "countPiiBlobHit");

    await expect(
      sanitizer.sanitize(
        [
          {
            role: "assistant",
            parts: [{ type: "opaque", provider: Code.parse("hosted"), blob: { text: canary } }],
          },
        ],
        target("hosted"),
        runId,
      ),
    ).rejects.toBeInstanceOf(PiiBlobContainsPiiError);
    expect(count).toHaveBeenCalledOnce();
  });

  it.each(["closed", "half-open"] as const)(
    "fails closed on an opaque blob when Presidio is unavailable (%s breaker)",
    async (breakerState) => {
      let now = 0;
      const clock: PresidioClock = { now: () => now };
      const fetcher: PresidioFetcher = () =>
        Promise.resolve(new UndiciResponse(null, { status: 503 }));
      const presidio = new PresidioDetector(
        PiiPresidioConfigSchema.parse({ baseUrl: "http://presidio:3000" }),
        { clock, fetcher },
      );
      const warmupAttempts = breakerState === "half-open" ? 5 : 0;
      const warmupResults = await Promise.all(
        Array.from({ length: warmupAttempts }, () =>
          presidio.detect("synthetic").then(
            () => undefined,
            (error: unknown) => error,
          ),
        ),
      );
      expect(warmupResults).toHaveLength(warmupAttempts);
      expect(
        warmupResults.every(
          (error) => error instanceof PiiDetectorError && error.code === "pii_detector_unavailable",
        ),
      ).toBe(true);
      now = warmupAttempts === 0 ? 0 : 30_000;
      const registry = new DetectorRegistry({
        asyncDetectors: [presidio],
        failMode: "closed",
        syncDetectors: [emailDetector],
      });
      const { sanitizer } = createSanitizer(PiiConfigSchema.parse({}), (text) =>
        registry.detect(text),
      );
      const error = await sanitizer
        .sanitize(
          [
            {
              role: "assistant",
              parts: [{ type: "opaque", provider: Code.parse("hosted"), blob: { text: canary } }],
            },
          ],
          target("hosted"),
          runId,
        )
        .catch((caught: unknown) => caught);

      expect(error).toMatchObject({ code: "pii_detector_unavailable" });
      expect(String(error)).not.toContain(canary);
      expect(JSON.stringify(error)).not.toContain(canary);
    },
  );

  it("counts regex-only degradation exactly once for one opaque scan with no metric attributes", async () => {
    const count = vi.spyOn(telemetry, "countPiiDetectorDegraded");
    const registry = new DetectorRegistry({
      asyncDetectors: [
        {
          id: Code.parse("presidio"),
          entityTypes: [Code.parse("person_name")],
          detect: () => Promise.reject(new Error(canary)),
        },
      ],
      failMode: "regex_only",
      syncDetectors: [emailDetector],
    });
    const { sanitizer } = createSanitizer(
      PiiConfigSchema.parse({ failMode: "regex_only" }),
      (text) => registry.detect(text),
    );

    await expect(
      sanitizer.sanitize(
        [
          {
            role: "assistant",
            parts: [{ type: "opaque", provider: Code.parse("hosted"), blob: canary }],
          },
        ],
        target("hosted"),
        runId,
      ),
    ).rejects.toBeInstanceOf(PiiBlobContainsPiiError);

    expect(count).toHaveBeenCalledExactlyOnceWith();
  });

  it("passes safe opaque data and tool calls through without mutation", async () => {
    const { sanitizer } = createSanitizer();
    const message: Message = {
      role: "assistant",
      parts: [
        { type: "opaque", provider: Code.parse("hosted"), blob: { id: "opaque-id" } },
        {
          type: "tool_call",
          callId: Id.parse("22222222222222222222222222"),
          toolId: Code.parse("test.echo"),
          args: { value: "<EMAIL_1>" },
        },
      ],
    };

    const result = await sanitizer.sanitize([message], target("hosted"), runId);

    expect(result).toEqual([message]);
    expect(result[0]).not.toBe(message);
  });

  it("fails closed if model-input token resolution fails or the token is unknown", async () => {
    const config = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    });
    const { sanitizer, vault } = createSanitizer(config);
    const token = await vault.put(runId, "email", canary);
    vi.spyOn(vault, "resolve").mockRejectedValue(new Error(canary));

    await expect(
      sanitizer.sanitize(
        [{ role: "user", parts: [{ type: "text", text: token }] }],
        target("local"),
        runId,
      ),
    ).rejects.toMatchObject({ code: "pii_vault_failed" });
    expect(
      String(
        await sanitizer
          .sanitize(
            [{ role: "user", parts: [{ type: "text", text: "<EMAIL_9>" }] }],
            target("local"),
            runId,
          )
          .catch((error: unknown) => error),
      ),
    ).not.toContain(canary);
  });

  it("fails closed when resolving an unknown allowlisted token", async () => {
    const config = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    });
    const { sanitizer } = createSanitizer(config);

    await expect(
      sanitizer.sanitize(
        [{ role: "user", parts: [{ type: "text", text: Token.parse("<EMAIL_9>") }] }],
        target("local"),
        runId,
      ),
    ).rejects.toMatchObject({ code: "pii_token_unresolvable" });
  });

  it("fails closed if detokenized JSON keys would collide", async () => {
    const config = PiiConfigSchema.parse({
      rules: [
        {
          entities: ["email"],
          boundaries: ["model_input"],
          destinations: ["local"],
          action: "allow",
        },
      ],
    });
    const { sanitizer, vault } = createSanitizer(config);
    const token = await vault.put(runId, "email", canary);

    await expect(
      sanitizer.sanitize(
        [
          {
            role: "tool",
            parts: [
              {
                type: "tool_result",
                callId: Id.parse("22222222222222222222222222"),
                isError: false,
                result: { [token]: "token-key", [canary]: "raw-key" },
              },
            ],
          },
        ],
        target("local"),
        runId,
      ),
    ).rejects.toMatchObject({ code: "pii_input_invalid" });
  });

  it("fails closed and records a block for an already-tokenized blocked entity", async () => {
    const { sanitizer, vault } = createSanitizer(PiiConfigSchema.parse({ defaultAction: "block" }));
    const token = await vault.put(runId, "email", canary);
    const summaries: unknown[] = [];

    await expect(
      sanitizer.sanitize(
        [{ role: "user", parts: [{ type: "text", text: token }] }],
        target("hosted"),
        runId,
        {
          recordPiiAction: (summary) => {
            summaries.push(summary);
            return Promise.resolve();
          },
        },
      ),
    ).rejects.toMatchObject({ code: "pii_blocked" });
    expect(summaries).toEqual([
      { boundary: "model_input", action: "block", entities: [{ type: "email", count: 1 }] },
    ]);
  });

  it("reports sanitizer callback failures instead of continuing to a provider", async () => {
    const { sanitizer } = createSanitizer();

    await expect(
      sanitizer.sanitize(
        [{ role: "user", parts: [{ type: "text", text: canary }] }],
        target("hosted"),
        runId,
        { recordPiiAction: () => Promise.reject(new Error(canary)) },
      ),
    ).rejects.toThrow(canary);
  });

  it("does not record summaries after cancellation during detection", async () => {
    let startDetection: () => void = () => undefined;
    let finishDetection: (() => void) | undefined;
    const detectionStarted = new Promise<void>((resolve) => {
      startDetection = resolve;
    });
    const { sanitizer } = createSanitizer(
      PiiConfigSchema.parse({}),
      (text) =>
        new Promise((resolve) => {
          finishDetection = () => {
            resolve(emailDetector.detect(text));
          };
          startDetection();
        }),
    );
    const controller = new AbortController();
    const recordPiiAction = vi.fn(() => Promise.resolve());
    const sanitization = sanitizer.sanitize(
      [{ role: "user", parts: [{ type: "text", text: canary }] }],
      target("hosted"),
      runId,
      { recordPiiAction, signal: controller.signal },
    );
    await detectionStarted;
    controller.abort(new Error("cancelled"));
    finishDetection?.();

    await expect(sanitization).rejects.toThrow("cancelled");
    expect(recordPiiAction).not.toHaveBeenCalled();
  });

  it("maps detector failures in opaque data to a safe error", async () => {
    const failing = createSanitizer(PiiConfigSchema.parse({}), () =>
      Promise.reject(new Error(canary)),
    );

    await expect(
      failing.sanitizer.sanitize(
        [
          {
            role: "assistant",
            parts: [{ type: "opaque", provider: Code.parse("hosted"), blob: { text: "safe" } }],
          },
        ],
        target("hosted"),
        runId,
      ),
    ).rejects.toMatchObject({ code: "pii_detector_failed" });
  });
});
