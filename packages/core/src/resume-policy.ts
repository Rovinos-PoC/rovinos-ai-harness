// SPDX-License-Identifier: Apache-2.0
import type { RunResumePolicySchema } from "@harness/schemas";
import type { RunState, ToolIntentEvent } from "./run-state.js";
import type { ToolPort } from "./ports.js";
import type { z } from "zod";

/** Policy selected for a dangling non-idempotent tool intent. */
export type ResumePolicy = z.infer<typeof RunResumePolicySchema>;

/** Decision for one tool intent that has no recorded result. */
export type DanglingIntentAction =
  | { readonly kind: "rerun"; readonly callId: ToolIntentEvent["callId"] }
  | { readonly kind: "escalate"; readonly callId: ToolIntentEvent["callId"] }
  | {
      readonly kind: "fail";
      readonly callId: ToolIntentEvent["callId"];
      readonly errorCode: "unknown_tool" | "resume_ambiguous" | "pii_blocked";
    };

/**
 * Plans how to handle tool intents without results, preserving the state map's order.
 *
 * Unknown tools fail closed. Non-idempotent tools escalate by default so no
 * potentially duplicated side effect occurs without a human decision.
 *
 * @param state - Folded run state containing unresolved tool intents.
 * @param toolPort - Port used to inspect tool idempotency declarations.
 * @param policy - Action for a known non-idempotent tool; defaults to escalation.
 * @returns One action per dangling intent, in event order.
 */
export function planDanglingIntents(
  state: RunState,
  toolPort: ToolPort,
  policy: ResumePolicy = "escalate",
): DanglingIntentAction[] {
  return Array.from(state.pendingToolCalls.values(), (intent) => {
    const description = toolPort.describe(intent.toolId, intent.args);
    if (description === undefined) {
      return { kind: "fail", callId: intent.callId, errorCode: "unknown_tool" };
    }
    if (intent.policyDecision === "deny") {
      return { kind: "fail", callId: intent.callId, errorCode: "pii_blocked" };
    }
    if (intent.policyDecision === "ask") {
      return { kind: "escalate", callId: intent.callId };
    }
    if (intent.idempotent && description.idempotent) {
      return { kind: "rerun", callId: intent.callId };
    }
    if (policy === "fail") {
      return { kind: "fail", callId: intent.callId, errorCode: "resume_ambiguous" };
    }
    return { kind: "escalate", callId: intent.callId };
  });
}
