// SPDX-License-Identifier: Apache-2.0
import type { Event } from "@harness/schemas";
import { preflightModelBudget } from "./model-preflight.js";
import { requestModel } from "./request-model.js";
import { suspendForShutdown } from "./shutdown.js";
import { foldRunState } from "../run-state.js";
import type { RunLoopExecution, RunLoopExecutionOptions } from "../loop.js";
import type { RunRecorder } from "../recorder.js";
import type { Checkpointer } from "../checkpoint.js";

/** Performs the schema-enforced last model call for a child result. */
export async function runStructuredFinalOutput(
  options: RunLoopExecutionOptions,
  events: Event[],
  execution: RunLoopExecution,
): Promise<Event> {
  const preflight = await preflightModelBudget({
    budgetTracker: execution.budgetTracker,
    checkpointer: execution.checkpointer,
    events,
    budgets: options.budgets,
    now: options.clock.now(),
    recorder: options.recorder,
  });
  if (preflight.event !== undefined) {
    return preflight.event;
  }
  const outputSchema = options.finalOutputSchema;
  if (outputSchema === undefined) {
    throw new Error("Expected a child result schema.");
  }
  const built = await options.context.build(events.slice(), options.previousEventLogs);
  const result = await requestModel(
    {
      recorder: options.recorder,
      model: options.model,
      tool: options.tool,
      ids: options.ids,
      runId: execution.runId,
      messages: [
        ...built.messages,
        {
          role: "user",
          parts: [
            {
              type: "text",
              text: "Return the final result as JSON matching the required result schema.",
            },
          ],
        },
      ],
      contextMetadata: built.metadata,
      signal: options.signal,
      deadlineTs: preflight.deadlineTs,
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.provider === undefined ? {} : { provider: options.provider }),
      ...(options.modelName === undefined ? {} : { modelName: options.modelName }),
      outputSchema,
      ...(options.valueTransform === undefined ? {} : { valueTransform: options.valueTransform }),
      includeTools: false,
    },
    options.context,
  );
  events.push(...result.events);
  events.push(...(await options.recorder.drainTrips()));
  if (result.outcome === "aborted") {
    return suspendForShutdown(options.recorder, events, execution.checkpointer);
  }
  if (options.signal.aborted && options.signal.reason === "shutdown") {
    return suspendForShutdown(options.recorder, events, execution.checkpointer);
  }
  if (result.outcome === "failed") {
    const failure = result.events.at(-1);
    if (failure === undefined) {
      throw new Error("Expected the structured output failure event.");
    }
    return failure;
  }
  if (result.preparedCalls.length > 0) {
    return recordStructuredOutputFailure(options.recorder, events);
  }
  const checkpoint = await execution.checkpointer.maybeCheckpoint(foldRunState(events));
  if (checkpoint !== undefined) {
    events.push(checkpoint);
  }
  return recordRunCompleted(options.recorder, events, execution.checkpointer);
}

/** Records a completed status and its checkpoint after a final answer. */
export async function recordRunCompleted(
  recorder: RunRecorder,
  events: Event[],
  checkpointer: Checkpointer,
): Promise<Event> {
  events.push(...(await recorder.drainTrips()));
  const finished = await recorder.record({
    type: "run_status_changed",
    v: 1,
    from: "running",
    to: "completed",
    reason: "final_answer",
  });
  events.push(finished);
  events.push(...(await recorder.drainTrips()));
  const checkpoint = await checkpointer.maybeCheckpoint(foldRunState(events));
  if (checkpoint !== undefined) {
    events.push(checkpoint);
  }
  return finished;
}

async function recordStructuredOutputFailure(
  recorder: RunRecorder,
  events: Event[],
): Promise<Event> {
  const failed = await recorder.record({
    type: "run_status_changed",
    v: 1,
    from: "running",
    to: "failed",
    reason: "result_invalid",
  });
  events.push(failed);
  return failed;
}
