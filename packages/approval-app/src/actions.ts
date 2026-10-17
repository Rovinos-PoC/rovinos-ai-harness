// SPDX-License-Identifier: Apache-2.0
import { ResolveRequest, ResolveResponse, type ApprovalPayload } from "@harness/schemas/browser";
import type { AppTelemetry } from "@harness/app-telemetry";
import { createEditForm } from "./edit-form.js";
import { mountRevealFlow, type RevealFlow } from "./reveal.js";

/** Terminal outcome returned by the approval resolve tool. */
export type ApprovalDecision = "approve" | "deny" | "edit";
type AppTelemetryForActions = Pick<AppTelemetry<readonly ["ui.decision"]>, "record" | "flush">;

/** The host bridge methods used by the approval decision and reveal controls. */
export interface ApprovalActionsBridge {
  readonly callTool: (
    name: "harness.approvals.resolve" | "harness.approvals.reveal",
    args: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** Dependencies injected into the approval actions for host calls and safe telemetry. */
export interface ApprovalActionsOptions {
  readonly approvalId: string;
  readonly payload: ApprovalPayload;
  readonly isExpired: () => boolean;
  readonly bridge: ApprovalActionsBridge;
  readonly telemetry: AppTelemetryForActions;
  readonly reportError: (code: "resolve_failed" | "reveal_failed") => void;
  readonly decisionDurationMs: () => number;
  readonly flushInteractions: () => void;
  readonly renderRevealed: (values: ReadonlyMap<string, string>) => void;
  readonly onDecision: (decision: ApprovalDecision) => void;
}

/** Mounted action controls and a non-sensitive state hook for expiry tests. */
export interface ApprovalActions {
  dispose(): void;
  revealedValueCount(): number;
}

interface ActionControls {
  readonly status: HTMLElement;
}

interface ActionContext extends ActionControls {
  readonly actions: HTMLElement;
  readonly editHost: HTMLElement;
  readonly document: Document;
  readonly listeners: AbortController;
  readonly options: ApprovalActionsOptions;
  revealFlow: RevealFlow | undefined;
  readonly state: {
    busy: boolean;
    disposed: boolean;
    editForm: HTMLFormElement | undefined;
  };
}

type UiErrorCode = "resolve_failed" | "reveal_failed";

function element<K extends keyof HTMLElementTagNameMap>(
  document: Document,
  tag: K,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) {
    node.textContent = text;
  }
  return node;
}

const errorMessages: Readonly<Record<string, string>> = {
  approval_not_found: "This approval could not be found.",
  approval_already_resolved: "This approval has already been resolved.",
  approval_run_not_suspended: "This run is no longer awaiting approval.",
  approval_resolution_conflict: "The approval could not be resolved. Try again.",
  edit_invalid: "The edited values are invalid.",
  edit_not_allowed: "One or more edited fields are not allowed.",
};

function errorMessage(code: string | undefined): string {
  const mapped = code === undefined ? undefined : errorMessages[code];
  if (mapped !== undefined) {
    return mapped;
  }
  return "The approval could not be resolved.";
}

function button(
  parent: HTMLElement,
  label: string,
  onClick: () => void,
  signal: AbortSignal,
): HTMLButtonElement | undefined {
  const control = [...parent.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === label,
  );
  if (control === undefined) {
    return undefined;
  }
  control.addEventListener("click", onClick, { signal });
  return control;
}

function createActionControls(actions: HTMLElement, document: Document): ActionControls {
  const status = element(document, "p");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  actions.after(status);
  return { status };
}

function setBusy(context: ActionContext, busy: boolean): void {
  const state = context.state;
  state.busy = busy;
  const expired = context.options.isExpired();
  for (const control of context.actions.querySelectorAll("button")) {
    control.disabled = busy || expired;
  }
  for (const control of context.editHost.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement
  >("button, input, textarea")) {
    control.disabled = busy || expired;
  }
}

const isExpired = (context: ActionContext): boolean => context.options.isExpired();

function reportError(context: ActionContext, code: UiErrorCode, message: string): void {
  const { status } = context;
  status.textContent = message;
  context.options.reportError(code);
}

function decisionStatus(decision: ApprovalDecision): string {
  return {
    approve: "Approval granted.",
    deny: "Approval denied.",
    edit: "Edits submitted.",
  }[decision];
}

async function resolveDecision(
  context: ActionContext,
  decision: ApprovalDecision,
  edits?: ResolveRequest["edits"],
): Promise<void> {
  if (context.state.busy || context.state.disposed) {
    return;
  }
  const { status } = context;
  if (isExpired(context)) {
    return;
  }
  const decisionDurationMs = context.options.decisionDurationMs();
  const request = ResolveRequest.safeParse({
    approvalId: context.options.approvalId,
    decision,
    ...(edits === undefined ? {} : { edits }),
  });
  if (!request.success) {
    reportError(context, "resolve_failed", "The approval could not be resolved.");
    return;
  }
  setBusy(context, true);
  status.textContent = "Submitting decision.";
  try {
    const response = ResolveResponse.safeParse(
      await context.options.bridge.callTool("harness.approvals.resolve", request.data),
    );
    if (!response.success || !response.data.ok) {
      const code = response.success ? response.data.code : undefined;
      reportError(context, "resolve_failed", errorMessage(code));
      setBusy(context, false);
      return;
    }
    context.options.telemetry.record("ui.decision", { decision }, decisionDurationMs);
    void context.options.telemetry.flush();
    context.options.flushInteractions();
    status.textContent = decisionStatus(decision);
    context.options.onDecision(decision);
    context.state.editForm?.remove();
    setBusy(context, true);
  } catch {
    reportError(context, "resolve_failed", errorMessage(undefined));
    setBusy(context, false);
  }
}

function openEditForm(context: ActionContext): void {
  const state = context.state;
  const { status } = context;
  if (state.busy || state.disposed || state.editForm?.isConnected === true) {
    return;
  }
  if (isExpired(context)) {
    return;
  }
  state.editForm = createEditForm(context.document, context.options.payload, (edits) => {
    if (edits.length === 0) {
      status.textContent = "No changes to submit.";
      return;
    }
    void resolveDecision(context, "edit", edits);
  });
  context.editHost.append(state.editForm);
  status.textContent = "Editing approval.";
}

function bindActionHandlers(context: ActionContext): void {
  button(
    context.actions,
    "Approve",
    () => void resolveDecision(context, "approve"),
    context.listeners.signal,
  );
  button(
    context.actions,
    "Deny",
    () => void resolveDecision(context, "deny"),
    context.listeners.signal,
  );
  button(
    context.actions,
    "Edit",
    () => {
      openEditForm(context);
    },
    context.listeners.signal,
  );
}

function disposeActions(context: ActionContext): void {
  const { state } = context;
  state.disposed = true;
  context.revealFlow?.dispose();
  state.editForm?.remove();
  context.listeners.abort();
  context.status.remove();
}

/**
 * Wires the approval view to its host-local decision and reveal tools.
 *
 * @param actions - Existing action navigation rendered by the approval view.
 * @param editHost - Container for the policy-approved edit form.
 * @param options - Approval identity, validated payload, host bridge, and metadata telemetry.
 * @returns Cleanup and a test hook that exposes only a value count.
 */
export function mountApprovalActions(
  actions: HTMLElement,
  editHost: HTMLElement,
  options: ApprovalActionsOptions,
): ApprovalActions {
  const document = actions.ownerDocument;
  const controls = createActionControls(actions, document);
  const context: ActionContext = {
    ...controls,
    actions,
    editHost,
    document,
    listeners: new AbortController(),
    options,
    revealFlow: undefined,
    state: {
      busy: false,
      disposed: false,
      editForm: undefined,
    },
  };
  context.revealFlow = mountRevealFlow(actions, {
    approvalId: options.approvalId,
    payload: options.payload,
    isExpired: options.isExpired,
    bridge: { callTool: (name, args) => options.bridge.callTool(name, args) },
    status: context.status,
    renderRevealed: options.renderRevealed,
    isBusy: () => context.state.busy,
    isDisposed: () => context.state.disposed,
    setBusy: (busy) => {
      setBusy(context, busy);
    },
    reportError: (message) => {
      reportError(context, "reveal_failed", message);
    },
  });
  bindActionHandlers(context);
  return {
    dispose() {
      disposeActions(context);
    },
    revealedValueCount() {
      return context.revealFlow?.revealedValueCount() ?? 0;
    },
  };
}
