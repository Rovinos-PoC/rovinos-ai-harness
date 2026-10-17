// SPDX-License-Identifier: Apache-2.0
import type { Event, RunConfig } from "@harness/schemas";
import { foldRunState, type RunState } from "./run-state.js";

/** Budget dimensions checked before a model or tool operation. */
export type BudgetKind = "steps" | "cost" | "wall_clock";

/** A budget violation and the observed usage that exceeded its limit. */
export interface BudgetViolation {
  readonly ok: false;
  readonly budget: BudgetKind;
  readonly limit: number;
  readonly observed: number;
}

/** Result of checking the configured budgets against folded run state. */
export type BudgetCheck = { readonly ok: true } | BudgetViolation;

/** Adds open child allocations to a parent's effective usage before enforcement. */
export function accountForOpenChildren(
  state: RunState,
  events: readonly Event[],
  budgets: RunConfig["budgets"],
): RunState {
  const completed = new Set(
    events.flatMap((event) => (event.type === "subagent_completed" ? [event.childRunId] : [])),
  );
  const open = events.filter(
    (event) => event.type === "subagent_spawned" && !completed.has(event.childRunId),
  );
  let reservedSteps = 0;
  let reservedCostMicros = 0;
  for (const event of open) {
    if (event.type !== "subagent_spawned") {
      continue;
    }
    if (event.budgetLimits === undefined) {
      reservedSteps = budgets.maxSteps - state.steps;
      if (budgets.maxCostUsd !== undefined) {
        reservedCostMicros = budgets.maxCostUsd * 1_000_000 - state.usage.costMicros;
      }
      break;
    }
    reservedSteps += event.budgetLimits.maxSteps;
    if (budgets.maxCostUsd !== undefined) {
      reservedCostMicros +=
        event.budgetLimits.maxCostUsd === undefined
          ? budgets.maxCostUsd * 1_000_000 - state.usage.costMicros
          : Math.floor(event.budgetLimits.maxCostUsd * 1_000_000);
    }
  }
  return {
    ...state,
    steps: state.steps + reservedSteps,
    usage: {
      ...state.usage,
      costMicros: state.usage.costMicros + reservedCostMicros,
    },
  };
}

/**
 * Checks run usage against immutable limits. Equality is allowed for every limit.
 */
export class BudgetTracker {
  /**
   * Creates a tracker for one run's configured budgets.
   *
   * @param budgets - Validated budgets from the run configuration.
   * @param initialViolation - An inherited budget violation to return on the first check.
   */
  constructor(
    private readonly budgets: RunConfig["budgets"],
    private readonly initialViolation?: BudgetViolation,
    private readonly absoluteDeadlineTs?: number,
  ) {}

  /**
   * Returns the absolute wall-clock deadline while preserving excluded suspension time.
   *
   * @param state - State folded from the run's complete event log.
   * @returns Epoch milliseconds when the wall-clock budget expires.
   */
  deadlineTs(state: RunState): number {
    if (this.absoluteDeadlineTs !== undefined) {
      return this.absoluteDeadlineTs;
    }
    const excludedSuspensionMs = this.budgets.countSuspendedTime ? 0 : state.suspendedTimeMs;
    return state.startedAt + this.budgets.maxWallClockMs + excludedSuspensionMs;
  }

  /**
   * Returns the first exceeded budget without changing the state or tracker.
   *
   * @param state - State folded from the run's complete event log.
   * @param now - Current epoch time in milliseconds.
   * @returns Whether usage is within every configured budget.
   */
  check(state: RunState, now: number): BudgetCheck {
    if (this.initialViolation !== undefined) {
      return this.initialViolation;
    }

    if (state.steps > this.budgets.maxSteps) {
      return {
        ok: false,
        budget: "steps",
        limit: this.budgets.maxSteps,
        observed: state.steps,
      };
    }

    if (this.budgets.maxCostUsd !== undefined) {
      const limit = this.budgets.maxCostUsd * 1_000_000;
      if (state.usage.costMicros > limit) {
        return { ok: false, budget: "cost", limit, observed: state.usage.costMicros };
      }
    }

    const ongoingSuspension =
      state.suspendedAt === undefined ? 0 : Math.max(0, now - state.suspendedAt);
    const suspendedTime = this.budgets.countSuspendedTime
      ? 0
      : state.suspendedTimeMs + ongoingSuspension;
    const elapsedMs = Math.max(0, now - state.startedAt - suspendedTime);
    const exceeded =
      this.absoluteDeadlineTs === undefined
        ? elapsedMs > this.budgets.maxWallClockMs
        : now > this.absoluteDeadlineTs;
    if (exceeded) {
      return {
        ok: false,
        budget: "wall_clock",
        limit: this.absoluteDeadlineTs ?? this.budgets.maxWallClockMs,
        observed: this.absoluteDeadlineTs === undefined ? elapsedMs : now,
      };
    }

    return { ok: true };
  }

  /** Checks the run's own usage plus limits already allocated to open children. */
  checkWithOpenChildren(events: readonly Event[], now: number): BudgetCheck {
    const state = foldRunState(events);
    return this.check(accountForOpenChildren(state, events, this.budgets), now);
  }
}
