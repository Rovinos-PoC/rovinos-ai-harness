// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@harness/schemas";
import type { EventPartial } from "./recorder.js";
import type { RunLoopOptions } from "./loop.js";
import { foldRunState, isTerminalRunState } from "./run-state.js";
import { RUN_SPAN, runSpanAttributes } from "./spans.js";

/** Records run creation and evaluates the durable startup guard before execution. */
export async function withRunStartup(
  options: RunLoopOptions,
  events: Event[],
  continueRun: (runId: Event["runId"]) => Promise<Event>,
): Promise<Event> {
  const startEvents: EventPartial[] = [
    {
      type: "run_created",
      v: 1,
      configHash: options.configHash,
      policyVersion: options.policyVersion,
      ...(options.parentRunId === undefined ? {} : { parentRunId: options.parentRunId }),
      ...(options.parentCallId === undefined ? {} : { parentCallId: options.parentCallId }),
      ...(options.continuationOf === undefined ? {} : { continuationOf: options.continuationOf }),
      ...(options.scopeId === undefined ? {} : { scopeId: options.scopeId }),
      depth: options.depth ?? 0,
    },
    {
      type: "run_input",
      v: 1,
      input: options.goal,
      inputKind: options.inputKind ?? "initial",
    },
    { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
  ];
  return options.recorder.withStepSpan(
    RUN_SPAN,
    runSpanAttributes(options),
    async () => {
      const recorded = await options.recorder.recordBatch(startEvents);
      const last = recorded.at(-1);
      if (last === undefined) {
        throw new Error("Expected run creation events.");
      }
      events.push(...recorded);
      options.onStarted?.();
      if ((await options.shouldContinue?.(events)) === false) {
        const state = foldRunState(events);
        if (isTerminalRunState(state)) {
          const terminalEvent = events.findLast(
            (event) => event.type === "run_status_changed" && event.to === state.status,
          );
          if (terminalEvent === undefined) {
            throw new Error("Expected a terminal run status event.");
          }
          return terminalEvent;
        }
        const cancelled = await options.recorder.record({
          type: "run_status_changed",
          v: 1,
          from: "running",
          to: "cancelled",
          reason: "cancel_requested",
        });
        events.push(cancelled);
        return cancelled;
      }
      return continueRun(last.runId);
    },
    {
      ...(options.rootSpanLinks === undefined ? {} : { links: options.rootSpanLinks }),
      ...(options.rootSpanParent === undefined ? {} : { parentContext: options.rootSpanParent }),
    },
  );
}
