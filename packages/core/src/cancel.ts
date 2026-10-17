// SPDX-License-Identifier: Apache-2.0
import { HarnessError, type Event, type Id } from "@harness/schemas";
import type { EventStore } from "@harness/store";
import type { IdGenerator } from "./ports.js";
import { CorruptLogError, foldRunState, isTerminalRunState } from "./run-state.js";
import { LeaseLostError, RunRecorder, type Clock } from "./recorder.js";
import { RUN_SPAN } from "./spans.js";

/** Result of attempting to cancel a run. */
export type CancelRunResult = "cancelled" | "already_terminal";

class CancelConflictError extends HarnessError {
  override readonly code = "cancel_conflict";

  constructor() {
    super("The run changed repeatedly while cancellation was being requested.");
  }
}

interface CancelTreeOptions {
  readonly store: EventStore;
  readonly runId: Id;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly visited: Set<Id>;
  readonly visiting: Set<Id>;
}

async function readEvents(store: EventStore, runId: Id): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

/**
 * Cancels a run and its announced descendants before returning.
 *
 * @param store - Event store containing the run tree.
 * @param runId - Identifier of the root run to cancel.
 * @param clock - Clock used to timestamp cancellation events.
 * @param ids - Generator used for cancellation segment identifiers.
 * @returns Whether cancellation was appended or the run was already terminal.
 */
export async function cancelRun(
  store: EventStore,
  runId: Id,
  clock: Clock,
  ids: IdGenerator,
): Promise<CancelRunResult> {
  return cancelRunTree({
    store,
    runId,
    clock,
    ids,
    visited: new Set(),
    visiting: new Set(),
  });
}

async function cancelRunTree(options: {
  readonly store: EventStore;
  readonly runId: Id;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly visited: Set<Id>;
  readonly visiting: Set<Id>;
}): Promise<CancelRunResult> {
  const { store, runId, visited, visiting } = options;
  if (visiting.has(runId)) {
    throw new CorruptLogError();
  }
  if (visited.has(runId)) {
    return "already_terminal";
  }
  visiting.add(runId);
  const failures: unknown[] = [];
  const attemptedChildren = new Set<Id>();
  let result: CancelRunResult = "already_terminal";
  let stable = false;
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await sweepChildren(options, await readEvents(store, runId), attemptedChildren, failures);
        const cancellation = await cancelAfterSweep(options, attemptedChildren);
        if (cancellation !== undefined) {
          result = cancellation;
          stable = true;
          break;
        }
      } catch (error) {
        if (error instanceof CancelConflictError && attempt < 2) {
          continue;
        }
        failures.push(error);
        break;
      }
    }
  } finally {
    visiting.delete(runId);
  }
  visited.add(runId);
  if (!stable && failures.length === 0) {
    failures.push(new CancelConflictError());
  }
  if (failures.length > 0) {
    if (failures.length === 1 && failures[0] instanceof CancelConflictError) {
      throw failures[0];
    }
    throw new AggregateError(failures, "One or more runs could not be fully cancelled.");
  }
  return result;
}

async function sweepChildren(
  options: CancelTreeOptions,
  events: readonly Event[],
  attempted: Set<Id>,
  failures: unknown[],
): Promise<void> {
  for (const childRunId of openChildren(events)) {
    if (attempted.has(childRunId)) {
      continue;
    }
    attempted.add(childRunId);
    const childEvents = await readEvents(options.store, childRunId);
    if (childEvents.length === 0) {
      try {
        await appendCancelledChild({
          store: options.store,
          parentRunId: options.runId,
          childRunId,
          clock: options.clock,
          ids: options.ids,
        });
      } catch (error) {
        failures.push(error);
      }
      continue;
    }
    await cancelChildAndRecord(options, childRunId, failures);
  }
}

async function cancelChildAndRecord(
  options: CancelTreeOptions,
  childRunId: Id,
  failures: unknown[],
): Promise<void> {
  try {
    await cancelRunTree({ ...options, runId: childRunId });
  } catch (error) {
    failures.push(error);
  }
  try {
    await completeCancelledChild({
      store: options.store,
      parentRunId: options.runId,
      childRunId,
      clock: options.clock,
      ids: options.ids,
    });
  } catch (error) {
    failures.push(error);
  }
}

async function cancelAfterSweep(
  options: CancelTreeOptions,
  attemptedChildren: ReadonlySet<Id>,
): Promise<CancelRunResult | undefined> {
  const events = await readEvents(options.store, options.runId);
  const head = await options.store.head(options.runId);
  const state = foldRunState(events);
  if (isTerminalRunState(state)) {
    return "already_terminal";
  }
  if (
    state.nextSeq !== head ||
    Array.from(openChildren(events)).some((childRunId) => !attemptedChildren.has(childRunId))
  ) {
    return undefined;
  }
  return cancelSingleRun({
    store: options.store,
    runId: options.runId,
    state,
    expectedHead: head,
    clock: options.clock,
    ids: options.ids,
  });
}

function openChildren(events: readonly Event[]): Set<Id> {
  const completed = new Set(
    events.flatMap((event) => (event.type === "subagent_completed" ? [event.childRunId] : [])),
  );
  return new Set(
    events.flatMap((event) =>
      event.type === "subagent_spawned" && !completed.has(event.childRunId)
        ? [event.childRunId]
        : [],
    ),
  );
}

async function completeCancelledChild(options: {
  readonly store: EventStore;
  readonly parentRunId: Id;
  readonly childRunId: Id;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}): Promise<void> {
  const childEvents = await readEvents(options.store, options.childRunId);
  if (childEvents.length === 0) {
    await appendCancelledChild(options);
    return;
  }
  const childState = foldRunState(childEvents);
  if (!isTerminalRunState(childState)) {
    throw new CorruptLogError();
  }
  if (
    childState.status !== "completed" &&
    childState.status !== "failed" &&
    childState.status !== "cancelled"
  ) {
    throw new CorruptLogError();
  }
  await appendChildCompletion({
    ...options,
    outcome: childState.status,
    inputTokens: childState.usage.inputTokens,
    outputTokens: childState.usage.outputTokens,
    steps: childState.steps,
    costMicros: childState.usage.costMicros,
  });
}

async function appendCancelledChild(options: {
  readonly store: EventStore;
  readonly parentRunId: Id;
  readonly childRunId: Id;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}): Promise<void> {
  await appendChildCompletion({
    ...options,
    outcome: "cancelled",
    inputTokens: 0,
    outputTokens: 0,
    steps: 0,
    costMicros: 0,
  });
}

async function appendChildCompletion(options: {
  readonly store: EventStore;
  readonly parentRunId: Id;
  readonly childRunId: Id;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly outcome: "completed" | "failed" | "cancelled";
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly steps: number;
  readonly costMicros: number;
}): Promise<void> {
  const { store, parentRunId, childRunId, clock, ids } = options;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const events = await readEvents(store, parentRunId);
    if (
      events.some((event) => event.type === "subagent_completed" && event.childRunId === childRunId)
    ) {
      return;
    }
    const state = foldRunState(events);
    if (state.nextSeq !== (await store.head(parentRunId))) {
      continue;
    }
    const recorder = new RunRecorder(store, parentRunId, ids.next(), state.nextSeq, clock);
    try {
      await recorder.withStepSpan(RUN_SPAN, {}, () =>
        recorder.record({
          type: "subagent_completed",
          v: 1,
          childRunId,
          outcome: options.outcome,
          inputTokens: options.inputTokens,
          outputTokens: options.outputTokens,
          steps: options.steps,
          costMicros: options.costMicros,
        }),
      );
      return;
    } catch (error) {
      if (!(error instanceof LeaseLostError)) {
        throw error;
      }
    }
  }
  throw new CancelConflictError();
}

async function cancelSingleRun(options: {
  readonly store: EventStore;
  readonly runId: Id;
  readonly state: ReturnType<typeof foldRunState>;
  readonly expectedHead: number;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}): Promise<CancelRunResult> {
  const { store, runId, state, expectedHead, clock, ids } = options;
  if (isTerminalRunState(state)) {
    return "already_terminal";
  }
  const recorder = new RunRecorder(store, runId, ids.next(), expectedHead, clock);
  try {
    await recorder.withStepSpan(RUN_SPAN, {}, () =>
      recorder.record({
        type: "run_status_changed",
        v: 1,
        from: state.status,
        to: "cancelled",
        reason: "cancel_requested",
      }),
    );
    return "cancelled";
  } catch (error) {
    if (error instanceof LeaseLostError) {
      throw new CancelConflictError();
    }
    throw error;
  }
}
