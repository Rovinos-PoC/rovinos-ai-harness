// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAppTelemetry, type AppTelemetry, type SpanAttrs } from "@harness/app-telemetry";
import type { AppSpan } from "@harness/schemas";
import { createApprovalTelemetry, type ApprovalTelemetryEnvironment } from "./telemetry.js";

type SpanNames = readonly ["ui.render", "ui.decision", "ui.error", "ui.interaction"];
type TestTelemetry = AppTelemetry<SpanNames>;
const spanNames: SpanNames = ["ui.render", "ui.decision", "ui.error", "ui.interaction"];
const originalRequestAnimationFrame = Object.getOwnPropertyDescriptor(
  window,
  "requestAnimationFrame",
);
const originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");

function setup() {
  const records: {
    readonly name: string;
    readonly attrs: unknown;
    readonly durationMs?: number;
  }[] = [];
  const hostMetadata: unknown[] = [];
  const frames: FrameRequestCallback[] = [];
  let active = true;
  let now = 0;
  const record = vi.fn((name: SpanNames[number], attrs: unknown, durationMs?: number) => {
    records.push({ name, attrs, ...(durationMs === undefined ? {} : { durationMs }) });
  });
  const recordSpan = <Name extends SpanNames[number]>(
    name: Name,
    attrs: SpanAttrs<Name>,
    durationMs?: number,
  ): void => {
    record(name, attrs, durationMs);
  };
  const flush = vi.fn(() => Promise.resolve());
  const telemetry: TestTelemetry = {
    get active() {
      return active;
    },
    traceContext: { traceId: undefined },
    setHostMetadata(metadata: unknown) {
      hostMetadata.push(metadata);
    },
    start() {
      return { end: vi.fn() };
    },
    record: recordSpan,
    flush() {
      return flush();
    },
    stats() {
      return { dropped: 0 };
    },
    dispose() {
      return Promise.resolve();
    },
  };
  const environment: ApprovalTelemetryEnvironment = {
    window,
    document,
    now: () => now,
  };
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    value: (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    },
  });
  const lifecycle = createApprovalTelemetry(telemetry, environment);
  return {
    telemetry,
    lifecycle,
    records,
    frames,
    flush,
    setActive: (value: boolean) => {
      active = value;
    },
    setNow: (value: number) => {
      now = value;
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  if (originalRequestAnimationFrame === undefined) {
    Reflect.deleteProperty(window, "requestAnimationFrame");
  } else {
    Object.defineProperty(window, "requestAnimationFrame", originalRequestAnimationFrame);
  }
  if (originalVisibilityState === undefined) {
    Reflect.deleteProperty(document, "visibilityState");
  } else {
    Object.defineProperty(document, "visibilityState", originalVisibilityState);
  }
});

describe("approval app telemetry", () => {
  it("records one render after two animation frames and measures decision time from first paint", () => {
    const { lifecycle, records, frames, setNow } = setup();
    lifecycle.receivePayload(() => {
      setNow(2);
    });
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    setNow(12);
    expect(frames).toHaveLength(1);
    frames.shift()?.(0);
    expect(records).toEqual([{ name: "ui.render", attrs: {}, durationMs: 12 }]);
    setNow(19);
    expect(lifecycle.decisionDurationMs()).toBe(7);
    setNow(10);
    expect(lifecycle.decisionDurationMs()).toBe(0);
  });

  it("handles overlapping payload renders and uses only the latest completed render", () => {
    const { lifecycle, frames, records, setNow } = setup();
    lifecycle.receivePayload(() => undefined);
    lifecycle.receivePayload(() => undefined);
    setNow(5);
    frames.shift()?.(0);
    frames.shift()?.(0);
    setNow(10);
    frames.shift()?.(0);
    frames.shift()?.(0);
    expect(records.filter(({ name }) => name === "ui.render")).toHaveLength(2);
    setNow(18);
    expect(lifecycle.decisionDurationMs()).toBe(8);
  });

  it("deduplicates ambient errors and never records window error messages", () => {
    const { lifecycle, records } = setup();
    lifecycle.reportError("payload_invalid");
    lifecycle.reportError("payload_invalid");
    const canary = "SYNTHETIC_ERROR_MESSAGE_CANARY";
    window.dispatchEvent(new ErrorEvent("error", { message: canary, error: new Error(canary) }));
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: new Error(canary) });
    window.dispatchEvent(rejection);
    window.dispatchEvent(new ErrorEvent("error", { message: canary }));
    document.dispatchEvent(new Event("securitypolicyviolation"));
    document.dispatchEvent(new Event("securitypolicyviolation"));
    lifecycle.reportError("bridge_unavailable");
    lifecycle.reportError("resolve_failed");
    lifecycle.reportError("resolve_failed");
    lifecycle.reportError("reveal_failed");
    lifecycle.reportError("reveal_failed");
    expect(records).toEqual([
      { name: "ui.error", attrs: { code: "payload_invalid" } },
      { name: "ui.error", attrs: { code: "render_failed" } },
      { name: "ui.error", attrs: { code: "csp_blocked" } },
      { name: "ui.error", attrs: { code: "bridge_unavailable" } },
      { name: "ui.error", attrs: { code: "resolve_failed" } },
      { name: "ui.error", attrs: { code: "resolve_failed" } },
      { name: "ui.error", attrs: { code: "reveal_failed" } },
      { name: "ui.error", attrs: { code: "reveal_failed" } },
    ]);
    expect(JSON.stringify(records)).not.toContain(canary);
  });

  it("does not consume an ambient error dedupe slot before activation", () => {
    const { lifecycle, records, setActive } = setup();
    setActive(false);
    lifecycle.reportError("payload_invalid");
    expect(records).toEqual([]);
    setActive(true);
    lifecycle.reportError("payload_invalid");
    expect(records).toEqual([{ name: "ui.error", attrs: { code: "payload_invalid" } }]);
  });

  it("delivers a render span after delayed activation without delaying receive", async () => {
    vi.useFakeTimers();
    const { telemetry, lifecycle, records, frames, setActive, setNow } = setup();
    setActive(false);
    let received = false;
    lifecycle.receivePayload(() => {
      received = true;
    });
    expect(received).toBe(true);
    expect(records).toEqual([]);
    setNow(8);
    frames.shift()?.(0);
    setNow(20);
    frames.shift()?.(0);
    expect(records).toEqual([]);
    setActive(true);
    await vi.advanceTimersByTimeAsync(25);
    expect(records).toEqual([{ name: "ui.render", attrs: {}, durationMs: 20 }]);
    lifecycle.dispose();
    await telemetry.flush();
  });

  it("preserves the first-paint baseline across an unchanged payload delivery", () => {
    const { lifecycle, frames, setNow } = setup();
    lifecycle.receivePayload(() => true);
    setNow(10);
    frames.shift()?.(0);
    setNow(20);
    frames.shift()?.(0);
    setNow(30);
    lifecycle.receivePayload(() => false);
    setNow(40);
    frames.shift()?.(0);
    setNow(45);
    expect(lifecycle.decisionDurationMs()).toBe(25);
  });

  it("reports a throwing receive and completes its render lifecycle", () => {
    const { lifecycle, records, frames, setNow } = setup();
    const canary = "SYNTHETIC_RECEIVE_ERROR";
    lifecycle.receivePayload(() => {
      throw new Error(canary);
    });
    expect(frames).toHaveLength(1);
    expect(records).toEqual([{ name: "ui.error", attrs: { code: "render_failed" } }]);
    setNow(5);
    frames.shift()?.(0);
    frames.shift()?.(0);
    expect(records).toContainEqual({
      name: "ui.render",
      attrs: {},
      durationMs: 5,
    });
    expect(JSON.stringify(records)).not.toContain(canary);
  });

  it("clamps a decision duration to the span maximum", () => {
    const { lifecycle, frames, setNow } = setup();
    lifecycle.receivePayload(() => true);
    frames.shift()?.(0);
    setNow(1);
    frames.shift()?.(0);
    setNow(4_000_001);
    expect(lifecycle.decisionDurationMs()).toBe(3_600_000);
  });

  it("does not let unrelated unhandled rejections consume render failure reporting", () => {
    const { lifecycle, records } = setup();
    const rejection = new Event("unhandledrejection");
    Object.defineProperty(rejection, "reason", { value: new Error("bridge failed") });
    window.dispatchEvent(rejection);
    expect(records).toEqual([]);
    window.dispatchEvent(new ErrorEvent("error", { message: "SYNTHETIC_RENDER_ERROR" }));
    expect(records).toEqual([{ name: "ui.error", attrs: { code: "render_failed" } }]);
  });

  it("emits schema-shaped spans through the real telemetry shim with measured durations", async () => {
    const emitted: AppSpan[] = [];
    const frames: FrameRequestCallback[] = [];
    Object.defineProperty(window, "requestAnimationFrame", {
      configurable: true,
      value: (callback: FrameRequestCallback) => {
        frames.push(callback);
        return frames.length;
      },
    });
    let now = 100;
    const telemetry = createAppTelemetry({
      bridge: {
        callTool: async (_name, args) => {
          emitted.push(...args.spans);
          return { content: [] };
        },
      },
      hostReady: Promise.resolve(),
      manifest: { spans: spanNames },
      now: () => now,
    });
    await vi.waitFor(() => {
      expect(telemetry.active).toBe(true);
    });
    const environment: ApprovalTelemetryEnvironment = { window, document, now: () => now };
    const lifecycle = createApprovalTelemetry(telemetry, environment);
    lifecycle.receivePayload(() => true);
    now = 120;
    frames.shift()?.(0);
    now = 140;
    frames.shift()?.(0);
    lifecycle.reportError("payload_invalid");
    document.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("input"));
    lifecycle.flushInteractions();
    now = 160;
    telemetry.record("ui.decision", { decision: "approve" }, lifecycle.decisionDurationMs());
    await telemetry.flush();
    await vi.waitFor(() => {
      expect(emitted).toHaveLength(5);
    });
    expect(emitted.map(({ name }) => name)).toEqual([
      "ui.render",
      "ui.error",
      "ui.interaction",
      "ui.interaction",
      "ui.decision",
    ]);
    const allowedAttributes: Record<SpanNames[number], readonly string[]> = {
      "ui.render": ["name", "startOffsetMs", "durationMs"],
      "ui.decision": ["name", "decision", "startOffsetMs", "durationMs"],
      "ui.error": ["name", "code", "startOffsetMs", "durationMs"],
      "ui.interaction": ["name", "kind", "count", "startOffsetMs", "durationMs"],
    };
    for (const span of emitted) {
      expect(Object.keys(span).sort()).toEqual([...allowedAttributes[span.name]].sort());
    }
    expect(emitted[0]?.durationMs).toBe(40);
    expect(emitted[1]).toMatchObject({ name: "ui.error", code: "payload_invalid" });
    expect(emitted[2]).toMatchObject({
      name: "ui.interaction",
      kind: "click",
      count: 1,
    });
    expect(emitted[3]).toMatchObject({
      name: "ui.interaction",
      kind: "edit",
      count: 1,
    });
    expect(emitted[4]).toMatchObject({
      name: "ui.decision",
      decision: "approve",
      durationMs: 20,
    });
    lifecycle.dispose();
    await telemetry.dispose();
  });

  it("aggregates interactions by kind and flushes one span of each kind when hidden", () => {
    const { records, flush } = setup();
    document.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("click"));
    document.dispatchEvent(new Event("focus"));
    document.dispatchEvent(new Event("input"));
    document.dispatchEvent(new Event("input"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pagehide"));
    expect(records).toEqual([
      { name: "ui.interaction", attrs: { kind: "click", count: 2 } },
      { name: "ui.interaction", attrs: { kind: "focus", count: 1 } },
      { name: "ui.interaction", attrs: { kind: "edit", count: 2 } },
    ]);
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it("bounds interaction counts and flushes pending counts on disposal only once", () => {
    const { lifecycle, records, flush } = setup();
    for (let count = 0; count < 1002; count += 1) {
      document.dispatchEvent(new Event("click"));
    }
    document.dispatchEvent(new Event("input"));
    lifecycle.dispose();
    lifecycle.dispose();
    document.dispatchEvent(new Event("click"));
    expect(records).toEqual([
      { name: "ui.interaction", attrs: { kind: "click", count: 1000 } },
      { name: "ui.interaction", attrs: { kind: "edit", count: 1 } },
    ]);
    expect(flush).toHaveBeenCalledOnce();
    expect(lifecycle.decisionDurationMs()).toBe(0);
  });

  it("does not flush visible changes and ignores errors after disposal", () => {
    const { lifecycle, records, flush } = setup();
    document.dispatchEvent(new Event("click"));
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(records).toEqual([]);
    lifecycle.dispose();
    const callsAtDispose = records.length;
    window.dispatchEvent(new ErrorEvent("error", { message: "SYNTHETIC_CANARY" }));
    document.dispatchEvent(new Event("securitypolicyviolation"));
    expect(records).toHaveLength(callsAtDispose);
    expect(flush).toHaveBeenCalledOnce();
  });
});
