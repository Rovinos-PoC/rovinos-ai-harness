// SPDX-License-Identifier: Apache-2.0
import {
  context as otelContext,
  isSpanContextValid,
  ROOT_CONTEXT,
  trace,
  type Context,
  type Link,
  type SpanContext,
} from "@opentelemetry/api";
import { HarnessError, type Code, type Event, type Id, type JsonValue } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { IdGenerator, ModelToolCall, RunContext, ToolPort } from "../ports.js";
import type { ResolvedRole } from "../roles.js";
import type { RunScopeRegistry } from "./scope.js";
import type { SubagentResult } from "./result.js";
import { aggregateSubagentUsage } from "./result.js";

/** Stable errors raised before a child run can start. */
export type SubagentErrorCode =
  | "subagent_depth_limit"
  | "subagent_children_limit"
  | "subagent_recorder_unavailable"
  | "subagent_parent_span_missing";

/** Safe failure for invalid subagent creation state. */
export class SubagentError extends HarnessError {
  readonly code: SubagentErrorCode;

  constructor(code: SubagentErrorCode) {
    super(`Subagent spawn failed (${code}).`);
    this.code = code;
  }
}

/** Input passed to the child-run callback after the parent announcement is durable. */
export interface SubagentRunRequest {
  readonly runId: Id;
  readonly parentRunId: Id;
  readonly parentCallId: Id;
  readonly depth: number;
  readonly scopeId: Id;
  readonly role: ResolvedRole;
  readonly input: JsonValue;
  readonly tools: ToolPort;
  readonly signal: AbortSignal;
  readonly parentSpanContext: SpanContext;
  readonly rootSpanParent: Context;
  readonly rootSpanLinks: readonly Link[];
}

/** Executes an isolated child run and returns its JSON-safe result. */
export type SubagentRunner = (request: SubagentRunRequest) => Promise<SubagentResult>;

/** Request to create and await one child run. */
export interface SubagentSpawnInput {
  readonly role: ResolvedRole;
  readonly goal: string;
  readonly inputs?: JsonValue;
  readonly call: ModelToolCall;
  readonly context: RunContext;
}

/** Dependencies used to announce and execute a child run. */
export interface SubagentSupervisorOptions {
  readonly store: EventStore;
  readonly ids: IdGenerator;
  readonly scopes: RunScopeRegistry;
  readonly parentTools: ToolPort;
  readonly runChild: SubagentRunner;
  readonly parentSpanContext?: () => SpanContext | undefined;
}

/** Coordinates the durable announcement and execution of child runs. */
export class SubagentSupervisor {
  private readonly parentSpanContext: () => SpanContext | undefined;

  constructor(private readonly options: SubagentSupervisorOptions) {
    this.parentSpanContext =
      options.parentSpanContext ?? (() => trace.getSpan(otelContext.active())?.spanContext());
  }

  /**
   * Append the parent event before registering or invoking the child runner.
   *
   * @param role - Startup-resolved role for the child.
   * @param goal - Tokenized child goal from the spawn tool.
   * @param inputs - Optional tokenized JSON inputs.
   * @param call - Parent tool invocation.
   * @param context - Parent run context and durable event callback.
   * @returns The JSON-safe child result.
   */
  async spawn({ role, goal, inputs, call, context }: SubagentSpawnInput): Promise<SubagentResult> {
    const depth = (context.depth ?? 0) + 1;
    if (depth > role.maxDepth) {
      throw new SubagentError("subagent_depth_limit");
    }
    const recordSpawned = context.recordSubagentSpawned;
    const recordCompleted = context.recordSubagentCompleted;
    if (recordSpawned === undefined || recordCompleted === undefined) {
      throw new SubagentError("subagent_recorder_unavailable");
    }
    const parentSpanContext = this.parentSpanContext();
    if (parentSpanContext === undefined || !isSpanContextValid(parentSpanContext)) {
      throw new SubagentError("subagent_parent_span_missing");
    }

    const { childRunId, completionRecorded } = await this.resolveSpawn({
      runId: context.runId,
      parentCallId: call.callId,
      role,
      recordSpawned,
    });

    const scopeId = this.options.scopes.scopeOf(context.runId);
    this.options.scopes.register(childRunId, scopeId);
    const childTools = restrictToolPort(
      context.toolRegistry ?? this.options.parentTools,
      role.tools,
    );
    const childInput: JsonValue = {
      goal,
      ...(inputs === undefined ? {} : { inputs }),
    };
    let result: SubagentResult;
    try {
      result = await this.options.runChild({
        runId: childRunId,
        parentRunId: context.runId,
        parentCallId: call.callId,
        depth,
        scopeId,
        role,
        input: childInput,
        tools: childTools,
        signal: context.signal,
        parentSpanContext,
        rootSpanParent: trace.setSpanContext(ROOT_CONTEXT, parentSpanContext),
        rootSpanLinks: [{ context: parentSpanContext }],
      });
    } catch (error) {
      await this.recordFailedCompletion(childRunId, completionRecorded, recordCompleted);
      throw error;
    }
    if (result.status !== "suspended" && !completionRecorded) {
      const { inputTokens, outputTokens, costMicros } = result.usage;
      await recordCompleted({
        childRunId,
        outcome: result.status,
        inputTokens,
        outputTokens,
        ...(costMicros === undefined ? {} : { costMicros }),
      });
    }
    return result;
  }

  private async childrenOf(runId: Id): Promise<number> {
    let count = 0;
    for await (const event of this.options.store.read(runId)) {
      if (event.type === "subagent_spawned") {
        count += 1;
      }
    }
    return count;
  }

  private async resolveSpawn(options: {
    readonly runId: Id;
    readonly parentCallId: Id;
    readonly role: ResolvedRole;
    readonly recordSpawned: NonNullable<RunContext["recordSubagentSpawned"]>;
  }): Promise<{ readonly childRunId: Id; readonly completionRecorded: boolean }> {
    const existingSpawn = await this.findSpawned(options.runId, options.parentCallId);
    if (existingSpawn !== undefined) {
      return {
        childRunId: existingSpawn.childRunId,
        completionRecorded: await this.hasCompletion(options.runId, existingSpawn.childRunId),
      };
    }
    if ((await this.childrenOf(options.runId)) >= options.role.maxChildren) {
      throw new SubagentError("subagent_children_limit");
    }
    const childRunId = this.options.ids.next();
    await options.recordSpawned({
      childRunId,
      role: options.role.id,
      parentCallId: options.parentCallId,
    });
    return {
      childRunId,
      completionRecorded: await this.hasCompletion(options.runId, childRunId),
    };
  }

  private async recordFailedCompletion(
    childRunId: Id,
    completionRecorded: boolean,
    recordCompleted: NonNullable<RunContext["recordSubagentCompleted"]>,
  ): Promise<void> {
    if (completionRecorded) {
      return;
    }
    try {
      const usage = aggregateSubagentUsage(await this.childEvents(childRunId));
      await recordCompleted({
        childRunId,
        outcome: "failed",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        ...(usage.costMicros === undefined ? {} : { costMicros: usage.costMicros }),
      });
    } catch {
      trace
        .getSpan(otelContext.active())
        ?.setAttribute("harness.subagent.completion_record_failed", true);
    }
  }

  private async findSpawned(
    runId: Id,
    parentCallId: Id,
  ): Promise<{ readonly childRunId: Id } | undefined> {
    for await (const event of this.options.store.read(runId)) {
      if (event.type === "subagent_spawned" && event.parentCallId === parentCallId) {
        return { childRunId: event.childRunId };
      }
    }
    return undefined;
  }

  private async hasCompletion(runId: Id, childRunId: Id): Promise<boolean> {
    for await (const event of this.options.store.read(runId)) {
      if (event.type === "subagent_completed" && event.childRunId === childRunId) {
        return true;
      }
    }
    return false;
  }

  private async childEvents(runId: Id): Promise<Event[]> {
    const events: Event[] = [];
    for await (const event of this.options.store.read(runId)) {
      events.push(event);
    }
    return events;
  }
}

/** Restrict a child to the intersection of the parent registry and its role tools. */
export function restrictToolPort(parent: ToolPort, roleTools: readonly Code[]): ToolPort {
  const allowed = new Set(roleTools.filter((toolId) => parent.describe(toolId) !== undefined));
  return {
    ...(parent.getToolSpecs === undefined
      ? {}
      : {
          getToolSpecs: () =>
            (parent.getToolSpecs?.() ?? []).filter(({ toolId }) => allowed.has(toolId)),
        }),
    describe: (toolId, args) => (allowed.has(toolId) ? parent.describe(toolId, args) : undefined),
    prepare: (call, context) =>
      allowed.has(call.toolId)
        ? (parent.prepare?.(call, context) ?? Promise.resolve(call))
        : Promise.resolve(call),
    execute: (call, context) =>
      allowed.has(call.toolId)
        ? parent.execute(call, context)
        : Promise.resolve({ outcome: "error", errorCode: "unknown_tool", result: null }),
  };
}
