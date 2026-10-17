// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type Id, type RunConfig } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { RunContext } from "../ports.js";
import { BudgetTracker } from "../budgets.js";
import { foldRunState } from "../run-state.js";
import type { ResolvedRole } from "../roles.js";
import {
  deriveChildBudgetAllocation,
  type ChildBudgetAllocation,
  type ChildBudgetReservation,
} from "./budgets.js";

const spawnLocks = new WeakMap<EventStore, Map<Id, Promise<void>>>();
const pendingSpawns = new WeakMap<EventStore, Map<Id, number>>();

interface ResolveChildAllocationOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly parentCallId: Id;
  readonly role: ResolvedRole;
  readonly runConfig: RunConfig;
  readonly now: number;
  readonly recordSpawned: NonNullable<RunContext["recordSubagentSpawned"]>;
  readonly childRunId: Id;
  readonly concurrentSpawns: number;
}

interface ResolvedChildAllocation {
  readonly childRunId: Id;
  readonly allocation: ChildBudgetAllocation;
  readonly completion?: Extract<Event, { type: "subagent_completed" }>;
}

/** Serializes child-limit checks and announcements for one in-process event store. */
export async function withSpawnLock<T>(
  store: EventStore,
  runId: Id,
  operation: (concurrentSpawns: number) => Promise<T>,
): Promise<T> {
  let runs = spawnLocks.get(store);
  if (runs === undefined) {
    runs = new Map();
    spawnLocks.set(store, runs);
  }
  const previous = runs.get(runId) ?? Promise.resolve();
  let pending = pendingSpawns.get(store);
  if (pending === undefined) {
    pending = new Map();
    pendingSpawns.set(store, pending);
  }
  const concurrentSpawns = (pending.get(runId) ?? 0) + 1;
  pending.set(runId, concurrentSpawns);
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  runs.set(runId, current);
  await previous;
  try {
    return await operation(pending.get(runId) ?? concurrentSpawns);
  } finally {
    release();
    const remainingSpawns = (pending.get(runId) ?? 1) - 1;
    if (remainingSpawns === 0) {
      pending.delete(runId);
    } else {
      pending.set(runId, remainingSpawns);
    }
    if (runs.get(runId) === current) {
      runs.delete(runId);
    }
  }
}

/** Resolves an existing or newly reserved child allocation from durable events. */
export async function resolveChildAllocation(
  options: ResolveChildAllocationOptions,
): Promise<ResolvedChildAllocation> {
  const events = await readEvents(options.store, options.runId);
  const spawned = events.filter((event) => event.type === "subagent_spawned");
  const existing = events.find(
    (event) => event.type === "subagent_spawned" && event.parentCallId === options.parentCallId,
  );
  const recorded = recordedAllocation(events, existing, options.runConfig.budgets);
  if (recorded !== undefined) {
    return recorded;
  }
  if (existing === undefined) {
    enforceSpawnLimits(options, events, spawned);
  }
  const allocation = await deriveAllocation(options, events, spawned, existing);
  if (existing?.type === "subagent_spawned") {
    return { childRunId: existing.childRunId, allocation };
  }

  const childRunId = options.childRunId;
  await options.recordSpawned({
    childRunId,
    role: options.role.id,
    parentCallId: options.parentCallId,
    budgetLimits: allocation.budgets,
    budgetDeadlineTs: allocation.deadlineTs,
  });
  return { childRunId, allocation };
}

function recordedAllocation(
  events: readonly Event[],
  existing: Event | undefined,
  rootBudgets: RunConfig["budgets"],
): ResolvedChildAllocation | undefined {
  if (existing?.type !== "subagent_spawned") {
    return undefined;
  }
  const completion = events.find(
    (event) => event.type === "subagent_completed" && event.childRunId === existing.childRunId,
  );
  if (completion?.type === "subagent_completed") {
    return {
      childRunId: existing.childRunId,
      allocation: {
        budgets: existing.budgetLimits ?? rootBudgets,
        deadlineTs: existing.budgetDeadlineTs ?? Number.POSITIVE_INFINITY,
      },
      completion,
    };
  }
  if (existing.budgetLimits !== undefined && existing.budgetDeadlineTs !== undefined) {
    return {
      childRunId: existing.childRunId,
      allocation: {
        budgets: existing.budgetLimits,
        deadlineTs: existing.budgetDeadlineTs,
      },
    };
  }
  return undefined;
}

function enforceSpawnLimits(
  options: ResolveChildAllocationOptions,
  events: readonly Event[],
  spawned: readonly Extract<Event, { type: "subagent_spawned" }>[],
): void {
  const completedIds = new Set(
    events.flatMap((event) => (event.type === "subagent_completed" ? [event.childRunId] : [])),
  );
  const activeCount = spawned.filter((event) => !completedIds.has(event.childRunId)).length;
  if (
    spawned.length >= options.runConfig.subagents.maxChildrenPerRun ||
    activeCount >= options.runConfig.subagents.maxConcurrentChildren
  ) {
    throw new SubagentLimitError();
  }
  if (spawned.length >= options.role.maxChildren) {
    throw new SubagentChildrenLimitError();
  }
}

async function deriveAllocation(
  options: ResolveChildAllocationOptions,
  events: readonly Event[],
  spawned: readonly Extract<Event, { type: "subagent_spawned" }>[],
  existing: Event | undefined,
): Promise<ChildBudgetAllocation> {
  const parentState = foldRunState(events);
  const parent = await resolveParentAllocation(
    options.store,
    options.runId,
    events,
    options.runConfig.budgets,
  );
  const completedIds = new Set(
    events.flatMap((event) => (event.type === "subagent_completed" ? [event.childRunId] : [])),
  );
  const openChildren = spawned.filter(
    (event) =>
      !completedIds.has(event.childRunId) &&
      (existing?.type !== "subagent_spawned" || event.childRunId !== existing.childRunId),
  );
  const reservation = await childReservations(
    options.store,
    openChildren,
    parent.budgets,
    parentState,
  );
  const activeCount = spawned.filter((event) => !completedIds.has(event.childRunId)).length;
  return deriveChildBudgetAllocation(parentState, parent.budgets, options.role.budgets, {
    now: options.now,
    parentDeadlineTs: parent.deadlineTs,
    reserved: reservation,
    availableSlots: availableSlots(options, activeCount, spawned.length, existing),
  });
}

function availableSlots(
  options: ResolveChildAllocationOptions,
  activeCount: number,
  totalChildren: number,
  existing: Event | undefined,
): number {
  if (existing?.type === "subagent_spawned") {
    return Math.max(1, options.runConfig.subagents.maxConcurrentChildren - activeCount + 1);
  }
  return Math.min(
    options.concurrentSpawns,
    options.runConfig.subagents.maxChildrenPerRun - totalChildren,
    options.role.maxChildren - totalChildren,
    options.runConfig.subagents.maxConcurrentChildren - activeCount,
  );
}

/** Error raised when a configured child count or concurrency ceiling is reached. */
export class SubagentLimitError extends HarnessError {
  override readonly code = "subagent_limit";

  constructor() {
    super("The parent has reached its subagent limit.");
  }
}

/** Error raised when the selected role has reached its child-count ceiling. */
export class SubagentChildrenLimitError extends HarnessError {
  override readonly code = "subagent_children_limit";

  constructor() {
    super("The selected role has reached its child limit.");
  }
}

async function childReservations(
  store: EventStore,
  events: readonly Extract<Event, { type: "subagent_spawned" }>[],
  budgets: RunConfig["budgets"],
  state: ReturnType<typeof foldRunState>,
): Promise<ChildBudgetReservation> {
  let steps = 0;
  let costMicros = 0;
  for (const event of events) {
    if (event.budgetLimits === undefined) {
      const childEvents = await readEvents(store, event.childRunId);
      const childState = childEvents.length === 0 ? undefined : foldRunState(childEvents);
      if (childState !== undefined) {
        steps += childState.steps;
        costMicros += childState.usage.costMicros;
      }
      if (budgets.maxCostUsd !== undefined) {
        costMicros = Math.max(costMicros, budgets.maxCostUsd * 1_000_000 - state.usage.costMicros);
      }
      steps = Math.max(steps, budgets.maxSteps - state.steps);
      continue;
    }
    steps += event.budgetLimits.maxSteps;
    if (budgets.maxCostUsd !== undefined && event.budgetLimits.maxCostUsd !== undefined) {
      costMicros += Math.floor(event.budgetLimits.maxCostUsd * 1_000_000);
    }
  }
  return { steps, costMicros };
}

async function resolveParentAllocation(
  store: EventStore,
  runId: Id,
  events: readonly Event[],
  rootBudgets: RunConfig["budgets"],
): Promise<ChildBudgetAllocation> {
  const created = events.find((event) => event.type === "run_created");
  const state = foldRunState(events);
  if (created?.type !== "run_created" || created.parentRunId === undefined) {
    return {
      budgets: rootBudgets,
      deadlineTs: new BudgetTracker(rootBudgets).deadlineTs(state),
    };
  }
  const parentEvents = await readEvents(store, created.parentRunId);
  const spawn = parentEvents.find(
    (event) => event.type === "subagent_spawned" && event.childRunId === runId,
  );
  if (spawn?.type === "subagent_spawned" && spawn.budgetLimits !== undefined) {
    return {
      budgets: spawn.budgetLimits,
      deadlineTs: spawn.budgetDeadlineTs ?? new BudgetTracker(spawn.budgetLimits).deadlineTs(state),
    };
  }
  return {
    budgets: rootBudgets,
    deadlineTs: new BudgetTracker(rootBudgets).deadlineTs(state),
  };
}

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}
