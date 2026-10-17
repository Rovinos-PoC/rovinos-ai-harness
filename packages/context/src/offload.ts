// SPDX-License-Identifier: Apache-2.0
// Size limits and offsets use UTF-8 bytes; returned text pages end at code-point boundaries.
import { z } from "zod";
import {
  HarnessError,
  JsonValue,
  ToolSpecSchema,
  ToolBinaryPayloadSchema,
  type Code,
  type Id as IdValue,
  type JsonValue as JsonValueType,
  type ToolSpec,
  type PiiActionSummary,
} from "@harness/schemas";
import { SystemOffloadIdGenerator } from "./offload-id.js";

const MAX_READ_BYTES = 16 * 1024;
const OFFLOAD_DIRECTORY = ".harness/offload/";

/** Validates an offload handle. */
export const OffloadedHandleSchema = z
  .string()
  .length(29)
  .regex(/^wf_[0-9A-HJKMNP-TV-Z]{26}$/u);

/** Inferred offload handle. */
export type OffloadedHandle = z.infer<typeof OffloadedHandleSchema>;

/** Schema for the small result value stored in place of an offloaded result. */
export const OffloadedStub = z
  .object({
    $offloaded: z
      .object({
        handle: OffloadedHandleSchema,
        bytes: z.number().int().nonnegative(),
        preview: z.string(),
      })
      .strict(),
    metadata: JsonValue.optional(),
  })
  .strict();

/** Inferred offloaded result stub. */
export type OffloadedStub = z.infer<typeof OffloadedStub>;

export const ReadOffloadedResultSchema = z
  .object({
    data: z.string(),
    nextOffset: z.number().int().nonnegative().optional(),
    totalBytes: z.number().int().nonnegative(),
  })
  .strict();

/** Inferred result of a paged offload read. */
export type ReadOffloadedResult = z.infer<typeof ReadOffloadedResultSchema>;

/** Input contract for the built-in `read_offloaded` tool. */
export const ReadOffloadedInputSchema = z
  .object({
    handle: OffloadedHandleSchema,
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    length: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

/** Workspace-relative range in bytes. */
export interface WorkspaceReadRange {
  readonly offset: number;
  readonly length: number;
}

/**
 * Workspace access used by output offloading.
 *
 * Implementations must keep paths under `.harness/offload/`, reject traversal and
 * absolute paths, and refuse symlinks. Filesystem-backed implementations must
 * resolve the final path and reject any symlink or real path outside the real
 * `.harness/offload/` directory.
 */
export interface WorkspacePort {
  /**
   * Writes bytes to an offload path.
   *
   * @param path - Workspace-relative path below `.harness/offload/`.
   * @param data - Bytes to persist.
   */
  write(path: string, data: Uint8Array): Promise<void>;

  /** Reads bytes from an offload path, optionally selecting a byte range.
   * @param path - Workspace-relative path below `.harness/offload/`.
   * @param range - Optional byte offset and length.
   * @returns A copy of the requested bytes.
   * @throws WorkspaceFileNotFoundError when the file does not exist; ranges beyond EOF return empty bytes.
   */
  read(path: string, range?: WorkspaceReadRange): Promise<Uint8Array>;
}

/** Identifier source used to generate unique offload handles. */
export interface OffloadIdGenerator {
  /** Returns a valid ULID. */
  next(): IdValue;
}

/** Tool call accepted by an offloading decorator. */
export interface OffloadToolCall {
  readonly callId: IdValue;
  readonly toolId: Code;
  readonly args: JsonValueType;
}

/** Context supplied to an offloaded tool call. */
export interface OffloadRunContext {
  readonly runId: IdValue;
  readonly signal: AbortSignal;
  readonly recordPiiAction?: (summary: PiiActionSummary) => Promise<void>;
}

/** Result returned by a tool execution. */
export interface OffloadToolExecutionResult {
  readonly binary?: boolean;
  readonly metadata?: JsonValueType;
  readonly outcome: "ok" | "error";
  readonly result: JsonValueType;
  readonly errorCode?: Code;
}

/** Metadata describing retry behavior for a tool. */
export interface OffloadToolDescription {
  readonly idempotent: boolean;
  readonly timeoutMs: number;
}

/** Tool port shape accepted by {@link OffloadingToolPort}. */
export interface OffloadToolPortLike {
  /** Sanitizes arguments before durable recording. */
  prepare?(call: OffloadToolCall, context: OffloadRunContext): Promise<OffloadToolCall>;
  /** Returns metadata for a registered tool. */
  describe(toolId: Code, args?: JsonValueType): OffloadToolDescription | undefined;

  /** Returns provider-visible specifications for registered tools, when available. */
  getToolSpecs?(): readonly ToolSpec[];

  /** Executes a validated tool call. */
  execute(call: OffloadToolCall, context: OffloadRunContext): Promise<OffloadToolExecutionResult>;
}

/** Configuration for replacing large tool results with offload stubs. */
export const OffloadingToolOptionsSchema = z
  .object({
    thresholdBytes: z.number().int().nonnegative().default(8192),
    previewChars: z.number().int().nonnegative().default(400),
  })
  .strict();

/** Inferred offloading configuration. */
export type OffloadingToolOptions = z.input<typeof OffloadingToolOptionsSchema>;

/** Error raised when a workspace path is outside the offload directory. */
export class WorkspacePathError extends HarnessError {
  readonly code = "workspace_path_invalid";

  /** Creates an error for an invalid workspace-relative path. */
  constructor() {
    super("Workspace path is invalid.");
  }
}

/** Error raised when an offload file does not exist. */
export class WorkspaceFileNotFoundError extends HarnessError {
  readonly code = "workspace_file_not_found";

  /** Creates an error for an absent workspace file. */
  constructor() {
    super("Workspace file was not found.");
  }
}

function validateWorkspacePath(path: string): void {
  const segments = path.split("/");
  if (
    !path.startsWith(OFFLOAD_DIRECTORY) ||
    path.length === OFFLOAD_DIRECTORY.length ||
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some(
      (segment, index) => index > 1 && (segment === "." || segment === ".." || segment === ""),
    )
  ) {
    throw new WorkspacePathError();
  }
}

function validateRange(range: WorkspaceReadRange): void {
  if (
    !Number.isSafeInteger(range.offset) ||
    range.offset < 0 ||
    !Number.isSafeInteger(range.length) ||
    range.length < 0
  ) {
    throw new RangeError("Workspace read range must use non-negative safe integers.");
  }
}

/** In-memory workspace implementation for tests and embedded runs. */
export class InMemoryWorkspace implements WorkspacePort {
  private readonly files = new Map<string, Uint8Array>();

  /** {@inheritDoc WorkspacePort.write} */
  write(path: string, data: Uint8Array): Promise<void> {
    return Promise.resolve().then(() => {
      validateWorkspacePath(path);
      this.files.set(path, data.slice());
    });
  }

  /** {@inheritDoc WorkspacePort.read} */
  read(path: string, range?: WorkspaceReadRange): Promise<Uint8Array> {
    return Promise.resolve().then(() => {
      validateWorkspacePath(path);
      const data = this.files.get(path);
      if (data === undefined) {
        throw new WorkspaceFileNotFoundError();
      }
      if (range === undefined) {
        return data.slice();
      }
      validateRange(range);
      return data.slice(range.offset, range.offset + range.length);
    });
  }
}

/** Tool specification for registering the idempotent `read_offloaded` tool. */
export const READ_OFFLOADED_TOOL_SPEC: ToolSpec = ToolSpecSchema.parse({
  toolId: "read_offloaded",
  description: "Read a page of a large tool result stored in the run workspace.",
  inputSchema: JsonValue.parse(z.toJSONSchema(ReadOffloadedInputSchema)),
});

function offloadPath(handle: string): string {
  return `${OFFLOAD_DIRECTORY}${OffloadedHandleSchema.parse(handle)}.json`;
}

function toolError(errorCode: Code): OffloadToolExecutionResult {
  return { outcome: "error", errorCode, result: null };
}

function isContinuationByte(byte: number): boolean {
  return byte >= 0x80 && byte <= 0xbf;
}

function expectedUtf8Length(leadByte: number): number {
  if (leadByte <= 0x7f) {
    return 1;
  }
  if (leadByte >= 0xc2 && leadByte <= 0xdf) {
    return 2;
  }
  if (leadByte >= 0xe0 && leadByte <= 0xef) {
    return 3;
  }
  if (leadByte >= 0xf0 && leadByte <= 0xf4) {
    return 4;
  }
  return 1;
}

function incompleteUtf8TailStart(bytes: Uint8Array): number {
  let start = bytes.byteLength - 1;
  while (start >= 0 && isContinuationByte(bytes[start] ?? 0)) {
    start -= 1;
  }
  if (start < 0) {
    return bytes.byteLength;
  }
  const expectedLength = expectedUtf8Length(bytes[start] ?? 0);
  return bytes.byteLength - start < expectedLength ? start : bytes.byteLength;
}

interface LoadedOffloadPage {
  readonly page: Uint8Array;
  readonly totalBytes: number;
}

interface LoadOffloadPageOptions {
  readonly workspace: WorkspacePort;
  readonly handle: OffloadedHandle;
  readonly knownSizes: Map<OffloadedHandle, number>;
  readonly offset: number;
  readonly length: number;
}

async function hasWorkspaceByte(
  workspace: WorkspacePort,
  path: string,
  offset: number,
): Promise<boolean> {
  return (await workspace.read(path, { offset, length: 1 })).byteLength > 0;
}

async function findWorkspaceFileSize(workspace: WorkspacePort, path: string): Promise<number> {
  let lowerBound = 0;
  let upperBound = 1;
  while (await hasWorkspaceByte(workspace, path, upperBound)) {
    if (upperBound === Number.MAX_SAFE_INTEGER) {
      throw new RangeError("Workspace file exceeds the supported size.");
    }
    lowerBound = upperBound + 1;
    upperBound = Math.min(lowerBound * 2, Number.MAX_SAFE_INTEGER);
  }

  while (lowerBound < upperBound) {
    const midpoint = Math.floor((lowerBound + upperBound) / 2);
    if (await hasWorkspaceByte(workspace, path, midpoint)) {
      lowerBound = midpoint + 1;
    } else {
      upperBound = midpoint;
    }
  }
  return lowerBound;
}

async function loadOffloadPage(options: LoadOffloadPageOptions): Promise<LoadedOffloadPage> {
  const { workspace, handle, knownSizes, offset, length } = options;
  let totalBytes = knownSizes.get(handle);
  if (totalBytes === undefined) {
    totalBytes = await findWorkspaceFileSize(workspace, offloadPath(handle));
    knownSizes.set(handle, totalBytes);
  }
  return {
    page: await workspace.read(offloadPath(handle), { offset, length }),
    totalBytes,
  };
}

interface CompleteUtf8PageOptions {
  readonly workspace: WorkspacePort;
  readonly handle: OffloadedHandle;
  readonly offset: number;
  readonly length: number;
  readonly page: Uint8Array;
}

async function completeUtf8Page(options: CompleteUtf8PageOptions): Promise<Uint8Array> {
  const { workspace, handle, offset, length, page } = options;
  const boundedPage = page.byteLength > MAX_READ_BYTES ? page.slice(0, MAX_READ_BYTES) : page;
  const incompleteTailStart = incompleteUtf8TailStart(boundedPage);
  if (incompleteTailStart === boundedPage.byteLength) {
    return boundedPage;
  }

  const incompleteLength = boundedPage.byteLength - incompleteTailStart;
  const remainingLength =
    expectedUtf8Length(boundedPage[incompleteTailStart] ?? 0) - incompleteLength;
  if (
    length >= MAX_READ_BYTES ||
    remainingLength <= 0 ||
    boundedPage.byteLength + remainingLength > MAX_READ_BYTES
  ) {
    return boundedPage.slice(0, incompleteTailStart);
  }

  const remaining = await workspace.read(offloadPath(handle), {
    offset: offset + boundedPage.byteLength,
    length: remainingLength,
  });
  if (remaining.byteLength !== remainingLength) {
    return boundedPage.slice(0, incompleteTailStart);
  }

  const combined = new Uint8Array(boundedPage.byteLength + remaining.byteLength);
  combined.set(boundedPage);
  combined.set(remaining, boundedPage.byteLength);
  return combined;
}

async function readOffloaded(
  workspace: WorkspacePort,
  knownSizes: Map<OffloadedHandle, number>,
  call: OffloadToolCall,
): Promise<OffloadToolExecutionResult> {
  const input = ReadOffloadedInputSchema.safeParse(call.args);
  if (!input.success) {
    return toolError("invalid_arguments");
  }

  const { handle } = input.data;
  const offset = input.data.offset ?? 0;
  const length = Math.min(input.data.length ?? MAX_READ_BYTES, MAX_READ_BYTES);
  let loaded: LoadedOffloadPage;
  try {
    loaded = await loadOffloadPage({
      workspace,
      handle,
      knownSizes,
      offset,
      length,
    });
  } catch (error) {
    if (error instanceof WorkspaceFileNotFoundError) {
      return toolError("handle_not_found");
    }
    throw error;
  }

  if (loaded.page.length > 0 && isContinuationByte(loaded.page[0] ?? 0)) {
    return toolError("invalid_offset");
  }
  const page = await completeUtf8Page({
    workspace,
    handle,
    offset,
    length,
    page: loaded.page,
  });
  const nextOffset = offset + page.byteLength;
  const result = {
    data: new TextDecoder().decode(page),
    ...(page.byteLength > 0 && nextOffset < loaded.totalBytes ? { nextOffset } : {}),
    totalBytes: loaded.totalBytes,
  };
  ReadOffloadedResultSchema.parse(result);
  return {
    outcome: "ok",
    result: JsonValue.parse(result),
  };
}

/** Decorates a tool port to store large results and expose them through `read_offloaded`. */
export class OffloadingToolPort implements OffloadToolPortLike {
  private readonly options: z.infer<typeof OffloadingToolOptionsSchema>;
  private readonly knownSizes = new Map<OffloadedHandle, number>();
  private readonly ids: OffloadIdGenerator;

  /**
   * Wraps an executor with workspace offloading for large tool results.
   * PII tokenization must be applied by `inner` before this decorator.
   * @param inner - Tool port that performs PII tokenization before returning results.
   * @param workspace - Workspace used to persist and page offloaded results.
   * @param options - Byte threshold and preview character limit.
   * @param ids - Optional ULID generator, replaceable in tests.
   */
  constructor(
    private readonly inner: OffloadToolPortLike,
    private readonly workspace: WorkspacePort,
    options: OffloadingToolOptions = {},
    ids: OffloadIdGenerator = new SystemOffloadIdGenerator(),
  ) {
    this.options = OffloadingToolOptionsSchema.parse(options);
    this.ids = ids;
  }

  /** {@inheritDoc OffloadToolPortLike.describe} */
  describe(toolId: Code, args?: JsonValueType): OffloadToolDescription | undefined {
    if (toolId === "read_offloaded") {
      return { idempotent: true, timeoutMs: 30_000 };
    }
    return this.inner.describe(toolId, args);
  }

  /** {@inheritDoc OffloadToolPortLike.getToolSpecs} */
  getToolSpecs(): readonly ToolSpec[] {
    return [
      ...(this.inner.getToolSpecs?.() ?? []).filter(
        ({ toolId }) => toolId !== READ_OFFLOADED_TOOL_SPEC.toolId,
      ),
      READ_OFFLOADED_TOOL_SPEC,
    ];
  }

  /** Forwards preparation to the inner boundary. */
  async prepare(call: OffloadToolCall, context: OffloadRunContext): Promise<OffloadToolCall> {
    return this.inner.prepare?.(call, context) ?? call;
  }

  /** {@inheritDoc OffloadToolPortLike.execute} */
  async execute(
    call: OffloadToolCall,
    context: OffloadRunContext,
  ): Promise<OffloadToolExecutionResult> {
    if (call.toolId === "read_offloaded") {
      return readOffloaded(this.workspace, this.knownSizes, call);
    }

    const execution = await this.inner.execute(call, context);
    if (execution.binary === true && !ToolBinaryPayloadSchema.safeParse(execution.result).success) {
      return toolError("pii_input_invalid");
    }
    const serialized = JSON.stringify(execution.result);
    const data = new TextEncoder().encode(serialized);
    if (execution.binary !== true && serialized.length <= this.options.thresholdBytes) {
      return execution;
    }

    const handle = `wf_${this.ids.next()}`;
    await this.workspace.write(offloadPath(handle), data);
    const validatedHandle = OffloadedHandleSchema.parse(handle);
    this.knownSizes.set(validatedHandle, data.byteLength);

    return {
      outcome: execution.outcome,
      ...(execution.errorCode === undefined ? {} : { errorCode: execution.errorCode }),
      result: JsonValue.parse(
        OffloadedStub.parse({
          $offloaded: {
            handle: validatedHandle,
            bytes: data.byteLength,
            preview:
              execution.binary === true
                ? ""
                : Array.from(serialized).slice(0, this.options.previewChars).join(""),
          },
          ...(execution.metadata === undefined ? {} : { metadata: execution.metadata }),
        }),
      ),
    };
  }
}
