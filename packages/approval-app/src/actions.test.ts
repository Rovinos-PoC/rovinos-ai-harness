// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPayload } from "@harness/schemas/browser";
import {
  mountApprovalActions,
  type ApprovalActions,
  type ApprovalActionsBridge,
} from "./actions.js";

const approvalId = "00000000000000000000000001";
const tokenizedEmail = "<EMAIL_1>";
const rawEmail = "SYNTHETIC_RAW_VALUE_CANARY@example.test";
let modalCalls = 0;

const payload: ApprovalPayload = {
  payloadVersion: 1,
  kind: "tool_call",
  callId: "00000000000000000000000002",
  toolId: "mail.send",
  ruleId: "mail.review",
  reason: "approval_required",
  summary: "Review pending mail",
  args: {
    email: tokenizedEmail,
    count: 2,
    active: false,
    profile: { display: "Current" },
    list: ["<PHONE_2>"],
  },
  ui: { resourceUri: "ui://harness/approval/v1", fallbackText: "Review pending mail" },
  editableFields: ["/email", "/count", "/active", "/profile"],
};

interface ActionFixture {
  readonly actions: HTMLElement;
  readonly editHost: HTMLElement;
  readonly bridge: ApprovalActionsBridge & {
    callTool: ReturnType<typeof vi.fn<ApprovalActionsBridge["callTool"]>>;
  };
  readonly recordCalls: { readonly name: string; readonly attrs: Record<string, unknown> }[];
  readonly decisionDurations: number[];
  readonly flush: ReturnType<typeof vi.fn<() => Promise<void>>>;
  readonly flushInteractions: ReturnType<typeof vi.fn<() => void>>;
  readonly onDecision: ReturnType<typeof vi.fn<(decision: "approve" | "deny" | "edit") => void>>;
  readonly rendered: HTMLElement;
  readonly mount: ApprovalActions;
  readonly setExpired: (expired: boolean) => void;
}

function setup(input: ApprovalPayload = payload): ActionFixture {
  let expired = false;
  const root = document.createElement("main");
  const actions = document.createElement("nav");
  actions.setAttribute("aria-label", "Approval actions");
  for (const label of ["Approve", "Deny", "Edit"]) {
    const control = document.createElement("button");
    control.type = "button";
    control.textContent = label;
    actions.append(control);
  }
  const editHost = document.createElement("div");
  const rendered = document.createElement("p");
  rendered.textContent = tokenizedEmail;
  root.append(actions, editHost, rendered);
  document.body.append(root);
  const bridge = {
    callTool: vi.fn<ApprovalActionsBridge["callTool"]>(),
  };
  const recordCalls: { name: string; attrs: Record<string, unknown> }[] = [];
  const decisionDurations: number[] = [];
  const record = (name: string, attrs: Record<string, unknown>, durationMs?: number): void => {
    recordCalls.push({ name, attrs });
    if (name === "ui.decision" && durationMs !== undefined) {
      decisionDurations.push(durationMs);
    }
  };
  const flush = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const flushInteractions = vi.fn<() => void>();
  const onDecision = vi.fn<(decision: "approve" | "deny" | "edit") => void>();
  const decisionDurationMs = vi.fn(() => 42);
  const reportError = (code: "resolve_failed" | "reveal_failed"): void => {
    record("ui.error", { code });
    void flush();
  };
  const mount = mountApprovalActions(actions, editHost, {
    approvalId,
    payload: input,
    isExpired: () => expired,
    bridge,
    telemetry: { record, flush },
    reportError,
    decisionDurationMs,
    flushInteractions,
    renderRevealed: (values) => {
      rendered.textContent = values.get("/email") ?? tokenizedEmail;
    },
    onDecision,
  });
  return {
    actions,
    editHost,
    bridge,
    recordCalls,
    decisionDurations,
    flush,
    flushInteractions,
    onDecision,
    rendered,
    mount,
    setExpired: (value) => {
      expired = value;
    },
  };
}

const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");

beforeEach(() => {
  modalCalls = 0;
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value(this: HTMLDialogElement) {
      modalCalls += 1;
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value(this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event("close"));
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
  window.localStorage.clear();
  window.sessionStorage.clear();
  if (originalShowModal === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "showModal");
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, "showModal", originalShowModal);
  }
  if (originalClose === undefined) {
    Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
  } else {
    Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose);
  }
});

describe("approval actions", () => {
  it("approves once, disables all actions while pending, and records only a successful decision", async () => {
    const {
      actions,
      bridge,
      recordCalls,
      decisionDurations,
      flush,
      flushInteractions,
      onDecision,
    } = setup();
    let finish: (result: unknown) => void = () => undefined;
    bridge.callTool.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    actions.querySelector<HTMLButtonElement>("button")?.click();
    expect([...actions.querySelectorAll("button")].every((control) => control.disabled)).toBe(true);
    expect(bridge.callTool).toHaveBeenCalledExactlyOnceWith("harness.approvals.resolve", {
      approvalId,
      decision: "approve",
    });
    finish({ ok: true });
    await vi.waitFor(() => {
      expect(
        actions.parentElement?.querySelector<HTMLElement>('[role="status"]')?.textContent,
      ).toBe("Approval granted.");
    });
    expect(recordCalls).toEqual([{ name: "ui.decision", attrs: { decision: "approve" } }]);
    expect(decisionDurations).toEqual([42]);
    expect(onDecision).toHaveBeenCalledExactlyOnceWith("approve");
    expect(flush).toHaveBeenCalledOnce();
    expect(flushInteractions).toHaveBeenCalledOnce();
    expect(JSON.stringify(recordCalls)).not.toContain(rawEmail);
  });

  it("denies with the host-local resolve tool and reports the final state", async () => {
    const { actions, bridge, recordCalls, onDecision } = setup();
    bridge.callTool.mockResolvedValue({ ok: true });
    actions.querySelectorAll<HTMLButtonElement>("button")[1]?.click();
    await vi.waitFor(() => {
      expect(
        actions.parentElement?.querySelector<HTMLElement>('[role="status"]')?.textContent,
      ).toBe("Approval denied.");
    });
    expect(bridge.callTool).toHaveBeenCalledExactlyOnceWith("harness.approvals.resolve", {
      approvalId,
      decision: "deny",
    });
    expect(recordCalls).toEqual([{ name: "ui.decision", attrs: { decision: "deny" } }]);
    expect(onDecision).toHaveBeenCalledExactlyOnceWith("deny");
  });

  it("submits only changed typed edits and keeps the tokenized value visible initially", async () => {
    const { actions, editHost, bridge, recordCalls } = setup();
    bridge.callTool.mockResolvedValue({ ok: true });
    actions.querySelectorAll<HTMLButtonElement>("button")[2]?.click();
    const form = editHost.querySelector<HTMLFormElement>("form");
    if (form === null) {
      throw new Error("Expected an edit form");
    }
    expect(form.textContent).toContain(`Current tokenized value: "${tokenizedEmail}"`);
    const email = form.querySelector<HTMLInputElement>("#approval-edit-0");
    const count = form.querySelector<HTMLInputElement>("#approval-edit-1");
    const active = form.querySelector<HTMLInputElement>("#approval-edit-2");
    if (email === null || count === null || active === null) {
      throw new Error("Expected typed edit controls");
    }
    email.value = rawEmail;
    count.value = "7";
    active.checked = true;
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(recordCalls).toContainEqual({
        name: "ui.decision",
        attrs: { decision: "edit" },
      });
    });
    expect(bridge.callTool).toHaveBeenCalledExactlyOnceWith("harness.approvals.resolve", {
      approvalId,
      decision: "edit",
      edits: [
        { pointer: "/email", value: rawEmail },
        { pointer: "/count", value: 7 },
        { pointer: "/active", value: true },
      ],
    });
    expect(JSON.stringify(recordCalls)).not.toContain(rawEmail);
  });

  it("does not submit an unchanged edit form", () => {
    const { actions, editHost, bridge } = setup();
    actions.querySelectorAll<HTMLButtonElement>("button")[2]?.click();
    editHost
      .querySelector("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(bridge.callTool).not.toHaveBeenCalled();
    expect(actions.parentElement?.querySelector<HTMLElement>('[role="status"]')?.textContent).toBe(
      "No changes to submit.",
    );
  });

  it("requires confirmation, cancels without a call, and masks revealed values after 30 seconds", async () => {
    vi.useFakeTimers();
    const { actions, bridge, recordCalls, rendered, mount } = setup();
    bridge.callTool.mockResolvedValue({
      values: [
        { pointer: "/email", value: rawEmail },
        { pointer: "/not-requested", value: "SYNTHETIC_EXTRA_CANARY" },
      ],
    });
    const reveal = actions.querySelector<HTMLButtonElement>("button:last-child");
    reveal?.click();
    const confirmation = document.querySelector<HTMLDialogElement>("dialog");
    expect(confirmation?.textContent).toContain("Show raw values for 2 fields? This is logged.");
    expect(confirmation?.open).toBe(true);
    expect(modalCalls).toBe(1);
    expect(bridge.callTool).not.toHaveBeenCalled();
    const confirmButton = confirmation?.querySelector<HTMLButtonElement>("button:first-of-type");
    const cancelButton = confirmation?.querySelector<HTMLButtonElement>("button:last-child");
    expect(document.activeElement).toBe(confirmButton);
    expect(
      [...actions.querySelectorAll("button")].slice(0, 2).every((button) => button.disabled),
    ).toBe(true);
    actions.querySelector<HTMLButtonElement>("button:first-child")?.click();
    expect(bridge.callTool).not.toHaveBeenCalled();
    const shiftTab = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    confirmation?.dispatchEvent(shiftTab);
    expect(shiftTab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(cancelButton);
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    confirmation?.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(confirmButton);
    cancelButton?.click();
    expect(bridge.callTool).not.toHaveBeenCalled();
    expect(confirmation?.open).toBe(false);
    expect(document.activeElement).toBe(reveal);

    reveal?.click();
    document.querySelector<HTMLButtonElement>("dialog button:first-of-type")?.click();
    await vi.waitFor(() => {
      expect(rendered.textContent).toBe(rawEmail);
    });
    expect(mount.revealedValueCount()).toBe(1);
    expect(bridge.callTool).toHaveBeenCalledExactlyOnceWith("harness.approvals.reveal", {
      approvalId,
      pointers: ["/email", "/list/0"],
    });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(JSON.stringify(recordCalls)).not.toContain(rawEmail);
    expect(JSON.stringify(recordCalls)).not.toContain("SYNTHETIC_EXTRA_CANARY");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(rendered.textContent).toBe(tokenizedEmail);
    expect(document.body.textContent).not.toContain(rawEmail);
    expect(mount.revealedValueCount()).toBe(0);
    reveal?.click();
    expect(document.querySelector<HTMLDialogElement>("dialog")?.open).toBe(true);
    mount.dispose();
  });

  it("re-masks after a decision without replacing its final status", async () => {
    vi.useFakeTimers();
    const { actions, bridge, rendered } = setup();
    bridge.callTool.mockImplementation((name) =>
      Promise.resolve(
        name === "harness.approvals.reveal"
          ? { values: [{ pointer: "/email", value: rawEmail }] }
          : { ok: true },
      ),
    );
    actions.querySelector<HTMLButtonElement>("button:last-child")?.click();
    document.querySelector<HTMLButtonElement>("dialog button:first-of-type")?.click();
    await vi.waitFor(() => {
      expect(rendered.textContent).toBe(rawEmail);
    });
    actions.querySelector<HTMLButtonElement>("button:first-child")?.click();
    await vi.waitFor(() => {
      expect(
        actions.parentElement?.querySelector<HTMLElement>('[role="status"]')?.textContent,
      ).toBe("Approval granted.");
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(rendered.textContent).toBe(tokenizedEmail);
    expect(actions.parentElement?.querySelector<HTMLElement>('[role="status"]')?.textContent).toBe(
      "Approval granted.",
    );
  });

  it("replaces previously revealed values after another successful reveal", async () => {
    const { actions, bridge, rendered, mount } = setup();
    bridge.callTool
      .mockResolvedValueOnce({ values: [{ pointer: "/email", value: rawEmail }] })
      .mockResolvedValueOnce({ values: [] });
    const reveal = actions.querySelector<HTMLButtonElement>("button:last-child");
    reveal?.click();
    document.querySelector<HTMLButtonElement>("dialog button:first-of-type")?.click();
    await vi.waitFor(() => {
      expect(mount.revealedValueCount()).toBe(1);
    });
    reveal?.click();
    document.querySelector<HTMLButtonElement>("dialog button:first-of-type")?.click();
    await vi.waitFor(() => {
      expect(mount.revealedValueCount()).toBe(0);
    });
    expect(rendered.textContent).toBe(tokenizedEmail);
    mount.dispose();
  });

  it("reports resolve errors using code-only messages and emits no exception text", async () => {
    const { actions, bridge, recordCalls } = setup();
    bridge.callTool.mockResolvedValue({ ok: false, code: "approval_already_resolved" });
    actions.querySelector("button")?.click();
    await vi.waitFor(() => {
      expect(
        actions.parentElement?.querySelector<HTMLElement>('[role="status"]')?.textContent,
      ).toBe("This approval has already been resolved.");
    });
    expect(recordCalls).toEqual([{ name: "ui.error", attrs: { code: "resolve_failed" } }]);
  });

  it("hides bridge exception details from the view and telemetry", async () => {
    const { actions, bridge, recordCalls } = setup();
    bridge.callTool.mockRejectedValue(new Error(rawEmail));
    actions.querySelector("button")?.click();
    await vi.waitFor(() => {
      expect(
        actions.parentElement?.querySelector<HTMLElement>('[role="status"]')?.textContent,
      ).toBe("The approval could not be resolved.");
    });
    expect(document.body.textContent).not.toContain(rawEmail);
    expect(JSON.stringify(recordCalls)).not.toContain(rawEmail);
    expect(recordCalls).toEqual([{ name: "ui.error", attrs: { code: "resolve_failed" } }]);
  });

  it("keeps all controls disabled and refuses edits when a pending decision expires", async () => {
    const { actions, editHost, bridge, setExpired } = setup();
    actions.querySelectorAll<HTMLButtonElement>("button")[2]?.click();
    bridge.callTool.mockResolvedValue({ ok: false, code: "approval_run_not_suspended" });
    actions.querySelector<HTMLButtonElement>("button")?.click();
    expect(
      [...editHost.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].every(
        (control) => control.disabled,
      ),
    ).toBe(true);
    setExpired(true);
    await vi.waitFor(() => {
      expect(
        actions.parentElement?.querySelector<HTMLElement>('[role="status"]')?.textContent,
      ).toBe("This run is no longer awaiting approval.");
    });
    expect([...actions.querySelectorAll("button")].every((control) => control.disabled)).toBe(true);
    expect(
      [...editHost.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button")].every(
        (control) => control.disabled,
      ),
    ).toBe(true);
    const input = editHost.querySelector<HTMLInputElement>("input");
    if (input !== null) {
      input.value = "changed";
      input.dispatchEvent(new Event("input"));
    }
    editHost
      .querySelector<HTMLFormElement>("form")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(bridge.callTool).toHaveBeenCalledExactlyOnceWith("harness.approvals.resolve", {
      approvalId,
      decision: "approve",
    });
  });

  it("refuses malformed reveal results, reports a metadata-only error, and clears values on dispose", async () => {
    const { actions, bridge, recordCalls, rendered, mount } = setup();
    bridge.callTool.mockResolvedValue({ values: [{ pointer: "/email", value: 42 }] });
    actions.querySelector<HTMLButtonElement>("button:last-child")?.click();
    document.querySelector<HTMLButtonElement>("dialog button:first-of-type")?.click();
    await vi.waitFor(() => {
      expect(
        actions.parentElement?.querySelector<HTMLElement>('[role="status"]')?.textContent,
      ).toBe("The values could not be revealed.");
    });
    expect(rendered.textContent).toBe(tokenizedEmail);
    expect(recordCalls).toEqual([{ name: "ui.error", attrs: { code: "reveal_failed" } }]);

    bridge.callTool.mockResolvedValueOnce({
      values: [{ pointer: "/email", value: rawEmail }],
    });
    actions.querySelector<HTMLButtonElement>("button:last-child")?.click();
    document.querySelector<HTMLButtonElement>("dialog button:first-of-type")?.click();
    await vi.waitFor(() => {
      expect(rendered.textContent).toBe(rawEmail);
    });
    mount.dispose();
    expect(rendered.textContent).toBe(tokenizedEmail);
    expect(mount.revealedValueCount()).toBe(0);
    expect(document.body.textContent).not.toContain(rawEmail);
  });

  it("disables reveal when there are no tokenized values", () => {
    const { actions, bridge } = setup({ ...payload, args: { ordinary: "no token" } });
    const reveal = actions.querySelector<HTMLButtonElement>("button:last-child");
    expect(reveal?.disabled).toBe(true);
    reveal?.click();
    expect(document.querySelector<HTMLDialogElement>("dialog")?.open).toBe(false);
    expect(bridge.callTool).not.toHaveBeenCalled();
  });
});
