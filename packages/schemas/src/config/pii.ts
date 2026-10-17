// SPDX-License-Identifier: Apache-2.0
// PII configuration is owned by tasks 13.1, 13.2, 13.3, and 13.5.
import { z } from "zod";
import { CustomDetectorSchema } from "../pii-detection.js";
import { PiiPolicySchema } from "../pii-policy.js";
import { Code } from "../primitives.js";

/** Validates an RFC 6901 JSON Pointer, including valid `~0` and `~1` escapes. */
export const JsonPointerSchema = z.string().refine(
  (pointer) =>
    pointer === "" ||
    (pointer.startsWith("/") &&
      pointer
        .slice(1)
        .split("/")
        .every((segment) => !/~(?![01])/u.test(segment))),
  { message: "Invalid JSON pointer" },
);

/** A JSON Pointer selecting a value within tool arguments. */
export type JsonPointer = z.infer<typeof JsonPointerSchema>;

/** Tool arguments permitted to receive resolved raw values. */
export const PiiDetokenizeRuleSchema = z
  .object({
    toolId: Code,
    args: z.array(
      JsonPointerSchema.refine((pointer) => pointer !== "", {
        message: "A tool argument pointer must select a value",
      }),
    ),
    onUnresolvable: z.enum(["fail", "leave"]).default("fail"),
  })
  .strict();

/** Inferred detokenization allowlist entry. */
export type PiiDetokenizeRule = z.infer<typeof PiiDetokenizeRuleSchema>;

/** Optional analyzer sidecar connection and detection settings. */
export const PiiPresidioConfigSchema = z
  .object({
    baseUrl: z.url().refine((value) => {
      try {
        const url = new URL(value);
        const hostname = url.hostname.toLowerCase();
        return (
          (url.protocol === "https:" ||
            (url.protocol === "http:" && isLoopbackHostname(hostname)) ||
            (url.protocol === "http:" && isSingleLabelHostname(hostname))) &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === ""
        );
      } catch {
        return false;
      }
    }),
    language: z.string().min(2).max(35).default("en"),
    scoreThreshold: z.number().min(0).max(1).default(0.5),
  })
  .strict();

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "[::1]") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function isSingleLabelHostname(hostname: string): boolean {
  return (
    hostname.length <= 63 &&
    !hostname.includes(".") &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(hostname)
  );
}

/** Validated optional Presidio sidecar configuration. */
export type PiiPresidioConfig = z.infer<typeof PiiPresidioConfigSchema>;

export const PiiConfigSchema = PiiPolicySchema.safeExtend({
  enabled: z.boolean().default(true),
  custom: z.array(CustomDetectorSchema).optional(),
  failMode: z.enum(["closed", "regex_only"]).default("closed"),
  presidio: PiiPresidioConfigSchema.optional(),
  detokenize: z
    .array(PiiDetokenizeRuleSchema)
    .superRefine((rules, context) => {
      const seenToolIds = new Set<string>();
      for (const [index, rule] of rules.entries()) {
        if (seenToolIds.has(rule.toolId)) {
          context.addIssue({
            code: "custom",
            path: [index, "toolId"],
            message: "Duplicate toolId",
            params: { errorCode: "duplicate_tool_id" },
          });
        } else {
          seenToolIds.add(rule.toolId);
        }
      }
    })
    .optional(),
}).prefault({});

/** Validated PII configuration. */
export type PiiConfig = z.infer<typeof PiiConfigSchema>;
