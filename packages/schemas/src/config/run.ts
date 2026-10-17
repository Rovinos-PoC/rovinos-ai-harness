// SPDX-License-Identifier: Apache-2.0
// Run config is owned by task 20.1; continuation policy is added by task 2.14.
import { z } from "zod";

/** Policy for dangling non-idempotent tool intents encountered during resume. */
export const RunResumePolicySchema = z.enum(["escalate", "fail"]).default("escalate");

/** Continuation behavior for linked follow-up runs. */
export const RunContinuationsSchema = z
  .object({
    allowFromFailed: z.boolean().default(false),
    maxChainLength: z.coerce.number().int().positive().default(50),
    inheritBudgets: z.boolean().default(false),
  })
  .strict()
  .prefault({});

export const RunBudgetsSchema = z
  .object({
    maxSteps: z.coerce.number().int().positive().default(200),
    maxCostUsd: z.coerce.number().positive().optional(),
    maxWallClockMs: z.coerce.number().int().positive().default(3_600_000),
    countSuspendedTime: z
      .union([z.boolean(), z.enum(["true", "false"]).transform((value) => value === "true")])
      .default(false),
  })
  .strict()
  .prefault({});

export const RunConfigSchema = z
  .object({
    checkpointEveryEvents: z.coerce.number().int().positive().default(20),
    shutdownGraceMs: z.coerce.number().int().positive().default(20_000),
    continuations: RunContinuationsSchema,
    resume: z
      .object({
        onNonIdempotent: RunResumePolicySchema,
      })
      .strict()
      .prefault({}),
    subagents: z
      .object({
        maxDepth: z.coerce.number().int().nonnegative().max(4).default(4),
        maxChildrenPerRun: z.coerce.number().int().positive().default(8),
        maxConcurrentChildren: z.coerce.number().int().positive().default(2),
      })
      .strict()
      .prefault({}),
    budgets: RunBudgetsSchema,
  })
  .strict()
  .prefault({});

/** The validated run configuration, including defaults. */
export type RunConfig = z.infer<typeof RunConfigSchema>;
