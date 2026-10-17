// SPDX-License-Identifier: Apache-2.0
import { createStrategyRegistry, HeuristicTokenCounter } from "@harness/context";
import { Code, type Event, type Id, type Message } from "@harness/schemas";
import { validateWithTokens } from "@harness/pii";
import type { AuditingVaultResolver } from "@harness/vault";
import type { ValueTransform } from "@harness/models";
import type { EventStore } from "@harness/store";
import type { WorkspaceSnapshotPort } from "@harness/sandbox";
import { parseRuntimeModelsConfig, type RuntimeConfig } from "../runtime-config.js";
import { RunRecorder, type Clock } from "../recorder.js";
import { configHash } from "../runtime-ids.js";
import { runLoop } from "../loop.js";
import type { ContextPort, IdGenerator, ModelPort, PolicyPort, ToolPort } from "../ports.js";
import { RoleRegistry, RoleRegistryError } from "../roles.js";
import type { ResolvedRole } from "../roles.js";
import { StrategyContextPort } from "../context/context-port.js";
import { AgentSpawnTool } from "./spawn-tool.js";
import type { RunScopeRegistry } from "./scope.js";
import { SubagentSupervisor, type SubagentRunRequest } from "./supervisor.js";
import { finalizeChild } from "./result.js";
import { foldRunState, isTerminalRunState } from "../run-state.js";

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

function childStartupGuard(
  store: EventStore,
  request: SubagentRunRequest,
): (events: Event[]) => Promise<boolean> {
  return async (events) => {
    const childEvents = await readEvents(store, request.runId);
    events.push(...childEvents.slice(events.length));
    if (isTerminalRunState(foldRunState(childEvents))) {
      return false;
    }
    const parentEvents = await readEvents(store, request.parentRunId);
    const completed = parentEvents.some(
      (event) => event.type === "subagent_completed" && event.childRunId === request.runId,
    );
    return (
      !completed &&
      !isTerminalRunState(foldRunState(parentEvents)) &&
      (!request.signal.aborted || request.signal.reason === "shutdown")
    );
  };
}

function childRunOptions(
  config: RuntimeConfig,
  workspaceSnapshotter: WorkspaceSnapshotPort | undefined,
): {
  readonly configHash: string;
  readonly snapshotKeep?: number;
  readonly workspaceSnapshotter?: WorkspaceSnapshotPort;
} {
  return {
    configHash: configHash(config),
    ...(config.store?.snapshotKeep === undefined
      ? {}
      : { snapshotKeep: config.store.snapshotKeep }),
    ...(workspaceSnapshotter === undefined ? {} : { workspaceSnapshotter }),
  };
}

/** Resolves configured roles against the registered tools and built-in spawn tool. */
export async function resolveRuntimeRoles(
  config: RuntimeConfig,
  roleConfigDirectory: string,
  tool: ToolPort,
  onWarning: (code: Code) => void,
): Promise<RoleRegistry> {
  const contextStrategies = new Set(
    Array.from(
      createStrategyRegistry({ provider: "default", model: "default" }).keys(),
      (strategyId) => Code.parse(strategyId),
    ),
  );
  return RoleRegistry.create({
    ...(config.roles === undefined ? {} : { roles: config.roles }),
    models: parseRuntimeModelsConfig(config.models),
    registeredTools: [
      ...(tool.getToolSpecs?.().map((spec) => spec.toolId) ?? []),
      Code.parse("agent.spawn"),
    ],
    contextStrategies,
    configDirectory: roleConfigDirectory,
    onWarning: (warning) => {
      onWarning(warning.code);
    },
  });
}

/** Builds the context port configured for one subagent role. */
export function contextForRole(role: ResolvedRole): ContextPort {
  const strategy = createStrategyRegistry({ provider: "default", model: "default" }).get(
    role.contextStrategy ?? "naive",
  );
  if (strategy === undefined) {
    throw new RoleRegistryError("role_context_strategy_unknown");
  }
  const strategyContext = new StrategyContextPort(strategy, {
    budget: { maxTokens: Number.MAX_SAFE_INTEGER, reserveOutputTokens: 0 },
    model: { provider: "default", model: "default" },
    counter: new HeuristicTokenCounter(),
  });
  if (role.systemPrompt === undefined) {
    return strategyContext;
  }
  const systemMessage: Message = {
    role: "system",
    parts: [{ type: "text", text: role.systemPrompt }],
  };
  return {
    build: async (events, previousEventLogs) => {
      const built = await strategyContext.build(events, previousEventLogs);
      const messages = [systemMessage, ...built.messages];
      return {
        messages,
        metadata: {
          ...built.metadata,
          estimatedTokens: strategyContext.estimate(messages),
          messageCount: messages.length,
        },
      };
    },
    estimate: (messages) => strategyContext.estimate(messages),
    observeModelResponse: (model, estimated, actual) => {
      strategyContext.observeModelResponse(model, estimated, actual);
    },
    snapshot: () => strategyContext.snapshot(),
    restore: (snapshot, events) => strategyContext.restore(snapshot, events),
  };
}

function childValueTransform(
  runId: SubagentRunRequest["runId"],
  resolver: AuditingVaultResolver,
): ValueTransform {
  return async (schema, value) => {
    const validated = await validateWithTokens(schema, value, { runId, resolver });
    return validated.ok
      ? { ok: true, tokenized: validated.tokenized }
      : { ok: false, issues: validated.issues };
  };
}

/** Creates the runtime's spawn decorator and production child-run callback. */
export function createSubagentTool(options: {
  readonly config: RuntimeConfig;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly store: EventStore;
  readonly model: ModelPort;
  readonly parentTool: ToolPort;
  readonly policy: PolicyPort;
  readonly policyVersion: PolicyPort["version"];
  readonly workspaceSnapshotter?: WorkspaceSnapshotPort;
  readonly roles: RoleRegistry;
  readonly scopes: RunScopeRegistry;
  readonly resolver?: AuditingVaultResolver;
}): ToolPort {
  const supervisor = new SubagentSupervisor({
    store: options.store,
    ids: options.ids,
    clock: options.clock,
    runConfig: options.config.run,
    scopes: options.scopes,
    parentTools: options.parentTool,
    runChild: async (request: SubagentRunRequest) => {
      const recorder = new RunRecorder(
        options.store,
        request.runId,
        options.ids.next(),
        0,
        options.clock,
      );
      const result = await runLoop({
        recorder,
        clock: options.clock,
        model: options.model,
        tool: request.tools,
        policy: options.policy,
        context: contextForRole(request.role),
        ids: options.ids,
        goal: request.input,
        signal: request.signal,
        shouldContinue: childStartupGuard(options.store, request),
        budgets: request.budgets,
        deadlineTs: request.budgetDeadlineTs,
        checkpointEveryEvents: options.config.run.checkpointEveryEvents,
        ...childRunOptions(options.config, options.workspaceSnapshotter),
        policyVersion: options.policyVersion,
        role: request.role.route ?? request.role.id,
        ...(request.role.resultSchema === undefined
          ? {}
          : {
              finalOutputSchema: request.role.resultSchema,
              ...(options.resolver === undefined
                ? {}
                : {
                    valueTransform: childValueTransform(request.runId, options.resolver),
                  }),
            }),
        parentRunId: request.parentRunId,
        parentCallId: request.parentCallId,
        scopeId: request.scopeId,
        depth: request.depth,
        rootSpanParent: request.rootSpanParent,
        rootSpanLinks: request.rootSpanLinks,
      });
      if (result.status === "pending" || result.status === "running") {
        throw new Error("Child run did not reach a final state.");
      }
      return finalizeChild({
        childRunId: request.runId,
        status: result.status,
        events: result.events,
        hasResultSchema: request.role.resultSchema !== undefined,
      });
    },
  });
  return new AgentSpawnTool(options.parentTool, options.roles, supervisor);
}
