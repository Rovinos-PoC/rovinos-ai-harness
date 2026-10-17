// SPDX-License-Identifier: Apache-2.0
// Preparation owns durable arguments; execution owns only the ephemeral raw copy.
import {
  ToolBinaryPayloadSchema,
  compileJsonSchema,
  type Code,
  type Id,
  type JsonValue,
  type PiiActionSummary,
  type PiiConfig,
  type ToolSpec,
} from "@harness/schemas";
import { type AuditingVaultResolver, type VaultAuditHandler } from "@harness/vault";
import { detokenizeArgs, PiiTokenUnresolvableError } from "./detokenize.js";
import { PiiBlockedError, PiiTokenizerError } from "./errors.js";
import { markSanitized, markSanitizedField } from "./pii-event-store.js";
import type { Tokenizer } from "./tokenizer.js";

/** Schema-typed tool invocation, structurally compatible with core's port. */
export interface PiiToolCall {
  readonly callId: Id;
  readonly toolId: Code;
  readonly args: JsonValue;
}

/** Active run and optional durable summary sink. */
export interface PiiToolContext {
  readonly runId: Id;
  readonly signal: AbortSignal;
  readonly recordPiiAction?: (summary: PiiActionSummary) => Promise<void>;
  readonly recordVaultAudit?: VaultAuditHandler;
}

/** JSON execution contract with a validated numeric-byte binary representation. */
export interface PiiToolResult {
  readonly binary?: boolean;
  readonly metadata?: JsonValue;
  readonly outcome: "ok" | "error";
  readonly result: JsonValue;
  readonly errorCode?: Code;
}

/** Structural port avoids a dependency from PII back to core. */
export interface PiiToolPortLike {
  describe(
    toolId: Code,
    args?: JsonValue,
  ):
    | {
        readonly idempotent: boolean;
        readonly timeoutMs: number;
        readonly longRunning?: boolean;
        readonly inputSchema?: JsonValue;
      }
    | undefined;
  getToolSpecs?(): readonly ToolSpec[];
  prepare?(call: PiiToolCall, context: PiiToolContext): Promise<PiiToolCall>;
  execute(call: PiiToolCall, context: PiiToolContext): Promise<PiiToolResult>;
}

/** Injected tokenizer, full allowlist configuration, and auditing resolver. */
export interface PiiToolPortDependencies {
  readonly tokenizer: Tokenizer;
  readonly config: PiiConfig;
  readonly resolver: AuditingVaultResolver;
}

const safeToolErrorCodes = new Set([
  "args_invalid",
  "binary_result_unavailable",
  "edit_ambiguous",
  "edit_no_match",
  "fs_file_exists",
  "fs_file_not_found",
  "fs_invalid_input",
  "fs_not_directory",
  "fs_not_file",
  "fs_operation_failed",
  "fs_path_invalid",
  "mcp_capability_missing",
  "mcp_connection_lost",
  "mcp_error",
  "mcp_header_mismatch",
  "mcp_internal_error",
  "mcp_invalid_params",
  "mcp_method_not_found",
  "mcp_protocol_unsupported",
  "mcp_timeout",
  "mcp_tool_not_found",
  "result_too_large",
  "tool_reported_error",
  "workspace_quota_exceeded",
  "precondition_failed",
]);

/** Tokenizes before persistence and resolves only allowlisted pointers in memory. */
export class PiiToolPort implements PiiToolPortLike {
  constructor(
    private readonly inner: PiiToolPortLike,
    private readonly deps: PiiToolPortDependencies,
  ) {}

  /** Forwards retry and timeout metadata. */
  describe(toolId: Code, args?: JsonValue): ReturnType<PiiToolPortLike["describe"]> {
    return this.inner.describe(toolId, args);
  }

  /**
   * Validates schema constraints after resolving tokens only into a temporary in-memory copy.
   *
   * @param toolId - Tool receiving the input.
   * @param args - Tokenized arguments to validate.
   * @param schema - External JSON Schema supplied by the tool.
   * @param context - Active run and cancellation context.
   * @returns Whether the resolved copy satisfies the schema.
   */
  async validateInputSchema(
    toolId: Code,
    args: JsonValue,
    schema: JsonValue,
    context: PiiToolContext,
  ): Promise<boolean> {
    try {
      const { args: resolved } = await detokenizeArgs(
        context.runId,
        toolId,
        args,
        this.deps.config,
        this.deps.resolver,
        context.recordVaultAudit,
      );
      compileJsonSchema(schema)(resolved);
      return true;
    } catch {
      return false;
    }
  }

  /** Forwards provider-visible tool specifications. */
  getToolSpecs(): readonly ToolSpec[] {
    return this.inner.getToolSpecs?.() ?? [];
  }

  /** Produces the arguments that may enter the durable log. */
  async prepare(call: PiiToolCall, context: PiiToolContext): Promise<PiiToolCall> {
    let tokenized;
    try {
      tokenized = await this.deps.tokenizer.tokenizeJson(context.runId, call.args, {
        boundary: "tool_input",
        destination: { tool: call.toolId },
      });
    } catch (error) {
      if (error instanceof PiiBlockedError) {
        await context.recordPiiAction?.({
          boundary: "tool_input",
          action: "block",
          entities: [...error.entities],
        });
      }
      throw error;
    }
    for (const summary of tokenized.actions) {
      await context.recordPiiAction?.(summary);
    }
    // An allow policy controls tool access, not permission to persist raw content.
    const stored = tokenized.actions.some(({ action }) => action === "allow")
      ? await this.deps.tokenizer.tokenizeJson(context.runId, tokenized.value, {
          boundary: "storage",
          destination: { tool: call.toolId },
        })
      : tokenized;
    const prepared = { ...call, args: markJsonSanitized(stored.value) };
    markSanitizedField(prepared, "args");
    // Future policy decorators decide in prepare, while arguments still carry tokens.
    return this.inner.prepare?.(prepared, context) ?? prepared;
  }

  /** Resolves an ephemeral copy and sanitizes output before an outer offloader sees it. */
  async execute(call: PiiToolCall, context: PiiToolContext): Promise<PiiToolResult> {
    let args: JsonValue;
    try {
      const resolved = await detokenizeArgs(
        context.runId,
        call.toolId,
        call.args,
        this.deps.config,
        this.deps.resolver,
        context.recordVaultAudit,
      );
      args = resolved.args;
    } catch (error) {
      // Arbitrary tool exception codes are attacker-controlled, even when regex-valid.
      const code = error instanceof PiiTokenUnresolvableError ? error.code : "pii_vault_failed";
      return { outcome: "error", errorCode: code, result: null };
    }
    let execution: PiiToolResult;
    try {
      execution = await this.inner.execute({ ...call, args }, context);
    } catch (error) {
      if (context.signal.aborted) {
        throw error;
      }
      return { outcome: "error", errorCode: "tool_failed", result: null };
    }
    if (execution.binary === true) {
      return binaryResult(execution, call, context, this.deps.tokenizer);
    }
    return tokenizeToolOutput(execution, call, context, this.deps.tokenizer);
  }
}

async function binaryResult(
  execution: PiiToolResult,
  call: PiiToolCall,
  context: PiiToolContext,
  tokenizer: Tokenizer,
): Promise<PiiToolResult> {
  const payload = ToolBinaryPayloadSchema.safeParse(execution.result);
  if (!payload.success) {
    return { outcome: "error", errorCode: "pii_input_invalid", result: null };
  }
  let metadata: JsonValue | undefined;
  if (execution.metadata !== undefined) {
    const sanitized = await tokenizeToolOutput(
      {
        outcome: execution.outcome,
        result: execution.metadata,
        ...(execution.errorCode === undefined ? {} : { errorCode: execution.errorCode }),
      },
      call,
      context,
      tokenizer,
    );
    if (sanitized.outcome === "error") {
      return sanitized;
    }
    metadata = sanitized.result;
  }
  const result = {
    outcome: execution.outcome,
    result: payload.data,
    binary: true,
    ...(execution.outcome === "error" ? { errorCode: "tool_failed" } : {}),
    ...(metadata === undefined ? {} : { metadata }),
  };
  return metadata === undefined ? result : markSanitizedField(result, "metadata");
}

function markJsonSanitized(value: JsonValue): JsonValue {
  return typeof value === "object" && value !== null ? markSanitized(value) : value;
}

function safeToolErrorCode(code: Code | undefined): Code {
  return code !== undefined && safeToolErrorCodes.has(code) ? code : "tool_failed";
}

async function tokenizeToolOutput(
  execution: PiiToolResult,
  call: PiiToolCall,
  context: PiiToolContext,
  tokenizer: Tokenizer,
): Promise<PiiToolResult> {
  try {
    const tokenized = await tokenizer.tokenizeJson(context.runId, execution.result, {
      boundary: "tool_output",
      destination: { tool: call.toolId },
    });
    for (const summary of tokenized.actions) {
      await context.recordPiiAction?.(summary);
    }
    const stored = tokenized.actions.some(({ action }) => action === "allow")
      ? await tokenizer.tokenizeJson(context.runId, tokenized.value, {
          boundary: "storage",
          destination: { tool: call.toolId },
        })
      : tokenized;
    const result = {
      outcome: execution.outcome,
      result: markJsonSanitized(stored.value),
      ...(execution.outcome === "error"
        ? { errorCode: safeToolErrorCode(execution.errorCode) }
        : {}),
    };
    return markSanitizedField(result, "result");
  } catch (error) {
    if (error instanceof PiiBlockedError) {
      await context.recordPiiAction?.({
        boundary: "tool_output",
        action: "block",
        entities: [...error.entities],
      });
    }
    if (error instanceof PiiBlockedError || error instanceof PiiTokenizerError) {
      return { outcome: "error", errorCode: error.code, result: null };
    }
    throw error;
  }
}
