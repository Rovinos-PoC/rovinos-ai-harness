// SPDX-License-Identifier: Apache-2.0
import { Code, isRegexSafePattern, JsonValue, Sha256Hex, ToolSpecSchema } from "@harness/schemas";
import type { Id, JsonValue as JsonValueType, ToolSpec } from "@harness/schemas";
import { z } from "zod";

/** Maximum text range returned by `fs.read`. */
export const MAX_FS_READ_BYTES = 256 * 1024;
/** Maximum text content accepted by `fs.write`. */
export const MAX_FS_WRITE_BYTES = 1024 * 1024;
export const MAX_FS_REQUEST_TEXT_BYTES = 4 * 1024 * 1024;
export const MAX_FS_REQUEST_TRANSPORT_BYTES = 32 * 1024 * 1024;
/** Maximum timeout advertised for one workspace file operation. */
export const MAX_FS_TOOL_TIMEOUT_MS = 30_000;

const WorkspacePathSchema = z.string().min(1).max(4096);
const Utf8StringSchema = (maxBytes: number) =>
  z.string().refine((value) => new TextEncoder().encode(value).byteLength <= maxBytes);

/** Input contract for the `fs.read` tool. */
export const FsReadInputSchema = z
  .object({
    path: WorkspacePathSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    length: z.number().int().nonnegative().max(MAX_FS_READ_BYTES).optional(),
  })
  .strict();

/** Input contract for the `fs.write` tool. */
export const FsWriteInputSchema = z
  .object({
    path: WorkspacePathSchema,
    content: Utf8StringSchema(MAX_FS_WRITE_BYTES),
    mode: z.enum(["create", "overwrite"]),
    expectedSha256: Sha256Hex.optional(),
  })
  .strict();

/** Input contract for the `fs.edit` tool. */
export const FsEditInputSchema = z
  .object({
    path: WorkspacePathSchema,
    edits: z
      .array(
        z
          .object({
            oldText: Utf8StringSchema(MAX_FS_WRITE_BYTES).refine((text) => text.length > 0),
            newText: Utf8StringSchema(MAX_FS_WRITE_BYTES),
          })
          .strict(),
      )
      .min(1)
      .max(20),
    expectedSha256: Sha256Hex.optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const textBytes = input.edits.reduce(
      (total, edit) =>
        total +
        new TextEncoder().encode(edit.oldText).byteLength +
        new TextEncoder().encode(edit.newText).byteLength,
      0,
    );
    if (textBytes > MAX_FS_REQUEST_TEXT_BYTES) {
      context.addIssue({ code: "custom", message: "fs_invalid_input" });
    }
  });

/** Input contract for the `fs.list` tool. */
export const FsListInputSchema = z
  .object({
    path: WorkspacePathSchema,
    depth: z.number().int().min(0).max(3),
    limit: z.number().int().min(1).max(1000),
  })
  .strict();

/** Input contract for the `fs.search` tool. */
export const FsSearchInputSchema = z
  .object({
    query: Utf8StringSchema(4096).refine((query) => query.length > 0),
    regex: z.boolean(),
    path: WorkspacePathSchema.optional(),
    limit: z.number().int().min(1).max(200),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.regex && !isRegexSafePattern(input.query)) {
      context.addIssue({
        code: "custom",
        path: ["query"],
        message: "fs_regex_unsafe",
      });
    }
    if (input.regex) {
      try {
        new RegExp(input.query, "u");
      } catch {
        context.addIssue({
          code: "custom",
          path: ["query"],
          message: "fs_regex_invalid",
        });
      }
    }
  });

/** Workspace file operation name shared by the runner and local backend. */
export const FsOperationSchema = z.enum(["read", "write", "edit", "list", "search"]);
/** Inferred workspace operation name. */
export type FsOperation = z.infer<typeof FsOperationSchema>;
/** Closed set of workspace file operation errors returned by the runner. */
export const FsOperationErrorCodeSchema = z.enum([
  "edit_ambiguous",
  "edit_no_match",
  "fs_file_exists",
  "fs_file_not_found",
  "fs_invalid_input",
  "fs_not_directory",
  "fs_not_file",
  "fs_operation_failed",
  "fs_path_invalid",
  "workspace_quota_exceeded",
  "precondition_failed",
]);
/** Inferred workspace file error code. */
export type FsOperationErrorCode = z.infer<typeof FsOperationErrorCodeSchema>;

/** Parsed tool input for one workspace operation. */
export type FsReadInput = z.infer<typeof FsReadInputSchema>;
/** Parsed tool input for one workspace operation. */
export type FsWriteInput = z.infer<typeof FsWriteInputSchema>;
/** Parsed tool input for one workspace operation. */
export type FsEditInput = z.infer<typeof FsEditInputSchema>;
/** Parsed tool input for one workspace operation. */
export type FsListInput = z.infer<typeof FsListInputSchema>;
/** Parsed tool input for one workspace operation. */
export type FsSearchInput = z.infer<typeof FsSearchInputSchema>;

/** Input contract shared by all authenticated `/fs/<operation>` endpoints. */
export const FsOperationRequestSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("read"), input: FsReadInputSchema }).strict(),
  z.object({ operation: z.literal("write"), input: FsWriteInputSchema }).strict(),
  z.object({ operation: z.literal("edit"), input: FsEditInputSchema }).strict(),
  z.object({ operation: z.literal("list"), input: FsListInputSchema }).strict(),
  z.object({ operation: z.literal("search"), input: FsSearchInputSchema }).strict(),
]);
/** Inferred endpoint request body excluding its run ID. */
export type FsOperationRequest = z.infer<typeof FsOperationRequestSchema>;

/** Directory entry returned by `fs.list`. */
export const FsListEntrySchema = z
  .object({
    path: z.string().max(4096),
    type: z.enum(["directory", "file"]),
    bytes: z.number().int().nonnegative().optional(),
  })
  .strict();
/** Inferred directory entry. */
export type FsListEntry = z.infer<typeof FsListEntrySchema>;

const FsReadResultSchema = z.union([
  z.object({ binary: z.literal(true), bytes: z.number().int().nonnegative() }).strict(),
  z
    .object({
      binary: z.literal(false),
      bytes: z.number().int().nonnegative(),
      content: z.string(),
      offset: z.number().int().nonnegative(),
      path: z.string().max(4096),
    })
    .strict(),
]);
const FsWriteResultSchema = z
  .object({
    bytes: z.number().int().nonnegative(),
    path: z.string().max(4096),
    sha256: Sha256Hex,
  })
  .strict();
const FsListResultSchema = z
  .object({
    entries: z.array(FsListEntrySchema).max(1000),
    truncated: z.boolean(),
  })
  .strict();
const FsSearchResultSchema = z
  .object({
    matches: z
      .array(
        z
          .object({
            line: z.string().max(2048),
            lineNumber: z.number().int().positive(),
            path: z.string().max(4096),
          })
          .strict(),
      )
      .max(200),
    truncated: z.boolean(),
  })
  .strict();

/** Validated output shared by all workspace file operations. */
export const FsToolResultSchema = z.union([
  FsReadResultSchema,
  FsWriteResultSchema,
  FsListResultSchema,
  FsSearchResultSchema,
]);
/** Inferred workspace file operation output. */
export type FsToolResult = z.infer<typeof FsToolResultSchema>;

/** Backend implemented by the local and runner-backed sandbox implementations. */
export interface WorkspaceFileToolBackend {
  /** Performs one validated workspace operation for a run. */
  fileOperation(
    runId: Id,
    operation: FsOperation,
    input: unknown,
    signal: AbortSignal,
  ): Promise<FsToolResult>;
}

interface FsToolCall {
  readonly callId: Id;
  readonly toolId: Code;
  readonly args: JsonValueType;
}

interface FsToolContext {
  readonly runId: Id;
  readonly signal: AbortSignal;
}

interface FsToolExecution {
  readonly outcome: "ok" | "error";
  readonly result: JsonValueType;
  readonly errorCode?: Code;
}

const TOOL_SCHEMAS = {
  "fs.read": { operation: "read", inputSchema: FsReadInputSchema },
  "fs.write": { operation: "write", inputSchema: FsWriteInputSchema },
  "fs.edit": { operation: "edit", inputSchema: FsEditInputSchema },
  "fs.list": { operation: "list", inputSchema: FsListInputSchema },
  "fs.search": { operation: "search", inputSchema: FsSearchInputSchema },
} as const;

type FsToolId = keyof typeof TOOL_SCHEMAS;

function createToolSpecs(): readonly ToolSpec[] {
  return Object.entries(TOOL_SCHEMAS).map(([toolId, tool]) =>
    ToolSpecSchema.parse({
      toolId,
      description: `Safely ${tool.operation} workspace files without a shell.`,
      inputSchema: JsonValue.parse(z.toJSONSchema(tool.inputSchema)),
    }),
  );
}

const FS_TOOL_SPECS = createToolSpecs();
const FS_ERROR_CODES = new Set([
  "edit_ambiguous",
  "edit_no_match",
  "fs_file_exists",
  "fs_file_not_found",
  "fs_invalid_input",
  "fs_not_directory",
  "fs_not_file",
  "fs_operation_failed",
  "fs_path_invalid",
  "workspace_quota_exceeded",
  "precondition_failed",
]);

function isFsToolId(toolId: string): toolId is FsToolId {
  return Object.hasOwn(TOOL_SCHEMAS, toolId);
}

function parseToolInput(toolId: FsToolId, args: JsonValueType): FsOperationRequest | undefined {
  const tool = TOOL_SCHEMAS[toolId];
  const parsed = FsOperationRequestSchema.safeParse({ operation: tool.operation, input: args });
  return parsed.success ? parsed.data : undefined;
}

function toolErrorCode(error: unknown): Code {
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    FS_ERROR_CODES.has(error.code)
  ) {
    return Code.parse(error.code);
  }
  return "fs_operation_failed";
}

/** Exposes read, write, edit, list, and search as policy-controlled tools. */
export class FsTools {
  readonly #backend: WorkspaceFileToolBackend;
  readonly #excludedToolIds: ReadonlySet<string>;

  /** Creates the five workspace file tools around a sandbox backend. */
  constructor(backend: WorkspaceFileToolBackend, excludedToolIds: readonly Code[] = []) {
    this.#backend = backend;
    this.#excludedToolIds = new Set(excludedToolIds);
  }

  /** Return retry metadata, with writes and edits idempotent only when preconditioned. */
  describe(
    toolId: Code,
    args?: JsonValueType,
  ): { readonly idempotent: boolean; readonly timeoutMs: number } | undefined {
    if (!isFsToolId(toolId) || this.#excludedToolIds.has(toolId)) {
      return undefined;
    }
    const tool = TOOL_SCHEMAS[toolId];
    const parsed = args === undefined ? undefined : parseToolInput(toolId, args);
    return {
      idempotent:
        tool.operation === "read" ||
        tool.operation === "list" ||
        tool.operation === "search" ||
        (parsed !== undefined &&
          "expectedSha256" in parsed.input &&
          parsed.input.expectedSha256 !== undefined),
      timeoutMs: MAX_FS_TOOL_TIMEOUT_MS,
    };
  }

  /** Advertise strict, schema-derived input contracts to model providers. */
  getToolSpecs(): readonly ToolSpec[] {
    return FS_TOOL_SPECS.filter(({ toolId }) => !this.#excludedToolIds.has(toolId));
  }

  /** Validate and perform one file operation, leaving result decoration to the runtime. */
  async execute(call: FsToolCall, context: FsToolContext): Promise<FsToolExecution> {
    if (!isFsToolId(call.toolId) || this.#excludedToolIds.has(call.toolId)) {
      return { outcome: "error", errorCode: "fs_operation_failed", result: null };
    }
    const operation = parseToolInput(call.toolId, call.args);
    if (operation === undefined) {
      return { outcome: "error", errorCode: "fs_invalid_input", result: null };
    }
    try {
      const result = FsToolResultSchema.parse(
        await this.#backend.fileOperation(
          context.runId,
          operation.operation,
          operation.input,
          context.signal,
        ),
      );
      return { outcome: "ok", result: JsonValue.parse(result) };
    } catch (error) {
      return { outcome: "error", errorCode: toolErrorCode(error), result: null };
    }
  }
}

/** Creates the built-in workspace file tool provider, optionally excluding ids owned elsewhere. */
export function createFsTools(
  backend: WorkspaceFileToolBackend,
  excludedToolIds: readonly Code[] = [],
): FsTools {
  return new FsTools(backend, excludedToolIds);
}
