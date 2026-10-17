// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Code, type ToolSpec } from "@harness/schemas";
import {
  createFsTools,
  createWebFetchTool,
  InProcessBackend,
  RemoteSandboxBackend,
} from "@harness/sandbox";
import type { SandboxBackend } from "@harness/sandbox";
import type { ToolPort } from "./ports.js";
import type { RuntimeConfig } from "./runtime-config.js";

/** Startup failure raised when two composed tool ports expose the same tool id. */
export class ToolPortCollisionError extends HarnessError {
  readonly code = "tool_id_collision";

  constructor(readonly toolId: Code) {
    super("tool_id_collision");
  }
}

/** Routes a built-in tool alongside an existing runtime tool port. */
export function composeToolPorts(additional: ToolPort, existing: ToolPort): ToolPort {
  const ports = [additional, existing];
  const advertised = ports.map(
    (port) => new Set((port.getToolSpecs?.() ?? []).map(({ toolId }) => toolId)),
  );
  const toolIds = new Set(advertised.flatMap((toolIdsForPort) => [...toolIdsForPort]));
  for (const toolId of toolIds) {
    const owners = ports.filter(
      (port, index) =>
        advertised[index]?.has(toolId) === true || port.describe(toolId) !== undefined,
    );
    if (owners.length > 1) {
      throw new ToolPortCollisionError(toolId);
    }
  }
  const portFor = (toolId: Code): ToolPort =>
    ports.find((port) => port.describe(toolId) !== undefined) ?? existing;
  const getToolSpecs = () => {
    const specs = new Map<Code, ToolSpec>();
    for (const port of ports) {
      for (const spec of port.getToolSpecs?.() ?? []) {
        if (!specs.has(spec.toolId)) {
          specs.set(spec.toolId, spec);
        }
      }
    }
    return [...specs.values()];
  };
  const prepare = ports.some((port) => port.prepare !== undefined)
    ? (
        call: Parameters<NonNullable<ToolPort["prepare"]>>[0],
        context: Parameters<NonNullable<ToolPort["prepare"]>>[1],
      ) => portFor(call.toolId).prepare?.(call, context) ?? Promise.resolve(call)
    : undefined;
  const validateInputSchema = ports.some((port) => port.validateInputSchema !== undefined)
    ? (
        toolId: Code,
        args: Parameters<NonNullable<ToolPort["validateInputSchema"]>>[1],
        schema: Parameters<NonNullable<ToolPort["validateInputSchema"]>>[2],
        context: Parameters<NonNullable<ToolPort["validateInputSchema"]>>[3],
      ) =>
        portFor(toolId).validateInputSchema?.(toolId, args, schema, context) ??
        Promise.resolve(true)
    : undefined;
  return {
    ...(prepare === undefined ? {} : { prepare }),
    ...(validateInputSchema === undefined ? {} : { validateInputSchema }),
    describe: (toolId, args) => portFor(toolId).describe(toolId, args),
    getToolSpecs,
    execute: (call, context) => portFor(call.toolId).execute(call, context),
  };
}

/** Adds runner-backed tools without shadowing tools already owned by the runtime port. */
export function composeSandboxTools(
  config: RuntimeConfig,
  backend: SandboxBackend,
  existing: ToolPort,
  useWorkspace: boolean,
): ToolPort {
  let composed = existing;
  if (backend instanceof InProcessBackend || backend instanceof RemoteSandboxBackend) {
    const candidate = createFsTools(backend);
    const ownedIds = new Set((existing.getToolSpecs?.() ?? []).map(({ toolId }) => toolId));
    const excludedIds = candidate
      .getToolSpecs()
      .filter(({ toolId }) => ownedIds.has(toolId) || existing.describe(toolId) !== undefined)
      .map(({ toolId }) => toolId);
    const fileTools = createFsTools(backend, excludedIds);
    if (fileTools.getToolSpecs().length > 0) {
      composed = composeToolPorts(fileTools, composed);
    }
  }
  if (backend instanceof RemoteSandboxBackend) {
    const webFetch = createWebFetchTool(config.sandbox?.egress?.allow, backend, useWorkspace);
    if (webFetch !== undefined) {
      composed = composeToolPorts(webFetch, composed);
    }
  }
  return composed;
}
