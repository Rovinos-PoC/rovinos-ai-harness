// SPDX-License-Identifier: Apache-2.0
// A failed preparation remains explicit; sanitized null must never become executable.
import {
  HarnessError,
  toPiiActionEventPayload,
  type Code,
  type Event,
  type Part,
} from "@harness/schemas";
import { UNREGISTERED_TOOL_ID } from "@harness/schemas";
import type { ModelCompletion, ModelToolCall, RunContext, ToolPort } from "../ports.js";
import type { RunRecorder } from "../recorder.js";
import type { VaultAudit } from "@harness/vault";

/** Internal preparation outcome, retained until the tool loop consumes it. */
export interface PreparedToolCall {
  readonly call: ModelToolCall;
  readonly errorCode?: Code;
}

/** Replaces unknown tool ids before they can be persisted or attributed to a tool span. */
export function normalizeUnregisteredToolCall(
  call: ModelToolCall,
  description: ReturnType<ToolPort["describe"]>,
  prepared?: PreparedToolCall,
): { readonly call: ModelToolCall; readonly prepared: PreparedToolCall } | undefined {
  if (description !== undefined) {
    return undefined;
  }
  const safeCall = { ...(prepared?.call ?? call), toolId: UNREGISTERED_TOOL_ID };
  return {
    call: safeCall,
    prepared: { call: safeCall, errorCode: prepared?.errorCode ?? "unknown_tool" },
  };
}

const preparationCodes = new Set([
  "pii_blocked",
  "pii_depth_exceeded",
  "pii_input_too_large",
  "pii_input_invalid",
  "pii_key_contains_pii",
  "pii_detector_failed",
  "pii_detector_invalid_output",
  "pii_vault_failed",
]);

/** Preserves recorder failures across fail-closed boundary handling. */
export class SummaryRecordingError extends HarnessError {
  readonly code = "pii_summary_record_failed";
  constructor(readonly failure: unknown) {
    super("PII summary recording failed");
  }
}

/** Adds only the model-input summary sink to a model provider's run context. */
export function piiActionRunContext(
  context: RunContext,
  recorder: RunRecorder,
  events: Event[],
): RunContext & Required<Pick<RunContext, "recordPiiAction">> {
  return {
    ...context,
    recordPiiAction: async (summary) => {
      try {
        events.push(
          await recorder.record({
            type: "pii_action",
            v: 1,
            ...toPiiActionEventPayload(summary),
          }),
        );
      } catch (error) {
        throw new SummaryRecordingError(error);
      }
    },
  };
}

/** Builds a summary sink whose failures must not be mistaken for PII failures. */
export function toolRunContext(
  context: RunContext,
  recorder: RunRecorder,
  events: Event[],
): RunContext {
  return {
    ...context,
    recordPiiAction: piiActionRunContext(context, recorder, events).recordPiiAction,
    recordVaultAudit: async (audit: VaultAudit) => {
      events.push(
        await recorder.record({
          type: "pii_action",
          v: 1,
          boundary: audit.boundary,
          action: audit.action,
          ...(audit.toolId === undefined ? {} : { toolId: audit.toolId }),
          entities: audit.entities,
        }),
      );
    },
    recordSubagentSpawned: async ({
      childRunId,
      role,
      parentCallId,
      budgetLimits,
      budgetDeadlineTs,
    }) => {
      events.push(
        await recorder.record({
          type: "subagent_spawned",
          v: 1,
          childRunId,
          role,
          parentCallId,
          ...(budgetLimits === undefined ? {} : { budgetLimits }),
          ...(budgetDeadlineTs === undefined ? {} : { budgetDeadlineTs }),
        }),
      );
    },
    recordSubagentCompleted: async ({
      childRunId,
      outcome,
      inputTokens,
      outputTokens,
      steps,
      costMicros,
    }) => {
      events.push(
        await recorder.record({
          type: "subagent_completed",
          v: 1,
          childRunId,
          outcome,
          inputTokens,
          outputTokens,
          ...(steps === undefined ? {} : { steps }),
          ...(costMicros === undefined ? {} : { costMicros }),
        }),
      );
    },
  };
}

/** Prepares once, scrubbing failed arguments and retaining a closed denial code. */
export async function prepareToolCall(
  tool: ToolPort,
  call: ModelToolCall,
  context: RunContext,
): Promise<PreparedToolCall> {
  if (tool.prepare === undefined) {
    return { call };
  }

  try {
    return { call: await tool.prepare(call, context) };
  } catch (error) {
    if (error instanceof SummaryRecordingError) {
      throw error.failure;
    }
    const errorCode =
      error instanceof HarnessError && preparationCodes.has(error.code)
        ? error.code
        : "pii_prepare_failed";
    return { call: { ...call, args: null }, errorCode };
  }
}

/** Sanitizes completion tool arguments once and drops opaque duplicate provider data. */
export async function prepareCompletion(
  completion: ModelCompletion,
  tool: ToolPort | undefined,
  context: RunContext,
): Promise<{ completion: ModelCompletion; preparedCalls: PreparedToolCall[] }> {
  const preparedCalls: PreparedToolCall[] = [];
  const parts: Part[] = [];
  for (const part of completion.parts) {
    if (part.type !== "tool_call") {
      parts.push(part);
      continue;
    }
    const unregistered = tool?.describe(part.toolId) === undefined;
    const call = {
      callId: part.callId,
      toolId: unregistered ? UNREGISTERED_TOOL_ID : part.toolId,
      args: part.args,
    };
    const prepared =
      tool === undefined || unregistered
        ? { call, errorCode: "unknown_tool" }
        : await prepareToolCall(tool, call, context);
    preparedCalls.push(prepared);
    parts.push({ type: "tool_call", ...prepared.call });
  }
  return {
    completion: {
      ...completion,
      parts,
      providerBlobs: tool?.prepare === undefined ? completion.providerBlobs : null,
    },
    preparedCalls,
  };
}
