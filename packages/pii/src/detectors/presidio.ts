// SPDX-License-Identifier: Apache-2.0
import { Code, parseJson, type Detection, type PiiPresidioConfig } from "@harness/schemas";
import { fetch as undiciFetch } from "undici";
import type { Response as UndiciResponse } from "undici";
import { z } from "zod";
import { PiiDetectorError, validateText } from "./types.js";
import type { AsyncDetector } from "./types.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const PresidioResultSchema = z
  .object({
    entity_type: z.string().min(1).max(64),
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
    score: z.number().min(0).max(1),
    analysis_explanation: z.unknown().optional(),
    recognition_metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();

const PresidioResponseSchema = z.array(PresidioResultSchema);

const ENTITY_TYPES: Readonly<Record<string, string>> = {
  PERSON: "person_name",
  EMAIL_ADDRESS: "email",
  PHONE_NUMBER: "phone",
  CREDIT_CARD: "credit_card",
  IBAN_CODE: "iban",
  IP_ADDRESS: "ip_address",
  LOCATION: "location",
  US_SSN: "national_id",
};

interface PresidioRequestInit {
  readonly method: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly redirect: "error";
  readonly signal: AbortSignal;
}

interface TimeoutOptions<Result> {
  readonly timeoutMs: number;
  readonly parentSignal?: AbortSignal;
  readonly consumeResponse: (response: UndiciResponse, signal: AbortSignal) => Promise<Result>;
}

/** Injectable network edge for unit tests; production requests use Undici. */
export type PresidioFetcher = (url: URL, init: PresidioRequestInit) => Promise<UndiciResponse>;

/** Clock used by the adapter's circuit breaker. */
export interface PresidioClock {
  now(): number;
}

/** Optional edge dependencies for deterministic Presidio tests. */
export interface PresidioDetectorOptions {
  readonly clock?: PresidioClock;
  readonly fetcher?: PresidioFetcher;
  readonly timeoutMs?: number;
}

const systemClock: PresidioClock = { now: () => Date.now() };
const defaultFetcher: PresidioFetcher = (url, init) => undiciFetch(url, init);

/** Calls a Presidio analyzer and maps supported results to harness detections. */
export class PresidioDetector implements AsyncDetector {
  readonly id = Code.parse("presidio");
  readonly entityTypes = Object.values(ENTITY_TYPES).map((type) => Code.parse(type));
  private readonly clock: PresidioClock;
  private readonly fetcher: PresidioFetcher;
  private readonly timeoutMs: number;
  private readonly analyzeUrl: URL;
  private readonly config: PiiPresidioConfig;
  private consecutiveFailures = 0;
  private openUntil: number | undefined;
  private halfOpenInFlight = false;

  constructor(config: PiiPresidioConfig, options: PresidioDetectorOptions = {}) {
    this.config = config;
    this.analyzeUrl = endpointUrl(config.baseUrl, "analyze");
    this.clock = options.clock ?? systemClock;
    this.fetcher = options.fetcher ?? defaultFetcher;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Returns supported entity detections or a value-free unavailable error. */
  async detect(text: string): Promise<Detection[]> {
    validateText(text);
    this.enterCircuit();
    try {
      const requestBody = JSON.stringify({
        text,
        language: this.language,
        score_threshold: this.scoreThreshold,
      });
      const detections = await fetchWithTimeout(
        this.fetcher,
        this.analyzeUrl,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: requestBody,
        },
        {
          timeoutMs: this.timeoutMs,
          consumeResponse: async (response, signal) => {
            if (!response.ok) {
              throw new Error("Presidio request failed.");
            }
            const responseBody = await readBoundedBody(response, signal);
            const results = parseJson(PresidioResponseSchema, responseBody, {
              maxBytes: MAX_RESPONSE_BYTES,
            });
            return mapResults(text, results);
          },
        },
      );
      this.resetCircuit();
      return detections;
    } catch {
      this.recordFailure();
      throw new PiiDetectorError("pii_detector_unavailable");
    }
  }

  private get language(): string {
    return this.config.language;
  }

  private get scoreThreshold(): number {
    return this.config.scoreThreshold;
  }

  private enterCircuit(): void {
    if (this.openUntil === undefined) {
      return;
    }
    if (this.clock.now() < this.openUntil || this.halfOpenInFlight) {
      throw new PiiDetectorError("pii_detector_unavailable");
    }
    this.halfOpenInFlight = true;
  }

  private recordFailure(): void {
    this.halfOpenInFlight = false;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
      this.openUntil = this.clock.now() + CIRCUIT_COOLDOWN_MS;
    }
  }

  private resetCircuit(): void {
    this.consecutiveFailures = 0;
    this.openUntil = undefined;
    this.halfOpenInFlight = false;
  }
}

/** Safe `harness doctor` check for a configured Presidio analyzer. */
export function createPresidioReachableCheck(
  config: PiiPresidioConfig,
  options: Pick<PresidioDetectorOptions, "fetcher" | "timeoutMs"> = {},
): {
  readonly id: "presidio_reachable";
  readonly title: string;
  run(ctx: { readonly signal?: AbortSignal }): Promise<{
    readonly status: "ok" | "fail";
    readonly code: "presidio_reachable" | "presidio_unreachable";
  }>;
} {
  const fetcher = options.fetcher ?? defaultFetcher;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const healthUrl = endpointUrl(config.baseUrl, "health");
  return {
    id: "presidio_reachable",
    title: "Presidio analyzer",
    async run(ctx) {
      try {
        return await fetchWithTimeout(
          fetcher,
          healthUrl,
          { method: "GET" },
          {
            timeoutMs,
            ...(ctx.signal === undefined ? {} : { parentSignal: ctx.signal }),
            consumeResponse: async (response, signal) => {
              if (!response.ok) {
                return { status: "fail", code: "presidio_unreachable" };
              }
              const body = await readBoundedBody(response, signal);
              return body.trim() === "Presidio Analyzer service is up"
                ? { status: "ok", code: "presidio_reachable" }
                : { status: "fail", code: "presidio_unreachable" };
            },
          },
        );
      } catch {
        return { status: "fail", code: "presidio_unreachable" };
      }
    },
  };
}

function endpointUrl(baseUrl: string, endpoint: string): URL {
  try {
    const url = new URL(`${baseUrl.replace(/\/+$/u, "")}/${endpoint}`);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== ""
    ) {
      throw new Error("Invalid Presidio endpoint.");
    }
    return url;
  } catch {
    throw new PiiDetectorError("pii_detector_unavailable");
  }
}

async function fetchWithTimeout<Result>(
  fetcher: PresidioFetcher,
  url: URL,
  init: Omit<PresidioRequestInit, "signal" | "redirect">,
  options: TimeoutOptions<Result>,
): Promise<Result> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const abort = (): void => {
    controller.abort();
  };
  const { timeoutMs, parentSignal, consumeResponse } = options;
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (parentSignal?.aborted === true) {
    abort();
  }
  const aborted = new Promise<never>((_resolve, reject) => {
    const rejectAbort = (): void => {
      reject(new Error("Presidio request aborted."));
    };
    if (controller.signal.aborted) {
      rejectAbort();
    } else {
      controller.signal.addEventListener("abort", rejectAbort, { once: true });
    }
  });
  const timedOut = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      abort();
      reject(new Error("Presidio request timed out."));
    }, timeoutMs);
  });
  try {
    const request = Promise.resolve().then(async () => {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      return consumeResponse(response, controller.signal);
    });
    return await Promise.race([request, aborted, timedOut]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    parentSignal?.removeEventListener("abort", abort);
  }
}

async function readBoundedBody(response: UndiciResponse, signal?: AbortSignal): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_RESPONSE_BYTES) {
    throw new Error("Presidio response is too large.");
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return "";
  }
  const cancelReader = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancelReader, { once: true });
  if (signal?.aborted === true) {
    cancelReader();
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let done = false;
  try {
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (!done) {
        const value = z.instanceof(Uint8Array).parse(result.value);
        bytes += value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel().catch(() => undefined);
          throw new Error("Presidio response is too large.");
        }
        chunks.push(value);
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function mapResults(text: string, results: z.infer<typeof PresidioResponseSchema>): Detection[] {
  const offsets = codePointToUtf16Offsets(text);
  const detections: Detection[] = [];
  for (const result of results) {
    const entityType = ENTITY_TYPES[result.entity_type];
    if (entityType === undefined) {
      continue;
    }
    const start = offsets[result.start];
    const end = offsets[result.end];
    if (start === undefined || end === undefined || end <= start) {
      throw new Error("Presidio response has invalid offsets.");
    }
    detections.push({
      entityType: Code.parse(entityType),
      start,
      end,
      confidence: result.score,
      detectorId: Code.parse("presidio"),
    });
  }
  return detections;
}

function codePointToUtf16Offsets(text: string): number[] {
  const offsets = [0];
  let utf16Offset = 0;
  for (const character of text) {
    utf16Offset += character.length;
    offsets.push(utf16Offset);
  }
  return offsets;
}
