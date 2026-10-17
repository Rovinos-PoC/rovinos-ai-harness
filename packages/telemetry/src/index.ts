// SPDX-License-Identifier: Apache-2.0
export { attr, getAttrMeta, isSafeAttr, type AttrMeta } from "./attr.js";
export { SpanRegistryError, type SpanRegistryIssue } from "./errors.js";
export { LogRegistryError } from "./log-registry.js";
export { SafeEvent, toSafeEvent, type SafeEvent as SafeEventType } from "./safe-event.js";
export { AllowlistSpanProcessor, sanitizeSpan } from "./processors/allowlist-span-processor.js";
export { AllowlistLogRecordProcessor } from "./processors/allowlist-log-processor.js";
export {
  defineLogRecord,
  listLogDefinitions,
  lookupLogDefinition,
  type LogRecordDefinition,
  type LogRecordShape,
} from "./log-registry.js";
export {
  emitSafeEvent,
  emitSafeEventToDefaultLogger,
  emitKeysRotated,
  emitVaultMarkTerminalFailed,
  emitPricingMissing,
  emitPricingCacheMissing,
  safeEventLogAttributeMap,
} from "./safe-event-logs.js";
export { emitApprovalAppAudit } from "./approval-app-audit.js";
export {
  countDroppedTelemetry,
  countHostAppRejected,
  countHostAppSpansAccepted,
  countModelUsage,
  countMcpDiscoveryFailed,
  countPiiBlobHit,
  countPiiDetectorDegraded,
  countPolicyDecision,
  METRIC_ALLOWLIST,
  type HostAppRejectedReason,
  type PolicyDecision,
  POLICY_DECISIONS,
  type TelemetryDropReason,
} from "./metrics.js";
export {
  __resetRegistryForTests,
  defineSpan,
  defineSemconvSpan,
  ensureTracingFallback,
  listSpanDefinitions,
  lookupSpanDefinition,
  setActiveSpanAttribute,
  withSpan,
  type SpanDefinition,
  type SpanDefinitionShape,
  type SpanOwnerTask,
  type SpanShape,
} from "./registry.js";
export {
  MCP_METHOD_NAME,
  SEMCONV_ATTRIBUTE_NAMES,
  SEMCONV_SPAN_NAMES,
  SEMCONV_STABILITY_OPT_IN,
  SEMCONV_VERSION,
} from "./semconv.js";
export {
  RunValueSet,
  VaultRunView,
  type VaultRunReader,
  type VaultRunViewOptions,
} from "./sentinel/run-values.js";
export { ActiveRuns, activeRuns, type ActiveRunsOptions } from "./sentinel/active-runs.js";
export {
  assertSentinelGate,
  SentinelGate,
  SentinelGateInputSchema,
  SentinelGateResultSchema,
  SentinelRequiredError,
  type SentinelGateInput,
  type SentinelGateOptions,
  type SentinelGateResult,
  type SentinelMatcherLike,
} from "./sentinel/gate.js";
export {
  SentinelTripSchema,
  TripQueue,
  sentinelTripQueue,
  type SentinelTrip,
} from "./sentinel/trips.js";
export { emitSentinelTrip } from "./safe-event-logs.js";
export {
  createTelemetrySdk,
  forceFlushTelemetry,
  type TelemetrySdk,
  type TelemetrySdkOptions,
} from "./sdk.js";
