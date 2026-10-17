// SPDX-License-Identifier: Apache-2.0
// Optional child step totals preserve old logs while keeping inherited budgets cumulative.
import { HarnessError, type RunConfig, type RoleBudgets } from "@harness/schemas";
import { BudgetTracker } from "../budgets.js";
import type { RunState } from "../run-state.js";

/** Persisted limits assigned to one child, including its absolute deadline. */
export interface ChildBudgetAllocation {
  readonly budgets: RunConfig["budgets"];
  readonly deadlineTs: number;
}

/** Usage already committed by unfinished children against their parent's allowance. */
export interface ChildBudgetReservation {
  readonly steps: number;
  readonly costMicros: number;
}

/** Inputs needed to derive one durable child allocation. */
export interface ChildBudgetOptions {
  readonly now: number;
  readonly parentDeadlineTs?: number;
  readonly reserved?: ChildBudgetReservation;
  readonly availableSlots?: number;
}

/** A child cannot start when its parent has exhausted a required budget. */
export class ChildBudgetExceededError extends HarnessError {
  override readonly code = "budget_exceeded";

  constructor() {
    super("The parent has no remaining budget for a child run.");
  }
}

/**
 * Derives child limits from the parent's remaining allowance and the selected role's limits.
 *
 * @param parentState - Folded parent state, including completed child usage.
 * @param parentBudgets - Validated budgets for the parent run.
 * @param roleBudgets - Optional tighter limits configured for the selected role.
 * @param now - Current epoch time in milliseconds.
 * @returns Child limits that are no larger than either applicable limit.
 * @throws ChildBudgetExceededError when a required parent budget is exhausted.
 */
export function deriveChildBudgets(
  parentState: RunState,
  parentBudgets: RunConfig["budgets"],
  roleBudgets: RoleBudgets | undefined,
  now: number,
): RunConfig["budgets"] {
  return deriveChildBudgetAllocation(parentState, parentBudgets, roleBudgets, { now }).budgets;
}

/**
 * Derives a reserved child allocation without restarting the parent's deadline.
 *
 * @param parentState - Folded parent state, including completed-child usage.
 * @param parentBudgets - Effective limits assigned to this parent.
 * @param roleBudgets - Optional tighter limits configured for the selected role.
 * @param options - Absolute deadline and allowances already reserved by open children.
 * @returns Child limits and the absolute deadline to persist for its execution.
 * @throws ChildBudgetExceededError when no usable parent budget remains.
 */
export function deriveChildBudgetAllocation(
  parentState: RunState,
  parentBudgets: RunConfig["budgets"],
  roleBudgets: RoleBudgets | undefined,
  options: ChildBudgetOptions,
): ChildBudgetAllocation {
  const { now } = options;
  const reserved = options.reserved ?? { steps: 0, costMicros: 0 };
  const availableSlots = options.availableSlots ?? 1;
  if (!Number.isSafeInteger(availableSlots) || availableSlots < 1) {
    throw new ChildBudgetExceededError();
  }
  const parentRemainingSteps = parentBudgets.maxSteps - parentState.steps - reserved.steps;
  if (parentRemainingSteps < 1) {
    throw new ChildBudgetExceededError();
  }
  const maxSteps = Math.min(
    roleBudgets?.maxSteps ?? Number.POSITIVE_INFINITY,
    Math.floor(parentRemainingSteps / availableSlots),
  );
  if (maxSteps < 1) {
    throw new ChildBudgetExceededError();
  }
  const maxCostUsd = deriveMaxCost({
    parentState,
    parentBudgets,
    roleBudgets,
    reserved,
    availableSlots,
  });
  const deadlineTs = deriveDeadline(parentState, parentBudgets, roleBudgets, options);
  const maxWallClockMs = Math.floor(deadlineTs - now);
  if (maxWallClockMs < 1) {
    throw new ChildBudgetExceededError();
  }
  return {
    deadlineTs,
    budgets: {
      ...parentBudgets,
      maxSteps,
      maxWallClockMs,
      ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    },
  };
}

function deriveMaxCost(options: {
  readonly parentState: RunState;
  readonly parentBudgets: RunConfig["budgets"];
  readonly roleBudgets: RoleBudgets | undefined;
  readonly reserved: ChildBudgetReservation;
  readonly availableSlots: number;
}): number | undefined {
  const { parentState, parentBudgets, roleBudgets, reserved, availableSlots } = options;
  let maxCostUsd: number | undefined;
  if (parentBudgets.maxCostUsd !== undefined) {
    const parentRemainingCost =
      Math.floor(
        parentBudgets.maxCostUsd * 1_000_000 - parentState.usage.costMicros - reserved.costMicros,
      ) / 1_000_000;
    if (parentRemainingCost <= 0) {
      throw new ChildBudgetExceededError();
    }
    maxCostUsd = Math.min(
      roleBudgets?.maxCostUsd ?? Number.POSITIVE_INFINITY,
      parentRemainingCost / availableSlots,
    );
    if (maxCostUsd <= 0) {
      throw new ChildBudgetExceededError();
    }
  } else if (roleBudgets?.maxCostUsd !== undefined) {
    maxCostUsd = roleBudgets.maxCostUsd;
  }
  return maxCostUsd;
}

function deriveDeadline(
  parentState: RunState,
  parentBudgets: RunConfig["budgets"],
  roleBudgets: RoleBudgets | undefined,
  options: ChildBudgetOptions,
): number {
  const { now } = options;
  const parentDeadline =
    options.parentDeadlineTs ?? new BudgetTracker(parentBudgets).deadlineTs(parentState);
  const roleDeadline =
    roleBudgets?.maxWallClockMs === undefined
      ? Number.POSITIVE_INFINITY
      : now + roleBudgets.maxWallClockMs;
  return Math.min(parentDeadline, roleDeadline);
}
