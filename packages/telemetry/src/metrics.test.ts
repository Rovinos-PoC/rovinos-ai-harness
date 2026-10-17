// SPDX-License-Identifier: Apache-2.0
import { metrics } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  TELEMETRY_DROP_REASONS,
  TELEMETRY_METRIC_STRING_ATTRIBUTES,
  HOST_APP_REJECTED_REASONS,
  POLICY_DECISIONS,
  METRIC_ALLOWLIST,
  countHostAppRejected,
  countHostAppSpansAccepted,
  countModelUsage,
  countMcpDiscoveryFailed,
  countPiiBlobHit,
  countPiiDetectorDegraded,
  countPolicyDecision,
  countDroppedTelemetry,
  countSentinelScopeReduced,
  countSkippedShortValues,
  type TelemetryDropReason,
} from "./metrics.js";

const meter = metrics.getMeter("@harness/telemetry");
const counter = meter.createCounter("harness.telemetry.dropped");
const getMeter = vi.spyOn(metrics, "getMeter").mockReturnValue(meter);
const createdMetricNames: string[] = [];
function createAllowlistedCounter(name: string): typeof counter {
  if (!Object.hasOwn(METRIC_ALLOWLIST, name)) {
    throw new Error("metric_not_allowlisted");
  }
  createdMetricNames.push(name);
  return counter;
}
const createCounter = vi.spyOn(meter, "createCounter").mockImplementation(createAllowlistedCounter);
const add = vi.spyOn(counter, "add");

const dropReasons: readonly TelemetryDropReason[] = TELEMETRY_DROP_REASONS;

function expectAddCallsAreAllowlisted(name: keyof typeof METRIC_ALLOWLIST): void {
  const allowedKeys = METRIC_ALLOWLIST[name];
  for (const [, attributes] of add.mock.calls) {
    expect(
      Object.keys(attributes ?? {}).every((key) =>
        allowedKeys.some((allowedKey) => allowedKey === key),
      ),
    ).toBe(true);
  }
}

describe("countDroppedTelemetry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    add.mockImplementation(() => undefined);
  });

  it("records the bounded reason as the counter's only attribute", () => {
    for (const reason of dropReasons) {
      countDroppedTelemetry(reason);
    }

    expect(getMeter).toHaveBeenCalledWith("@harness/telemetry");
    expect(createCounter).toHaveBeenCalledWith("harness.telemetry.dropped");
    expect(add.mock.calls).toEqual(
      dropReasons.map((reason) => [1, { "harness.telemetry.dropped.reason": reason }]),
    );
    expectAddCallsAreAllowlisted("harness.telemetry.dropped");
  });

  it("contains metric provider failures", () => {
    add.mockImplementation(() => {
      throw new Error("metric provider failure");
    });

    expect(() => {
      countDroppedTelemetry("processor_error");
    }).not.toThrow();
    expectAddCallsAreAllowlisted("harness.telemetry.dropped");
  });

  it("counts host app rejections with a bounded reason", () => {
    for (const reason of HOST_APP_REJECTED_REASONS) {
      countHostAppRejected(reason);
    }

    expect(createCounter).toHaveBeenCalledWith("harness.host.app_rejected");
    expect(add.mock.calls).toEqual(
      HOST_APP_REJECTED_REASONS.map((reason) => [
        1,
        { "harness.host.app_rejected.reason": reason },
      ]),
    );
    expectAddCallsAreAllowlisted("harness.host.app_rejected");
  });

  it("counts policy decisions with only the closed decision attribute", () => {
    for (const decision of POLICY_DECISIONS) {
      countPolicyDecision(decision);
    }

    expect(createCounter).toHaveBeenCalledWith("harness.policy.decisions");
    expect(add.mock.calls).toEqual(
      POLICY_DECISIONS.map((decision) => [1, { "harness.policy.decision": decision }]),
    );
    expect(TELEMETRY_METRIC_STRING_ATTRIBUTES["harness.policy.decision"]).toEqual(POLICY_DECISIONS);
    expectAddCallsAreAllowlisted("harness.policy.decisions");
  });

  it("counts opaque PII blob hits without attributes", () => {
    countPiiBlobHit();

    expect(createCounter).toHaveBeenCalledWith("harness.pii.blob_hit");
    expect(add).toHaveBeenCalledWith(1);
    expectAddCallsAreAllowlisted("harness.pii.blob_hit");
  });

  it("counts degraded PII detection without attributes", () => {
    countPiiDetectorDegraded();

    expect(createCounter).toHaveBeenCalledWith("harness.pii.detector_degraded");
    expect(add).toHaveBeenCalledWith(1);
    expectAddCallsAreAllowlisted("harness.pii.detector_degraded");
  });

  it("counts accepted app spans without attributes", () => {
    countHostAppSpansAccepted(3);

    expect(createCounter).toHaveBeenCalledWith("harness.host.app_spans_accepted");
    expect(add).toHaveBeenCalledWith(3);
    expectAddCallsAreAllowlisted("harness.host.app_spans_accepted");
  });

  it("counts model tokens and cost using only namespaced provider and model attributes", () => {
    countModelUsage(
      {
        inputTokens: 2,
        outputTokens: 3,
        cacheReadTokens: 1,
        cacheWriteTokens: 2,
        costMicros: 11,
      },
      "sample",
      "model-a",
    );
    expect(createCounter).toHaveBeenCalledWith("harness.model.tokens");
    expect(createCounter).toHaveBeenCalledWith("harness.model.cache_read_tokens");
    expect(createCounter).toHaveBeenCalledWith("harness.model.cache_write_tokens");
    expect(createCounter).toHaveBeenCalledWith("harness.model.cost_micros");
    expect(add.mock.calls).toEqual([
      [5, { "harness.model.provider": "sample", "harness.model.name": "model-a" }],
      [1, { "harness.model.provider": "sample", "harness.model.name": "model-a" }],
      [2, { "harness.model.provider": "sample", "harness.model.name": "model-a" }],
      [11, { "harness.model.provider": "sample", "harness.model.name": "model-a" }],
    ]);
    expectAddCallsAreAllowlisted("harness.model.tokens");
    expectAddCallsAreAllowlisted("harness.model.cache_read_tokens");
    expectAddCallsAreAllowlisted("harness.model.cache_write_tokens");
    expectAddCallsAreAllowlisted("harness.model.cost_micros");
  });

  it("counts skipped short sentinel values without attributes", () => {
    countSkippedShortValues(3);

    expect(getMeter).toHaveBeenCalledWith("@harness/telemetry");
    expect(createCounter).toHaveBeenCalledWith("harness.sentinel.short_values_skipped");
    expect(add).toHaveBeenCalledWith(3);
    expectAddCallsAreAllowlisted("harness.sentinel.short_values_skipped");
  });

  it("counts MCP discovery failures without server-id attributes", () => {
    countMcpDiscoveryFailed();

    expect(createCounter).toHaveBeenCalledWith("harness.mcp.discovery_failed");
    expect(add).toHaveBeenCalledWith(1);
    expectAddCallsAreAllowlisted("harness.mcp.discovery_failed");
  });

  it("uses only closed-enum string attributes for metric instruments", () => {
    expect(HOST_APP_REJECTED_REASONS).toEqual([
      "schema",
      "size",
      "rate",
      "unknown_app",
      "unknown_tool",
      "unknown_span",
      "session_cap",
      "request_disabled",
      "request_invalid",
      "request_unavailable",
      "user_denied",
    ]);
    expect(TELEMETRY_METRIC_STRING_ATTRIBUTES).toEqual({
      "harness.telemetry.dropped.reason": dropReasons,
      "harness.host.app_rejected.reason": HOST_APP_REJECTED_REASONS,
      "harness.policy.decision": POLICY_DECISIONS,
    });
    expect(
      TELEMETRY_METRIC_STRING_ATTRIBUTES["harness.telemetry.dropped.reason"].length,
    ).toBeGreaterThan(0);
  });

  it("counts reduced global scan scope without metric attributes", () => {
    countSentinelScopeReduced();

    expect(createCounter).toHaveBeenCalledWith("harness.sentinel.scope_reduced");
    expect(add).toHaveBeenCalledWith(1);
    expectAddCallsAreAllowlisted("harness.sentinel.scope_reduced");
  });

  it("has an instrument for every allowlist entry and no stale entries", () => {
    expect([...createdMetricNames].sort()).toEqual(Object.keys(METRIC_ALLOWLIST).sort());
  });
});
