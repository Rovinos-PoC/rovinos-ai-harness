// SPDX-License-Identifier: Apache-2.0
import { DetectionSchema, type Detection, type PiiAction } from "@harness/schemas";
import { PiiDetectorError } from "./detectors/types.js";
import { findTokens } from "@harness/vault";
import { PiiTokenizerError } from "./errors.js";

const ACTION_PRIORITY: Readonly<Record<PiiAction, number>> = {
  allow: 0,
  tokenize: 1,
  redact: 2,
  block: 3,
};

interface TokenSpan {
  readonly start: number;
  readonly end: number;
}

/** Policy result paired with its original detected range. */
export interface EvaluatedDetection {
  readonly detection: Detection;
  readonly action: PiiAction;
  readonly entityType: string;
}

/** Detect and validate ranges once after masking existing tokens. */
export async function detectOutsideTokenSpans(
  text: string,
  detect: (text: string) => readonly Detection[] | Promise<readonly Detection[]>,
): Promise<Detection[]> {
  const tokens = findTokens(text).map(({ index, token }) => ({
    start: index,
    end: index + token.length,
  }));
  const maskedText = maskTokenSpans(text, tokens);
  let found: readonly Detection[];
  try {
    found = await detect(maskedText);
  } catch (error) {
    if (error instanceof PiiDetectorError && error.code === "pii_detector_unavailable") {
      throw new PiiTokenizerError("pii_detector_unavailable");
    }
    throw new PiiTokenizerError("pii_detector_failed");
  }

  const detections: Detection[] = [];
  try {
    for (const detection of found) {
      const parsed = DetectionSchema.safeParse(detection);
      if (!parsed.success || parsed.data.end > maskedText.length) {
        throw new PiiTokenizerError("pii_detector_invalid_output");
      }
      if (!intersectsToken(parsed.data.start, parsed.data.end, tokens)) {
        detections.push(parsed.data);
      }
    }
  } catch (error) {
    if (error instanceof PiiTokenizerError) {
      throw error;
    }
    throw new PiiTokenizerError("pii_detector_invalid_output");
  }
  return detections;
}

/** Resolve overlapping ranges by policy strictness, then detector preference. */
export function resolvePolicyOverlaps(
  detections: readonly EvaluatedDetection[],
): EvaluatedDetection[] {
  const sorted = [...detections].sort((left, right) => {
    const startDifference = left.detection.start - right.detection.start;
    return startDifference !== 0 ? startDifference : left.detection.end - right.detection.end;
  });
  const resolved: EvaluatedDetection[] = [];
  let group: EvaluatedDetection[] = [];
  let groupStart = 0;
  let groupEnd = 0;
  for (const current of sorted) {
    if (group.length === 0) {
      group = [current];
      groupStart = current.detection.start;
      groupEnd = current.detection.end;
    } else if (current.detection.start < groupEnd) {
      group.push(current);
      groupEnd = Math.max(groupEnd, current.detection.end);
    } else {
      resolved.push(mergePolicyOverlapGroup(group, groupStart, groupEnd));
      group = [current];
      groupStart = current.detection.start;
      groupEnd = current.detection.end;
    }
  }
  if (group.length > 0) {
    resolved.push(mergePolicyOverlapGroup(group, groupStart, groupEnd));
  }
  return resolved;
}

function maskTokenSpans(text: string, tokens: readonly TokenSpan[]): string {
  const parts: string[] = [];
  let cursor = 0;
  for (const token of tokens) {
    parts.push(text.slice(cursor, token.start), " ".repeat(token.end - token.start));
    cursor = token.end;
  }
  parts.push(text.slice(cursor));
  return parts.join("");
}

function intersectsToken(start: number, end: number, tokens: readonly TokenSpan[]): boolean {
  let low = 0;
  let high = tokens.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const token = tokens[middle];
    if (token !== undefined && token.end <= start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const token = tokens[low];
  return token !== undefined && token.start < end;
}

function mergePolicyOverlapGroup(
  group: readonly EvaluatedDetection[],
  start: number,
  end: number,
): EvaluatedDetection {
  const winner = group.reduce((preferred, candidate) =>
    isPreferredPolicyDetection(candidate, preferred) ? candidate : preferred,
  );
  return {
    ...winner,
    detection: { ...winner.detection, start, end },
  };
}

function isPreferredPolicyDetection(
  candidate: EvaluatedDetection,
  preferred: EvaluatedDetection,
): boolean {
  const priorityDifference = ACTION_PRIORITY[candidate.action] - ACTION_PRIORITY[preferred.action];
  if (priorityDifference !== 0) {
    return priorityDifference > 0;
  }
  const candidateLength = candidate.detection.end - candidate.detection.start;
  const preferredLength = preferred.detection.end - preferred.detection.start;
  if (candidateLength !== preferredLength) {
    return candidateLength > preferredLength;
  }
  if (candidate.detection.confidence !== preferred.detection.confidence) {
    return candidate.detection.confidence > preferred.detection.confidence;
  }
  return candidate.detection.detectorId < preferred.detection.detectorId;
}
