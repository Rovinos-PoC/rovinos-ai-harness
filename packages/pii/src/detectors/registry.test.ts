// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { countPiiDetectorDegraded } from "@harness/telemetry";
import { DetectorRegistry } from "./registry.js";
import { PiiDetectorError } from "./types.js";
import type { AsyncDetector, Detection, Detector } from "./types.js";

vi.mock("@harness/telemetry", () => ({ countPiiDetectorDegraded: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
});

function detection(
  start: number,
  end: number,
  detectorId: string,
  entityType = "email",
  confidence = 0.9,
): Detection {
  return { start, end, detectorId, entityType, confidence };
}

function syncDetector(results: Detection[], detect = vi.fn(() => results)): Detector {
  return { id: "regex", entityTypes: ["email"], detect };
}

function asyncDetector(detect: AsyncDetector["detect"], id = "remote"): AsyncDetector {
  return { id, entityTypes: ["person_name"], detect };
}

describe("DetectorRegistry", () => {
  it("preserves policy-relevant synchronous overlaps without async plugins", () => {
    const results = [detection(0, 5, "regex"), detection(2, 8, "regex")];
    const detect = vi.fn(() => results);
    const detector = syncDetector(results, detect);
    const registry = new DetectorRegistry({ syncDetectors: [detector] });

    expect(registry.detect("text")).toEqual(results);
    expect(detect).toHaveBeenCalledWith("text");
  });

  it("runs async plugins concurrently after synchronous detection and merges their results", async () => {
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new DetectorRegistry({
      syncDetectors: [
        syncDetector(
          [detection(0, 5, "regex")],
          vi.fn(() => {
            events.push("sync");
            return [detection(0, 5, "regex")];
          }),
        ),
      ],
      asyncDetectors: [
        asyncDetector(async () => {
          events.push("first");
          await gate;
          return [detection(2, 8, "first", "person_name")];
        }, "first"),
        asyncDetector(async () => {
          events.push("second");
          await gate;
          return [detection(9, 12, "second", "person_name")];
        }, "second"),
      ],
    });

    const result = registry.detect("text");
    expect(events).toEqual(["sync"]);
    await Promise.resolve();
    expect(events).toEqual(["sync", "first", "second"]);
    release?.();
    await expect(result).resolves.toEqual([
      detection(0, 5, "regex"),
      detection(2, 8, "first", "person_name"),
      detection(9, 12, "second", "person_name"),
    ]);
  });

  it("fails closed with a safe unavailable code when an async detector fails", async () => {
    const sensitiveValue = "synthetic-registry-canary";
    const registry = new DetectorRegistry({
      asyncDetectors: [asyncDetector(() => Promise.reject(new Error(sensitiveValue)))],
    });

    let error: unknown;
    try {
      await registry.detect("text");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(PiiDetectorError);
    expect(error).toMatchObject({ code: "pii_detector_unavailable" });
    expect(String(error)).not.toContain(sensitiveValue);
  });

  it("degrades to only synchronous detections and increments its own counter", async () => {
    const synchronous = detection(0, 4, "regex");
    const registry = new DetectorRegistry({
      failMode: "regex_only",
      syncDetectors: [syncDetector([synchronous])],
      asyncDetectors: [asyncDetector(() => Promise.reject(new Error("private failure")))],
    });

    await expect(registry.detect("text")).resolves.toEqual([synchronous]);
    expect(countPiiDetectorDegraded).toHaveBeenCalledExactlyOnceWith();
  });

  it("does not degrade synchronous detector failures", () => {
    const failure = new PiiDetectorError("pii_detector_invalid_input");
    const registry = new DetectorRegistry({
      failMode: "regex_only",
      syncDetectors: [
        syncDetector(
          [],
          vi.fn(() => {
            throw failure;
          }),
        ),
      ],
      asyncDetectors: [asyncDetector(vi.fn(() => Promise.resolve([])))],
    });

    expect(() => registry.detect("text")).toThrow(failure);
    expect(countPiiDetectorDegraded).not.toHaveBeenCalled();
  });

  it("rejects invalid async detector output", async () => {
    const invalidOutput = new DetectorRegistry({
      asyncDetectors: [asyncDetector(() => Promise.resolve([detection(5, 2, "remote")]))],
    });

    await expect(invalidOutput.detect("text")).rejects.toMatchObject({
      code: "pii_detector_invalid_input",
    });
  });
});
