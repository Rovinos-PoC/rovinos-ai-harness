// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type Id } from "@harness/schemas";
import { PiiToolPort } from "@harness/pii";
import { OffloadingToolPort } from "@harness/context";
import { forceFlushTelemetry, sentinelTripQueue } from "@harness/telemetry";
import { closeRuntimeResources, markTerminalBestEffort } from "./runtime-lifecycle.js";
import {
  composeAbortSignals,
  inspectCancellationTail,
  watchCancellation,
} from "./runtime-cancellation.js";
import { type EventStore } from "@harness/store";
import { cancelRun } from "./cancel.js";
import { resolveApproval as resolveApprovalEvent } from "./approvals.js";
import type { ToolPort } from "./ports.js";
import { LeaseLostError, type Clock } from "./recorder.js";
import { resumeRun } from "./resume.js";
import { installShutdownHandler, type ShutdownProcessLike } from "./shutdown.js";
import type { RunLoopResult } from "./loop.js";
import type { RoleRegistry } from "./roles.js";
import { foldRunState } from "./run-state.js";
import type { RunScopeRegistry } from "./subagent/scope.js";
import { createSubagentTool } from "./subagent/runtime.js";
import {
  createRuntimeContinuation,
  readChildBudgetAllocation,
  readStoredGoal,
  startRun,
  type RunControl,
} from "./runtime-runs.js";
import { setupRuntime } from "./runtime-setup.js";
import { createRuntimeAppCallbacks, hostedAppContentTokenizer } from "./runtime-apps.js";
import { appendFinalRunTrips, flushAndDrainTrips } from "./runtime-sentinel-trips.js";
import type {
  Runtime,
  RuntimeComposition,
  RuntimeConfig,
  RuntimeResumeOptions,
  RuntimeOverrides,
} from "./runtime-config.js";
export type {
  Runtime,
  RuntimeConfig,
  RuntimeOverrides,
  RuntimeResumeOptions,
} from "./runtime-config.js";

class RunInputMissingError extends HarnessError {
  readonly code = "run_input_missing";

  constructor() {
    super("The run input is unavailable.");
  }
}

class ApprovalEditUnavailableError extends HarnessError {
  readonly code = "approval_edit_unavailable";

  constructor() {
    super("approval_edit_unavailable");
  }
}

const defaultProcessLike: ShutdownProcessLike = {
  on: (signal, listener) => process.on(signal, listener),
  removeListener: (signal, listener) => process.removeListener(signal, listener),
  get exitCode(): number | undefined {
    return typeof process.exitCode === "number" ? process.exitCode : undefined;
  },
  set exitCode(code) {
    if (code !== undefined) {
      process.exitCode = code;
    }
  },
  // The shutdown grace deadline must force termination if the active operation does not flush.
  // eslint-disable-next-line n/no-process-exit -- shutdown deadline is the final safety bound
  exit: (code) => process.exit(code),
};

async function readEvents(store: EventStore, runId: Id, fromSeq = 0): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId, { fromSeq })) {
    events.push(event);
  }
  return events;
}

async function cancelledResult(
  store: EventStore,
  runId: Id,
  firstNewSeq: number,
): Promise<RunLoopResult | undefined> {
  const events = await readEvents(store, runId);
  const state = foldRunState(events);
  if (state.status !== "cancelled") {
    return undefined;
  }
  return {
    status: state.status,
    approvalIds: Array.from(state.pendingApprovals.keys()),
    state,
    events: events.filter((event) => event.seq >= firstNewSeq),
  };
}

interface RunControlOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly firstNewSeq: number;
  readonly clock: Clock;
  readonly flushTelemetry?: RuntimeOverrides["flushTelemetry"];
  readonly processLike: ShutdownProcessLike;
  readonly graceMs: number;
  readonly operation: (signal: AbortSignal) => Promise<RunLoopResult>;
}

async function withRunControl(options: RunControlOptions): Promise<RunLoopResult> {
  sentinelTripQueue.beginRun(options.runId);
  const controller = new AbortController();
  const stopWatcher = new AbortController();
  const cursor = { nextSeq: options.firstNewSeq };
  const cancellation = { observed: false };
  let running: Promise<RunLoopResult> | undefined;
  let result: RunLoopResult | undefined;
  let tripsFinalized = false;
  const uninstall = installShutdownHandler({
    processLike: options.processLike,
    controller,
    graceMs: options.graceMs,
    onTimeout: async () => {
      await running;
    },
  });
  const watcher = watchCancellation({
    store: options.store,
    runId: options.runId,
    firstSeq: options.firstNewSeq,
    controller,
    stopSignal: stopWatcher.signal,
    onCursor: (nextSeq) => {
      cursor.nextSeq = nextSeq;
    },
    onCancellation: () => {
      cancellation.observed = true;
    },
  });

  try {
    running = options.operation(controller.signal);
    try {
      result = await running;
    } catch (error) {
      if (error instanceof LeaseLostError) {
        await inspectCancellationTail({
          store: options.store,
          runId: options.runId,
          fromSeq: cursor.nextSeq,
          controller,
          onCursor: (nextSeq) => {
            cursor.nextSeq = nextSeq;
          },
          onCancellation: () => {
            cancellation.observed = true;
          },
        });
      }
      if (cancellation.observed) {
        const cancelled = await cancelledResult(options.store, options.runId, options.firstNewSeq);
        if (cancelled !== undefined) {
          result = cancelled;
        } else {
          throw error;
        }
      } else {
        throw error;
      }
    }
    if (cancellation.observed) {
      result = (await cancelledResult(options.store, options.runId, options.firstNewSeq)) ?? result;
    }
    result = await appendFinalRunTrips(result, options);
    tripsFinalized = true;
    return result;
  } finally {
    stopWatcher.abort();
    uninstall();
    await watcher;
    if (running !== undefined && !tripsFinalized) {
      await flushAndDrainTrips(options);
    }
  }
}

function createTerminalAwareRunControl({
  config,
  overrides,
  clock,
  store,
  vault,
}: RuntimeComposition): RunControl {
  const flushTelemetry = overrides.flushTelemetry ?? forceFlushTelemetry;
  return async (runId, operation, firstNewSeq = 0) => {
    const result = await withRunControl({
      store,
      runId,
      firstNewSeq,
      clock,
      flushTelemetry,
      processLike: overrides.processLike ?? defaultProcessLike,
      graceMs: config.run.shutdownGraceMs,
      operation,
    });
    if (
      result.status === "completed" ||
      result.status === "failed" ||
      result.status === "cancelled"
    ) {
      await markTerminalBestEffort(vault, runId, clock.now());
    }
    return result;
  };
}

function createRuntimeRunMethods(
  options: RuntimeComposition,
  tool: ToolPort,
  runWithControl: RunControl,
): Pick<Runtime, "run" | "start"> {
  return {
    run: (goal, runOptions) => startRun(options, tool, goal, { runWithControl, ...runOptions }),
    start: (goal, runOptions) => {
      const runId = runOptions?.runId ?? options.ids.next();
      let resolveStarted: () => void = () => undefined;
      let rejectStarted: (reason?: unknown) => void = () => undefined;
      const started = new Promise<void>((resolve, reject) => {
        resolveStarted = resolve;
        rejectStarted = reject;
      });
      void started.catch(() => undefined);
      const completion = startRun(options, tool, goal, {
        runWithControl,
        ...runOptions,
        runId,
        onStarted: resolveStarted,
      });
      void completion.catch(rejectStarted);
      return {
        runId,
        started,
        completion,
      };
    },
  };
}

function createRuntimeToolPort(
  options: RuntimeComposition & {
    readonly roles: RoleRegistry;
    readonly scopes: RunScopeRegistry;
  },
): ToolPort {
  const subagentTool = createSubagentTool({
    config: options.config,
    clock: options.clock,
    ids: options.ids,
    store: options.store,
    model: options.model,
    parentTool: options.tool,
    policy: options.policy,
    policyVersion: options.policyVersion,
    workspaceSnapshotter: options.workspaceSnapshotter,
    roles: options.roles,
    scopes: options.scopes,
    ...(options.pii === undefined ? {} : { resolver: options.pii.resolver }),
  });
  const piiTool =
    options.pii === undefined
      ? subagentTool
      : new PiiToolPort(subagentTool, {
          tokenizer: options.pii.tokenizer,
          config: options.pii.config,
          resolver: options.pii.resolver,
        });
  return options.overrides.workspace === undefined
    ? piiTool
    : new OffloadingToolPort(piiTool, options.overrides.workspace, {}, options.ids);
}

function composeRuntime(
  options: RuntimeComposition & {
    readonly roles: RoleRegistry;
    readonly scopes: RunScopeRegistry;
  },
): Runtime {
  const { config, clock, ids, store, keys, vault, vaultResolver, scopes } = options;
  const tool = createRuntimeToolPort(options);
  const runWithControl = createTerminalAwareRunControl(options);
  const resume = createRuntimeResume(options, tool, runWithControl);
  const pii = options.pii;
  const appCallbacks = createRuntimeAppCallbacks({
    store,
    clock,
    ...(pii === undefined ? {} : { tokenize: hostedAppContentTokenizer(pii.tokenizer) }),
  });
  return {
    store,
    vault: vaultResolver,
    keys,
    sandboxBackend: options.sandboxBackend,
    clock,
    ids,
    ...createRuntimeRunMethods(options, tool, runWithControl),
    continueRun: createRuntimeContinuation(options, tool, scopes, runWithControl),
    resume,
    cancel: async (runId) => {
      const result = await cancelRun(store, runId, clock, ids);
      if (result === "cancelled") {
        await markTerminalBestEffort(vault, runId, clock.now());
      }
      return result;
    },
    ...appCallbacks,
    resolveApproval: (runId, approvalId, decision, resolveOptions) => {
      if (
        decision === "edit" &&
        options.overrides.tool === undefined &&
        (config.servers?.length ?? 0) === 0
      ) {
        throw new ApprovalEditUnavailableError();
      }
      return resolveApprovalEvent(
        store,
        runId,
        approvalId,
        decision,
        resolveOptions?.edits,
        clock,
        tool,
        resolveOptions?.metadata,
      );
    },
    close: () =>
      closeRuntimeResources({
        store,
        ...(options.closeToolPort === undefined ? {} : { closeToolPort: options.closeToolPort }),
        vault,
        keys,
        sandboxBackend: options.sandboxBackend,
        flushTelemetry: options.overrides.flushTelemetry ?? forceFlushTelemetry,
      }),
  };
}

function createRuntimeResume(
  options: RuntimeComposition & { readonly scopes: RunScopeRegistry },
  tool: ToolPort,
  runWithControl: RunControl,
): Runtime["resume"] {
  const { config, clock, ids, store, model, context, policy, scopes } = options;
  return async (runId, resumeOptions: RuntimeResumeOptions = {}) => {
    const firstNewSeq = await store.head(runId);
    const childAllocation = await readChildBudgetAllocation(store, runId);
    return runWithControl(
      runId,
      async (signal) => {
        const goal = await readStoredGoal(store, runId);
        if (goal === undefined) {
          throw new RunInputMissingError();
        }
        const composed = composeAbortSignals([
          signal,
          ...(resumeOptions.signal === undefined ? [] : [resumeOptions.signal]),
        ]);
        try {
          return await resumeRun({
            store,
            runId,
            clock,
            ids,
            goal,
            model,
            tool,
            policy,
            context,
            signal: composed.signal,
            scopes,
            budgets: childAllocation?.budgets ?? config.run.budgets,
            ...(childAllocation === undefined ? {} : { deadlineTs: childAllocation.deadlineTs }),
            checkpointEveryEvents: config.run.checkpointEveryEvents,
            ...(config.store?.snapshotKeep === undefined
              ? {}
              : { snapshotKeep: config.store.snapshotKeep }),
            resumePolicy: config.run.resume.onNonIdempotent,
            ...(config.sandbox?.restoreOnResume === undefined
              ? {}
              : { restoreOnResume: config.sandbox.restoreOnResume }),
            workspaceSnapshotter: options.workspaceSnapshotter,
            ...(resumeOptions.onClaimed === undefined
              ? {}
              : { onClaimed: resumeOptions.onClaimed }),
          });
        } finally {
          composed.dispose();
        }
      },
      firstNewSeq,
    );
  };
}

/**
 * Builds a runtime from validated config with injectable ports.
 * Supply tools in decorator order `Offloading(Pii(Policy(Tools)))`; the loop
 * evaluates policy after preparation so it only sees tokenized arguments.
 * Binary results use the outer offloader and are never returned as previews.
 *
 * @param config - Validated run and model configuration.
 * @param overrides - Optional stores, ports, and deterministic test dependencies.
 * @returns Shared run, resume, cancellation, and store operations.
 */
export async function createRuntime(
  config: RuntimeConfig,
  overrides: RuntimeOverrides = {},
): Promise<Runtime> {
  return composeRuntime(await setupRuntime(config, overrides));
}
