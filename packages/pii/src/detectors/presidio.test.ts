// SPDX-License-Identifier: Apache-2.0
import { PiiPresidioConfigSchema } from "@harness/schemas";
import * as telemetry from "@harness/telemetry";
import { Response as UndiciResponse } from "undici";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPresidioReachableCheck,
  PresidioDetector,
  type PresidioClock,
  type PresidioFetcher,
} from "./presidio.js";
import { DetectorRegistry } from "./registry.js";

const config = PiiPresidioConfigSchema.parse({ baseUrl: "http://presidio:3000" });

function response(
  body: unknown,
  status = 200,
  headers?: Readonly<Record<string, string>>,
): UndiciResponse {
  return new UndiciResponse(JSON.stringify(body), {
    status,
    ...(headers === undefined ? {} : { headers }),
  });
}

function result(entity_type: string, start = 1, end = 4, score = 0.9) {
  return { entity_type, start, end, score };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PresidioDetector", () => {
  it("sends only the configured analyzer request and maps supported entities and scores", async () => {
    const fetcher = vi.fn<PresidioFetcher>(() =>
      Promise.resolve(
        response([
          result("PERSON"),
          result("EMAIL_ADDRESS"),
          result("PHONE_NUMBER"),
          result("CREDIT_CARD"),
          result("IBAN_CODE"),
          result("IP_ADDRESS"),
          result("LOCATION"),
          result("US_SSN"),
          result("DATE_TIME"),
        ]),
      ),
    );
    const detector = new PresidioDetector(config, { fetcher });

    await expect(detector.detect("0123456789")).resolves.toEqual([
      { entityType: "person_name", start: 1, end: 4, confidence: 0.9, detectorId: "presidio" },
      { entityType: "email", start: 1, end: 4, confidence: 0.9, detectorId: "presidio" },
      { entityType: "phone", start: 1, end: 4, confidence: 0.9, detectorId: "presidio" },
      { entityType: "credit_card", start: 1, end: 4, confidence: 0.9, detectorId: "presidio" },
      { entityType: "iban", start: 1, end: 4, confidence: 0.9, detectorId: "presidio" },
      { entityType: "ip_address", start: 1, end: 4, confidence: 0.9, detectorId: "presidio" },
      { entityType: "location", start: 1, end: 4, confidence: 0.9, detectorId: "presidio" },
      { entityType: "national_id", start: 1, end: 4, confidence: 0.9, detectorId: "presidio" },
    ]);
    const call = fetcher.mock.calls[0];
    expect(call?.[0].toString()).toBe("http://presidio:3000/analyze");
    expect(call?.[1]).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: "0123456789",
        language: "en",
        score_threshold: 0.5,
      }),
    });
    expect(call?.[1].body).not.toContain("runId");
    expect(call?.[1].body).not.toContain("metadata");
  });

  it("converts Python code-point offsets to original UTF-16 offsets", async () => {
    const detector = new PresidioDetector(config, {
      fetcher: () => Promise.resolve(response([result("PERSON", 2, 13)])),
    });

    const detections = await detector.detect("😀 Alice Smith");

    expect(detections[0]).toMatchObject({ start: 3, end: 14 });
    expect("😀 Alice Smith".slice(detections[0]?.start, detections[0]?.end)).toBe("Alice Smith");
  });

  it("honors configured language and score threshold", async () => {
    const fetcher = vi.fn<PresidioFetcher>(() => Promise.resolve(response([])));
    const detector = new PresidioDetector(
      PiiPresidioConfigSchema.parse({
        baseUrl: "http://presidio:3000/",
        language: "es",
        scoreThreshold: 0.75,
      }),
      { fetcher },
    );

    await detector.detect("sample");

    expect(fetcher.mock.calls[0]?.[1].body).toBe(
      JSON.stringify({ text: "sample", language: "es", score_threshold: 0.75 }),
    );
    expect(fetcher.mock.calls[0]?.[0].toString()).toBe("http://presidio:3000/analyze");
  });

  it("turns HTTP and malformed response failures into value-free unavailable errors", async () => {
    const sensitiveText = "synthetic-presidio-canary";
    for (const fetcher of [
      () => Promise.resolve(response([], 503)),
      () => Promise.resolve(new UndiciResponse(null)),
    ]) {
      const detector = new PresidioDetector(config, { fetcher });
      let error: unknown;
      try {
        await detector.detect(sensitiveText);
      } catch (caught) {
        error = caught;
      }
      expect(error).toMatchObject({ code: "pii_detector_unavailable" });
      expect(String(error)).not.toContain(sensitiveText);
    }
  });

  it("ignores response fields not used by the adapter", async () => {
    const detector = new PresidioDetector(config, {
      fetcher: () =>
        Promise.resolve(response([{ ...result("PERSON"), future_sidecar_field: "ignored" }])),
    });

    await expect(detector.detect("0123456789")).resolves.toHaveLength(1);
  });

  it("rejects a redirect without forwarding the analyze request to its target", async () => {
    const visitedHosts: string[] = [];
    const fetcher = vi.fn<PresidioFetcher>((url) => {
      visitedHosts.push(url.host);
      return Promise.resolve(
        new UndiciResponse(null, {
          status: 307,
          headers: { location: "http://second.test:3000/analyze" },
        }),
      );
    });
    const detector = new PresidioDetector(config, { fetcher });

    await expect(detector.detect("synthetic raw text")).rejects.toMatchObject({
      code: "pii_detector_unavailable",
    });
    expect(visitedHosts).toEqual(["presidio:3000"]);
    expect(visitedHosts).not.toContain("second.test:3000");
    expect(fetcher.mock.calls[0]?.[1].redirect).toBe("error");
  });

  it("times out a hung request and aborts its signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const detector = new PresidioDetector(config, {
      fetcher: (_url, init) => {
        signal = init.signal;
        return new Promise(() => undefined);
      },
    });
    const pending = detector.detect("synthetic");
    const failure = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(2_000);

    expect(await failure).toMatchObject({ code: "pii_detector_unavailable" });
    expect(signal?.aborted).toBe(true);
  });

  it("keeps the timeout active through body consumption and cancels a stalled stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
      },
      cancel,
    });
    const detector = new PresidioDetector(config, {
      timeoutMs: 100,
      fetcher: () => Promise.resolve(new UndiciResponse(body)),
    });
    const pending = detector.detect("synthetic");
    const failure = pending.then(
      () => undefined,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(100);

    expect(await failure).toMatchObject({ code: "pii_detector_unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reopens a timed-out half-open circuit and permits a later probe", async () => {
    vi.useFakeTimers();
    let now = 0;
    const clock: PresidioClock = { now: () => now };
    const stalledBody = new UndiciResponse(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("["));
        },
      }),
    );
    const fetcher = vi
      .fn<PresidioFetcher>()
      .mockResolvedValueOnce(response([], 503))
      .mockResolvedValueOnce(response([], 503))
      .mockResolvedValueOnce(response([], 503))
      .mockResolvedValueOnce(response([], 503))
      .mockResolvedValueOnce(response([], 503))
      .mockResolvedValueOnce(stalledBody)
      .mockResolvedValue(response([]));
    const detector = new PresidioDetector(config, { clock, fetcher, timeoutMs: 100 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(detector.detect("synthetic")).rejects.toMatchObject({
        code: "pii_detector_unavailable",
      });
    }

    now += 30_000;
    const halfOpen = detector.detect("synthetic");
    const halfOpenFailure = halfOpen.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);
    await expect(halfOpenFailure).resolves.toMatchObject({ code: "pii_detector_unavailable" });

    now += 30_000;
    await expect(detector.detect("synthetic")).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it("degrades exactly once when a stalled body exceeds the timeout", async () => {
    vi.useFakeTimers();
    const degraded = vi.spyOn(telemetry, "countPiiDetectorDegraded");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
      },
    });
    const detector = new PresidioDetector(config, {
      timeoutMs: 100,
      fetcher: () => Promise.resolve(new UndiciResponse(body)),
    });
    const registry = new DetectorRegistry({
      asyncDetectors: [detector],
      failMode: "regex_only",
    });
    const pending = Promise.resolve(registry.detect("synthetic"));

    await vi.advanceTimersByTimeAsync(100);

    await expect(pending).resolves.toEqual([]);
    expect(degraded).toHaveBeenCalledExactlyOnceWith();
  });

  it("rejects an oversized content-length before consuming the response body", async () => {
    const oversized = response([], 200, { "content-length": "5000000" });
    const body = oversized.body;
    if (body === null) {
      throw new Error("Expected a response body.");
    }
    const getReader = vi.spyOn(body, "getReader");
    const detector = new PresidioDetector(config, {
      fetcher: () => Promise.resolve(oversized),
    });

    await expect(detector.detect("synthetic")).rejects.toMatchObject({
      code: "pii_detector_unavailable",
    });
    expect(getReader).not.toHaveBeenCalled();
  });

  it("opens after five failures and permits one half-open request after the cooldown", async () => {
    let now = 100;
    const clock: PresidioClock = { now: () => now };
    const fetcher = vi.fn<PresidioFetcher>(() => Promise.resolve(response([], 503)));
    const detector = new PresidioDetector(config, { clock, fetcher });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(detector.detect("synthetic")).rejects.toMatchObject({
        code: "pii_detector_unavailable",
      });
    }
    await expect(detector.detect("synthetic")).rejects.toMatchObject({
      code: "pii_detector_unavailable",
    });
    expect(fetcher).toHaveBeenCalledTimes(5);

    now += 30_000;
    fetcher.mockImplementation(() => Promise.resolve(response([result("PERSON")])));
    await expect(detector.detect("0123456789")).resolves.toHaveLength(1);
    await expect(detector.detect("0123456789")).resolves.toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(7);
  });

  it("blocks concurrent probes while half-open and reopens after a failed probe", async () => {
    let now = 100;
    const clock: PresidioClock = { now: () => now };
    const fetcher = vi.fn<PresidioFetcher>(() => Promise.resolve(response([], 503)));
    const detector = new PresidioDetector(config, { clock, fetcher });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(detector.detect("synthetic")).rejects.toMatchObject({
        code: "pii_detector_unavailable",
      });
    }

    now += 30_000;
    let resolveHalfOpen: ((value: UndiciResponse) => void) | undefined;
    fetcher.mockImplementationOnce(
      () =>
        new Promise<UndiciResponse>((resolve) => {
          resolveHalfOpen = resolve;
        }),
    );
    const firstProbe = detector.detect("synthetic");
    await Promise.resolve();
    await expect(detector.detect("synthetic")).rejects.toMatchObject({
      code: "pii_detector_unavailable",
    });
    resolveHalfOpen?.(response([], 503));
    await expect(firstProbe).rejects.toMatchObject({ code: "pii_detector_unavailable" });
    await expect(detector.detect("synthetic")).rejects.toMatchObject({
      code: "pii_detector_unavailable",
    });
    expect(fetcher).toHaveBeenCalledTimes(6);
  });

  it("marks a configured analyzer reachable only when its health endpoint succeeds", async () => {
    const reachable = createPresidioReachableCheck(config, {
      fetcher: (url, init) => {
        expect(url.toString()).toBe("http://presidio:3000/health");
        expect(init.method).toBe("GET");
        return Promise.resolve(new UndiciResponse("Presidio Analyzer service is up"));
      },
    });
    const unavailable = createPresidioReachableCheck(config, {
      fetcher: () => Promise.resolve(response({}, 503)),
    });

    await expect(reachable.run({})).resolves.toEqual({
      status: "ok",
      code: "presidio_reachable",
    });
    await expect(unavailable.run({})).resolves.toEqual({
      status: "fail",
      code: "presidio_unreachable",
    });
  });

  it("rejects mapped results outside the input text", async () => {
    const detector = new PresidioDetector(config, {
      fetcher: () => Promise.resolve(response([result("PERSON", 9, 11)])),
    });

    await expect(detector.detect("0123456789")).rejects.toMatchObject({
      code: "pii_detector_unavailable",
    });
  });

  it("does not report an unrelated successful HTTP service as a reachable analyzer", async () => {
    const unrelatedService = createPresidioReachableCheck(config, {
      fetcher: () => Promise.resolve(new UndiciResponse("generic healthy service")),
    });

    await expect(unrelatedService.run({})).resolves.toEqual({
      status: "fail",
      code: "presidio_unreachable",
    });
  });

  it("does not follow a health-check redirect to another host", async () => {
    const visitedHosts: string[] = [];
    const fetcher = vi.fn<PresidioFetcher>((url) => {
      visitedHosts.push(url.host);
      return Promise.resolve(
        new UndiciResponse(null, {
          status: 307,
          headers: { location: "http://second.test:3000/health" },
        }),
      );
    });
    const check = createPresidioReachableCheck(config, {
      fetcher,
    });

    await expect(check.run({})).resolves.toEqual({
      status: "fail",
      code: "presidio_unreachable",
    });
    expect(visitedHosts).toEqual(["presidio:3000"]);
    expect(fetcher.mock.calls[0]?.[1].redirect).toBe("error");
  });
});
