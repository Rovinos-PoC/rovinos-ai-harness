// SPDX-License-Identifier: Apache-2.0
import { metrics, type Attributes, type Counter, type Meter } from "@opentelemetry/api";
import { Code, type Code as CodeType, type ModelUsage } from "@harness/schemas";

type NoMetricAttributes = Readonly<Record<string, never>>;

/** Closed reason values used by the dropped-telemetry metric. */
export const TELEMETRY_DROP_REASONS = [
  "unregistered_span",
  "unregistered_log_record",
  "unregistered_attr",
  "invalid_attr",
  "event_stripped",
  "leak_sentinel",
  "processor_error",
  "trip_queue_overflow",
  "trip_append_failed",
  "trip_flush_failed",
  "trip_discarded",
] as const;

/** Closed rejection reasons used by the host app-call counter. */
export const HOST_APP_REJECTED_REASONS = [
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
] as const;

/** Policy outcomes used by the decision counter. */
export const POLICY_DECISIONS = ["allow", "ask", "deny"] as const;

/** Bounded reasons for dropping or stripping telemetry data. */
export type TelemetryDropReason = (typeof TELEMETRY_DROP_REASONS)[number];
/** Bounded reasons counted when an app call is rejected by the host. */
export type HostAppRejectedReason = (typeof HOST_APP_REJECTED_REASONS)[number];
/** Bounded policy decision outcome. */
export type PolicyDecision = (typeof POLICY_DECISIONS)[number];
interface TelemetryDropAttributes extends Readonly<Record<string, TelemetryDropReason>> {
  readonly "harness.telemetry.dropped.reason": TelemetryDropReason;
}
interface HostAppRejectedAttributes extends Readonly<Record<string, HostAppRejectedReason>> {
  readonly "harness.host.app_rejected.reason": HostAppRejectedReason;
}
interface PolicyDecisionAttributes extends Readonly<Record<string, PolicyDecision>> {
  readonly "harness.policy.decision": PolicyDecision;
}
interface ModelUsageAttributes extends Readonly<Record<string, CodeType>> {
  readonly "harness.model.provider": CodeType;
  readonly "harness.model.name": CodeType;
}

/** String-valued metric attributes are explicitly closed enumerations. */
export const TELEMETRY_METRIC_STRING_ATTRIBUTES = {
  "harness.telemetry.dropped.reason": TELEMETRY_DROP_REASONS,
  "harness.host.app_rejected.reason": HOST_APP_REJECTED_REASONS,
  "harness.policy.decision": POLICY_DECISIONS,
} as const;

/** Collector allowlist of metric names and their allowed datapoint attribute keys. */
export const METRIC_ALLOWLIST = {
  "harness.host.app_rejected": ["harness.host.app_rejected.reason"],
  "harness.host.app_spans_accepted": [],
  "harness.model.cache_read_tokens": ["harness.model.provider", "harness.model.name"],
  "harness.model.cache_write_tokens": ["harness.model.provider", "harness.model.name"],
  "harness.model.tokens": ["harness.model.provider", "harness.model.name"],
  "harness.model.cost_micros": ["harness.model.provider", "harness.model.name"],
  "harness.policy.decisions": ["harness.policy.decision"],
  "harness.pii.blob_hit": [],
  "harness.pii.detector_degraded": [],
  "harness.sentinel.scope_reduced": [],
  "harness.sentinel.short_values_skipped": [],
  "harness.telemetry.dropped": ["harness.telemetry.dropped.reason"],
  "harness.mcp.discovery_failed": [],
} as const satisfies Record<Code, readonly Code[]>;

let droppedCounter: Counter<TelemetryDropAttributes> | undefined;
let hostAppRejectedCounter: Counter<HostAppRejectedAttributes> | undefined;
let policyDecisionsCounter: Counter<PolicyDecisionAttributes> | undefined;
let piiBlobHitCounter: Counter<NoMetricAttributes> | undefined;
let piiDetectorDegradedCounter: Counter<NoMetricAttributes> | undefined;
let hostAppSpansAcceptedCounter: Counter<NoMetricAttributes> | undefined;
let skippedShortValuesCounter: Counter<NoMetricAttributes> | undefined;
let scopeReducedCounter: Counter<NoMetricAttributes> | undefined;
let modelTokensCounter: Counter<ModelUsageAttributes> | undefined;
let modelCostCounter: Counter<ModelUsageAttributes> | undefined;
let modelCacheReadCounter: Counter<ModelUsageAttributes> | undefined;
let modelCacheWriteCounter: Counter<ModelUsageAttributes> | undefined;
let mcpDiscoveryFailedCounter: Counter<NoMetricAttributes> | undefined;

function createCounter<TAttributes extends Attributes>(
  name: keyof typeof METRIC_ALLOWLIST,
  factory: (meter: Meter, name: keyof typeof METRIC_ALLOWLIST) => Counter<TAttributes>,
): Counter<TAttributes> {
  return factory(metrics.getMeter("@harness/telemetry"), name);
}

function getDroppedCounter(): Counter<TelemetryDropAttributes> {
  droppedCounter ??= createCounter<TelemetryDropAttributes>(
    "harness.telemetry.dropped",
    (meter, name) => meter.createCounter<TelemetryDropAttributes>(name),
  );
  return droppedCounter;
}

function getHostAppRejectedCounter(): Counter<HostAppRejectedAttributes> {
  hostAppRejectedCounter ??= createCounter<HostAppRejectedAttributes>(
    "harness.host.app_rejected",
    (meter, name) => meter.createCounter<HostAppRejectedAttributes>(name),
  );
  return hostAppRejectedCounter;
}

function getPolicyDecisionsCounter(): Counter<PolicyDecisionAttributes> {
  policyDecisionsCounter ??= createCounter<PolicyDecisionAttributes>(
    "harness.policy.decisions",
    (meter, name) => meter.createCounter<PolicyDecisionAttributes>(name),
  );
  return policyDecisionsCounter;
}

function getPiiBlobHitCounter(): Counter<NoMetricAttributes> {
  piiBlobHitCounter ??= createCounter<NoMetricAttributes>("harness.pii.blob_hit", (meter, name) =>
    meter.createCounter<NoMetricAttributes>(name),
  );
  return piiBlobHitCounter;
}

function getPiiDetectorDegradedCounter(): Counter<NoMetricAttributes> {
  piiDetectorDegradedCounter ??= createCounter<NoMetricAttributes>(
    "harness.pii.detector_degraded",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return piiDetectorDegradedCounter;
}

function getHostAppSpansAcceptedCounter(): Counter<NoMetricAttributes> {
  hostAppSpansAcceptedCounter ??= createCounter<NoMetricAttributes>(
    "harness.host.app_spans_accepted",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return hostAppSpansAcceptedCounter;
}

function getSkippedShortValuesCounter(): Counter<NoMetricAttributes> {
  skippedShortValuesCounter ??= createCounter<NoMetricAttributes>(
    "harness.sentinel.short_values_skipped",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return skippedShortValuesCounter;
}

function getScopeReducedCounter(): Counter<NoMetricAttributes> {
  scopeReducedCounter ??= createCounter<NoMetricAttributes>(
    "harness.sentinel.scope_reduced",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return scopeReducedCounter;
}

function getModelTokensCounter(): Counter<ModelUsageAttributes> {
  modelTokensCounter ??= createCounter<ModelUsageAttributes>(
    "harness.model.tokens",
    (meter, name) => meter.createCounter<ModelUsageAttributes>(name),
  );
  return modelTokensCounter;
}

function getModelCostCounter(): Counter<ModelUsageAttributes> {
  modelCostCounter ??= createCounter<ModelUsageAttributes>(
    "harness.model.cost_micros",
    (meter, name) => meter.createCounter<ModelUsageAttributes>(name),
  );
  return modelCostCounter;
}

function getModelCacheReadCounter(): Counter<ModelUsageAttributes> {
  modelCacheReadCounter ??= createCounter<ModelUsageAttributes>(
    "harness.model.cache_read_tokens",
    (meter, name) => meter.createCounter<ModelUsageAttributes>(name),
  );
  return modelCacheReadCounter;
}

function getModelCacheWriteCounter(): Counter<ModelUsageAttributes> {
  modelCacheWriteCounter ??= createCounter<ModelUsageAttributes>(
    "harness.model.cache_write_tokens",
    (meter, name) => meter.createCounter<ModelUsageAttributes>(name),
  );
  return modelCacheWriteCounter;
}

function getMcpDiscoveryFailedCounter(): Counter<NoMetricAttributes> {
  mcpDiscoveryFailedCounter ??= createCounter<NoMetricAttributes>(
    "harness.mcp.discovery_failed",
    (meter, name) => meter.createCounter<NoMetricAttributes>(name),
  );
  return mcpDiscoveryFailedCounter;
}

/** Counts a telemetry drop using its bounded reason code. */
export function countDroppedTelemetry(reason: TelemetryDropReason): void {
  try {
    getDroppedCounter().add(1, { "harness.telemetry.dropped.reason": reason });
  } catch {
    return;
  }
}

/** Counts an app tool rejection with its bounded host reason code. */
export function countHostAppRejected(reason: HostAppRejectedReason): void {
  try {
    getHostAppRejectedCounter().add(1, { "harness.host.app_rejected.reason": reason });
  } catch {
    return;
  }
}

/** Counts one policy decision using its bounded outcome. */
export function countPolicyDecision(decision: PolicyDecision): void {
  try {
    getPolicyDecisionsCounter().add(1, { "harness.policy.decision": decision });
  } catch {
    return;
  }
}

/** Counts one opaque provider blob that contains detected sensitive content. */
export function countPiiBlobHit(): void {
  try {
    getPiiBlobHitCounter().add(1);
  } catch {
    return;
  }
}

/** Counts one PII detection run that continued without its configured async detector. */
export function countPiiDetectorDegraded(): void {
  try {
    getPiiDetectorDegradedCounter().add(1);
  } catch {
    return;
  }
}

/** Counts accepted app spans without high-cardinality attributes. */
export function countHostAppSpansAccepted(count: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) {
    return;
  }
  try {
    getHostAppSpansAcceptedCounter().add(count);
  } catch {
    return;
  }
}

/** Counts values excluded from a run's sentinel set without metric attributes. */
export function countSkippedShortValues(count: number): void {
  try {
    getSkippedShortValuesCounter().add(count);
  } catch {
    return;
  }
}

/** Counts when a global scan uses per-run matchers instead of a combined matcher. */
export function countSentinelScopeReduced(): void {
  try {
    getScopeReducedCounter().add(1);
  } catch {
    return;
  }
}

function isNonnegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isValidModelUsage(
  usage: Pick<
    ModelUsage,
    "inputTokens" | "outputTokens" | "costMicros" | "cacheReadTokens" | "cacheWriteTokens"
  >,
): boolean {
  return (
    isNonnegativeSafeInteger(usage.inputTokens) &&
    isNonnegativeSafeInteger(usage.outputTokens) &&
    Number.isSafeInteger(usage.inputTokens + usage.outputTokens) &&
    (usage.cacheReadTokens === undefined || isNonnegativeSafeInteger(usage.cacheReadTokens)) &&
    (usage.cacheWriteTokens === undefined || isNonnegativeSafeInteger(usage.cacheWriteTokens)) &&
    (usage.costMicros === undefined || isNonnegativeSafeInteger(usage.costMicros))
  );
}

/** Counts total input and output tokens and optional cost for one provider/model. */
export function countModelUsage(
  usage: Pick<
    ModelUsage,
    "inputTokens" | "outputTokens" | "costMicros" | "cacheReadTokens" | "cacheWriteTokens"
  >,
  provider: string,
  model: string,
): void {
  if (!isValidModelUsage(usage)) {
    return;
  }
  try {
    const attributes: ModelUsageAttributes = {
      "harness.model.provider": Code.parse(provider),
      "harness.model.name": Code.parse(model),
    };
    getModelTokensCounter().add(usage.inputTokens + usage.outputTokens, attributes);
    if (usage.cacheReadTokens !== undefined) {
      getModelCacheReadCounter().add(usage.cacheReadTokens, attributes);
    }
    if (usage.cacheWriteTokens !== undefined) {
      getModelCacheWriteCounter().add(usage.cacheWriteTokens, attributes);
    }
    if (usage.costMicros !== undefined) {
      getModelCostCounter().add(usage.costMicros, attributes);
    }
  } catch {
    return;
  }
}

/** Counts an MCP tool-discovery failure without server identifiers. */
export function countMcpDiscoveryFailed(): void {
  try {
    getMcpDiscoveryFailedCounter().add(1);
  } catch {
    return;
  }
}
