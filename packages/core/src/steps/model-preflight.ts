// SPDX-License-Identifier: Apache-2.0
import type { Event, RunConfig } from "@harness/schemas";
import { accountForOpenChildren, type BudgetTracker, type BudgetViolation } from "../budgets.js";
import type { Checkpointer } from "../checkpoint.js";
import type { RunRecorder } from "../recorder.js";
import { foldRunState } from "../run-state.js";

/** Budget and deadline result calculated before a model request or compaction call. */
export interface ModelPreflightResult {
  readonly deadlineTs: number;
  readonly event?: Event;
}

/** Records a budget failure and checkpoints when the configured cadence requires one. */
export async function recordBudgetFailureAndCheckpoint(
  recorder: RunRecorder,
  events: Event[],
  violation: BudgetViolation,
  checkpointer: Checkpointer,
): Promise<Event> {
  events.push(...(await recorder.drainTrips()));
  const recorded = await recorder.recordBatch([
    {
      type: "budget_exceeded",
      v: 1,
      budget: violation.budget,
      limit: violation.limit,
      observed: violation.observed,
    },
    {
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "failed",
      reason: "budget_exceeded",
    },
  ]);
  events.push(...recorded);
  events.push(...(await recorder.drainTrips()));
  const failed = recorded.at(-1);
  if (failed === undefined) {
    throw new Error("Expected budget failure events.");
  }
  const checkpoint = await checkpointer.maybeCheckpoint(foldRunState(events));
  if (checkpoint !== undefined) {
    events.push(checkpoint);
  }
  return failed;
}

/** Checks the next model step before any preceding paid summarization request. */
export async function preflightModelBudget(options: {
  readonly budgetTracker: BudgetTracker;
  readonly checkpointer: Checkpointer;
  readonly events: Event[];
  readonly budgets: RunConfig["budgets"];
  readonly now: number;
  readonly recorder: RunRecorder;
}): Promise<ModelPreflightResult> {
  const state = foldRunState(options.events);
  const deadlineTs = options.budgetTracker.deadlineTs(state);
  const accounted = accountForOpenChildren(state, options.events, options.budgets);
  const budget = options.budgetTracker.check(
    { ...accounted, steps: accounted.steps + 1 },
    options.now,
  );
  if (budget.ok) {
    return { deadlineTs };
  }
  const event = await recordBudgetFailureAndCheckpoint(
    options.recorder,
    options.events,
    budget,
    options.checkpointer,
  );
  return { deadlineTs, event };
}
