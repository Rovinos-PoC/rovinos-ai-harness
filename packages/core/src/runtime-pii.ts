// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import { SpanId, TraceId, type Code, type PiiConfig } from "@harness/schemas";
import {
  creditCardDetector,
  createCustomDetector,
  DetectorRegistry,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  Tokenizer,
  urlCredentialsDetector,
  PresidioDetector,
  PiiMessageSanitizer,
  type Detector,
} from "@harness/pii";
import {
  AuditingVaultResolver,
  type VaultScopeResolver,
  type VaultResolver,
  type VaultWriter,
} from "@harness/vault";
import { emitSafeEventToDefaultLogger, SafeEvent } from "@harness/telemetry";
import type { RunScopeRegistry } from "./subagent/scope.js";
import type { Clock } from "./recorder.js";

const fallbackTraceId = TraceId.parse("1".repeat(32));
const fallbackSpanId = SpanId.parse("2".repeat(16));

const builtInDetectors: readonly Detector[] = [
  creditCardDetector,
  emailDetector,
  ibanDetector,
  ipDetector,
  phoneDetector,
  secretsDetector,
  urlCredentialsDetector,
];

/** Inputs for constructing the runtime's shared PII components. */
export interface RuntimePiiOptions {
  readonly config: PiiConfig;
  readonly vault: VaultWriter & VaultResolver;
  readonly scopes: RunScopeRegistry;
  readonly scopeOf: VaultScopeResolver;
  readonly policyVersion: Code;
  readonly clock: Clock;
}

/** Builds the PII dependencies shared by the runtime's tool and storage boundaries. */
export function createRuntimePii({
  config,
  vault,
  scopes,
  scopeOf,
  policyVersion,
  clock,
}: RuntimePiiOptions): {
  readonly tokenizer: Tokenizer;
  readonly resolver: AuditingVaultResolver;
  readonly messageSanitizer: PiiMessageSanitizer;
} {
  const detectors = [
    ...builtInDetectors,
    ...(config.custom ?? []).map((detector) => createCustomDetector(detector)),
  ];
  const detectorRegistry = new DetectorRegistry({
    syncDetectors: detectors,
    asyncDetectors:
      config.presidio === undefined ? [] : [new PresidioDetector(config.presidio, { clock })],
    failMode: config.failMode,
  });
  const tokenizer = new Tokenizer({
    detectors: detectorRegistry,
    policy: config,
    vault,
    scopeOf: scopes.scopeOf,
  });
  const resolver = new AuditingVaultResolver(
    vault,
    (audit) => {
      const spanContext = trace.getSpan(context.active())?.spanContext();
      emitSafeEventToDefaultLogger(
        SafeEvent.parse({
          runId: audit.runId,
          seq: 0,
          ts: Math.max(0, Math.floor(clock.now())),
          traceId: spanContext?.traceId ?? fallbackTraceId,
          spanId: spanContext?.spanId ?? fallbackSpanId,
          policyVersion,
          kind: "pii_action",
          boundary: audit.boundary,
          action: audit.action,
          ...(audit.toolId === undefined ? {} : { toolId: audit.toolId }),
          entities: audit.entities,
        }),
      );
    },
    scopeOf,
  );
  const messageSanitizer = new PiiMessageSanitizer({
    tokenizer,
    detectors: detectorRegistry,
    policy: config,
    resolver,
  });
  return { tokenizer, resolver, messageSanitizer };
}
