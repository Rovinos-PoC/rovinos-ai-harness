// SPDX-License-Identifier: Apache-2.0
import { DetectionSchema } from "@harness/schemas";
import { countPiiDetectorDegraded } from "@harness/telemetry";
import { PiiDetectorError, validateText } from "./types.js";
import type { AsyncDetector, Detection, Detector } from "./types.js";

/** Detector composition settings; async failures either stop detection or use regex results only. */
export interface DetectorRegistryOptions {
  readonly asyncDetectors?: readonly AsyncDetector[];
  readonly failMode?: "closed" | "regex_only";
  readonly syncDetectors?: readonly Detector[];
}

/** Runs synchronous detectors first and async detectors concurrently, preserving all ranges for policy evaluation. */
export class DetectorRegistry {
  private readonly asyncDetectors: readonly AsyncDetector[];
  private readonly failMode: "closed" | "regex_only";
  private readonly syncDetectors: readonly Detector[];

  constructor(options: DetectorRegistryOptions = {}) {
    this.syncDetectors = options.syncDetectors ?? [];
    this.asyncDetectors = options.asyncDetectors ?? [];
    this.failMode = options.failMode ?? "closed";
  }

  /** Detect entities in UTF-16 offsets, preserving synchronous behavior without async plugins. */
  detect(text: string): Detection[] | Promise<Detection[]> {
    const synchronous = this.syncDetectors.flatMap((detector) => detector.detect(text));
    if (this.asyncDetectors.length === 0) {
      return validateDetections(synchronous);
    }
    validateText(text);
    return this.detectWithAsync(text, synchronous);
  }

  private async detectWithAsync(
    text: string,
    synchronous: readonly Detection[],
  ): Promise<Detection[]> {
    let asyncResults: Detection[][];
    try {
      asyncResults = await Promise.all(
        this.asyncDetectors.map((detector) => Promise.resolve().then(() => detector.detect(text))),
      );
    } catch {
      if (this.failMode === "regex_only") {
        countPiiDetectorDegraded();
        return validateDetections(synchronous);
      }
      throw new PiiDetectorError("pii_detector_unavailable");
    }
    return validateDetections([...synchronous, ...asyncResults.flat()]);
  }
}

function validateDetections(detections: readonly Detection[]): Detection[] {
  return detections.map((detection) => {
    const parsed = DetectionSchema.safeParse(detection);
    if (!parsed.success) {
      throw new PiiDetectorError("pii_detector_invalid_input");
    }
    return parsed.data;
  });
}
