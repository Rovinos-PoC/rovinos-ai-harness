// SPDX-License-Identifier: Apache-2.0
// Scan maximal candidates once, then validate them: failed long candidates are not retried at every offset.
import { DetectorTextSchema, HarnessError } from "@harness/schemas";
import type { Code, Detection } from "@harness/schemas";

export type { Detection } from "@harness/schemas";

/** Synchronous detector; offsets address the original UTF-16 text. */
export interface Detector {
  readonly id: Code;
  readonly entityTypes: Code[];
  detect(text: string): Detection[];
}

/** Asynchronous detector plugin; use for external analyzers without blocking regex detectors. */
export interface AsyncDetector {
  readonly id: Code;
  readonly entityTypes: Code[];
  detect(text: string): Promise<Detection[]>;
}

/** Failure codes never include input text or configured patterns. */
export class PiiDetectorError extends HarnessError {
  constructor(
    public readonly code:
      | "pii_pattern_unsafe"
      | "pii_pattern_invalid"
      | "pii_detector_invalid_input"
      | "pii_detector_unavailable",
  ) {
    super(code);
  }
}

/** Validate detector input without exposing a raw value in an error. */
export function validateText(text: string): void {
  if (!DetectorTextSchema.safeParse(text).success) {
    throw new PiiDetectorError("pii_detector_invalid_input");
  }
}

/** Remove sentence-final periods without retrying a regex at each offset. */
export function stripTrailingPeriods(value: string): string {
  let end = value.length;
  while (value[end - 1] === ".") {
    end--;
  }
  return value.slice(0, end);
}

/** Build an internal candidate scanner with deterministic confidence. */
export function candidateDetector(
  id: Code,
  entityType: Code,
  pattern: RegExp,
  validate: (value: string, start: number, text: string) => boolean | string,
): Detector {
  return {
    id,
    entityTypes: [entityType],
    detect(text) {
      validateText(text);
      const detections: Detection[] = [];
      for (const match of text.matchAll(pattern)) {
        const candidate = match[0].trim();
        const start = match.index + match[0].indexOf(candidate);
        const validation = validate(candidate, start, text);
        const value = typeof validation === "string" ? validation : candidate;
        const end = start + value.length;
        if (
          value.length > 0 &&
          !/[\p{L}\p{N}_]/u.test(text[start - 1] ?? "") &&
          !/[\p{L}\p{N}_]/u.test(text[end] ?? "") &&
          validation !== false
        ) {
          detections.push({ entityType, start, end, confidence: 1, detectorId: id });
        }
      }
      return detections;
    },
  };
}
