// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { RunConfigSchema } from "./run.js";

describe("RunConfigSchema resume policy", () => {
  it("defaults subagent limits and accepts bounded overrides", () => {
    expect(RunConfigSchema.parse({}).subagents).toEqual({
      maxDepth: 4,
      maxChildrenPerRun: 8,
      maxConcurrentChildren: 2,
    });
    expect(
      RunConfigSchema.parse({
        subagents: { maxDepth: 3, maxChildrenPerRun: "4", maxConcurrentChildren: 1 },
      }).subagents,
    ).toEqual({ maxDepth: 3, maxChildrenPerRun: 4, maxConcurrentChildren: 1 });
    expect(() => RunConfigSchema.parse({ subagents: { maxDepth: 5 } })).toThrow();
    expect(() => RunConfigSchema.parse({ subagents: { maxConcurrentChildren: 0 } })).toThrow();
  });

  it("defaults continuation policy and accepts valid overrides", () => {
    expect(RunConfigSchema.parse({}).continuations).toEqual({
      allowFromFailed: false,
      maxChainLength: 50,
      inheritBudgets: false,
    });
    expect(
      RunConfigSchema.parse({
        continuations: { allowFromFailed: true, maxChainLength: "4", inheritBudgets: true },
      }).continuations,
    ).toEqual({ allowFromFailed: true, maxChainLength: 4, inheritBudgets: true });
    expect(() => RunConfigSchema.parse({ continuations: { maxChainLength: 0 } })).toThrow();
  });

  it("defaults the shutdown grace period to twenty seconds and accepts an override", () => {
    expect(RunConfigSchema.parse({}).shutdownGraceMs).toBe(20_000);
    expect(RunConfigSchema.parse({ shutdownGraceMs: "5000" }).shutdownGraceMs).toBe(5_000);
    expect(() => RunConfigSchema.parse({ shutdownGraceMs: 0 })).toThrow();
  });

  it("defaults checkpoint cadence to twenty events and accepts an override", () => {
    expect(RunConfigSchema.parse({}).checkpointEveryEvents).toBe(20);
    expect(RunConfigSchema.parse({ checkpointEveryEvents: "5" }).checkpointEveryEvents).toBe(5);
    expect(() => RunConfigSchema.parse({ checkpointEveryEvents: 0 })).toThrow();
  });

  it("defaults non-idempotent dangling intents to escalation", () => {
    expect(RunConfigSchema.parse({}).resume.onNonIdempotent).toBe("escalate");
  });

  it("accepts the fail override and rejects unknown policies", () => {
    expect(
      RunConfigSchema.parse({ resume: { onNonIdempotent: "fail" } }).resume.onNonIdempotent,
    ).toBe("fail");
    expect(() => RunConfigSchema.parse({ resume: { onNonIdempotent: "retry" } })).toThrow();
  });
});
