// SPDX-License-Identifier: Apache-2.0
import {
  Code,
  HarnessError,
  JsonValue,
  type Code as CodeType,
  type JsonValue as JsonValueType,
  type ToolSpec,
} from "@harness/schemas";
import type {
  ModelToolCall,
  RunContext,
  ToolDescription,
  ToolExecutionResult,
  ToolPort,
} from "../ports.js";
import type { RoleRegistry } from "../roles.js";
import { z } from "zod";
import type { SubagentResult } from "./result.js";
import type { SubagentSupervisor } from "./supervisor.js";

/** Strict model input for the built-in `agent.spawn` tool. */
export const AgentSpawnInputSchema = z
  .object({
    role: Code,
    goal: z.string().max(8_000),
    inputs: JsonValue.optional(),
  })
  .strict();

const AGENT_SPAWN_ID: CodeType = "agent.spawn";
const SPAWN_ERROR_CODES = new Set<CodeType>([
  "budget_exceeded",
  "subagent_children_limit",
  "subagent_depth_limit",
  "subagent_limit",
]);
const AGENT_SPAWN_SPEC = {
  toolId: AGENT_SPAWN_ID,
  description: "Run an isolated child agent with the selected role.",
  inputSchema: {
    type: "object",
    properties: {
      role: { type: "string" },
      goal: { type: "string", maxLength: 8_000 },
      inputs: {},
    },
    required: ["role", "goal"],
    additionalProperties: false,
  },
} satisfies ToolSpec;

/** Exposes `agent.spawn` alongside an existing tool registry. */
export class AgentSpawnTool implements ToolPort {
  constructor(
    private readonly inner: ToolPort,
    private readonly roles: RoleRegistry,
    private readonly supervisor: SubagentSupervisor,
  ) {}

  /** Returns a non-idempotent, bounded description for the spawn tool. */
  describe(toolId: CodeType): ToolDescription | undefined {
    if (toolId === AGENT_SPAWN_ID) {
      return {
        idempotent: false,
        timeoutMs: 300_000,
        longRunning: true,
        inputSchema: AGENT_SPAWN_SPEC.inputSchema,
      };
    }
    return this.inner.describe(toolId);
  }

  /** Advertises the spawn schema and all other underlying tools. */
  getToolSpecs(): readonly ToolSpec[] {
    const specs = this.inner.getToolSpecs?.() ?? [];
    return [...specs.filter(({ toolId }) => toolId !== AGENT_SPAWN_ID), AGENT_SPAWN_SPEC];
  }

  /** Leaves spawn inputs tokenized for the child run; delegates other preparation. */
  prepare(call: ModelToolCall, context: RunContext): Promise<ModelToolCall> {
    return this.inner.prepare?.(call, context) ?? Promise.resolve(call);
  }

  /** Execute the child run after validating its role and input schema. */
  async execute(call: ModelToolCall, context: RunContext): Promise<ToolExecutionResult> {
    if (call.toolId !== AGENT_SPAWN_ID) {
      return this.inner.execute(call, context);
    }
    const parsed = AgentSpawnInputSchema.safeParse(call.args);
    if (!parsed.success) {
      return { outcome: "error", errorCode: "agent_spawn_invalid", result: null };
    }
    const role = this.roles.resolveRole(parsed.data.role);
    let result: SubagentResult;
    try {
      result = await this.supervisor.spawn({
        role,
        goal: parsed.data.goal,
        ...(parsed.data.inputs === undefined ? {} : { inputs: parsed.data.inputs }),
        call,
        context,
      });
    } catch (error) {
      if (error instanceof HarnessError && SPAWN_ERROR_CODES.has(error.code)) {
        const errorCode = Code.safeParse(error.code);
        if (errorCode.success) {
          return { outcome: "error", errorCode: errorCode.data, result: null };
        }
      }
      throw error;
    }
    if (result.status === "failed" || result.status === "cancelled") {
      const errorCode = Code.safeParse(result.errorCode);
      return {
        outcome: "error",
        errorCode: errorCode.success ? errorCode.data : "subagent_failed",
        result: { childRunId: result.childRunId, status: result.status },
      };
    }
    const value: JsonValueType = JsonValue.parse(result);
    return { outcome: "ok", result: value };
  }
}
