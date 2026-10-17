// SPDX-License-Identifier: Apache-2.0
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  context,
  ROOT_CONTEXT,
  trace,
  SpanStatusCode,
  type Context,
  type ContextManager,
  type Link,
  type Span,
  type SpanContext,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import {
  FakeClock,
  Event,
  Id,
  JsonValue,
  PiiConfigSchema,
  RunConfigSchema,
  SequentialIdGenerator,
  HarnessError,
  Traceparent,
  UNREGISTERED_TOOL_ID,
  type JsonValue as JsonValueType,
} from "@harness/schemas";
import {
  InMemoryEventStore,
  SeqConflictError,
  SqliteEventStore,
  type EventStore,
} from "@harness/store";
import {
  CalibratingTokenCounter,
  HeuristicTokenCounter,
  NaiveStrategy,
  SummarizingStrategy,
} from "@harness/context";
import { activeRuns, TripQueue } from "@harness/telemetry";
import { buildApprovalPayload, sweepApprovals, type ApprovalSweepStore } from "@harness/policy";
import { emailDetector, PiiToolPort, Tokenizer } from "@harness/pii";
import { AuditingVaultResolver, InMemoryVault } from "@harness/vault";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { FakeModelPort, FakeToolPort } from "./testing/index.js";
import { NaiveContext } from "./context/naive-context.js";
import { StrategyContextPort } from "./context/context-port.js";
import { RunRecorder, type EventPartial } from "./recorder.js";
import { runLoop as runCoreLoop } from "./loop.js";
import { installShutdownHandler, type ShutdownProcessLike } from "./shutdown.js";
import { Checkpointer } from "./checkpoint.js";
import { foldRunState } from "./run-state.js";
import { RUN_SPAN } from "./spans.js";
import type {
  ContextPort,
  IdGenerator,
  ModelCompletion,
  ModelToolCall,
  ModelPort,
  PolicyPort,
  RunContext,
  ToolPort,
  ToolExecutionResult,
  Summarizer,
} from "./ports.js";
import {
  applyResolvedApprovals,
  ApprovalAlreadyResolvedError,
  ApprovalEditsRequiredError,
  ApprovalNotFoundError,
  ApprovalRequestStateError,
  ApprovalRunNotSuspendedError,
  requestApproval,
  resolveApproval,
} from "./approvals.js";
import {
  ResumeConflictError,
  RunAlreadyTerminalError,
  RunAwaitingApprovalError,
  resumeRun,
} from "./resume.js";
import type { ResumeRunOptions } from "./resume.js";

const allowTestPolicy: PolicyPort = {
  version: "test.policy",
  decide: () => ({
    decision: "allow",
    ruleId: "test_allow",
    reason: "test_allowed",
    editable: [],
  }),
};

function runLoop(options: Parameters<typeof runCoreLoop>[0]) {
  return runCoreLoop({ ...options, policy: options.policy ?? allowTestPolicy });
}

const runId = "00000000000000000000000000";
const segmentId = "11111111111111111111111111";
const configHash = "a".repeat(64);
const modelCallId = "22222222222222222222222222";
const approvalId = "33333333333333333333333333";
const defaultBudgets = RunConfigSchema.parse({}).budgets;
const goldenPath = fileURLToPath(new URL("./__golden__/one-step.json", import.meta.url));
let nextSpanId = 0;
let invalidSpanContext = false;

class FakeShutdownProcess implements ShutdownProcessLike {
  exitCode: number | undefined = undefined;
  readonly forcedTerminations: ("SIGINT" | "SIGTERM")[] = [];
  private readonly listeners = new Map<"SIGINT" | "SIGTERM", (() => void)[]>();

  on(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.listeners.set(signal, [...(this.listeners.get(signal) ?? []), listener]);
    return this;
  }

  removeListener(signal: "SIGINT" | "SIGTERM", listener: () => void): this {
    this.listeners.set(
      signal,
      (this.listeners.get(signal) ?? []).filter((registered) => registered !== listener),
    );
    return this;
  }

  exit(code: number): void {
    this.exitCode = code;
  }

  emit(signal: "SIGINT" | "SIGTERM"): void {
    const listeners = this.listeners.get(signal) ?? [];
    if (listeners.length === 0) {
      this.forcedTerminations.push(signal);
      return;
    }
    for (const listener of listeners) {
      listener();
    }
  }
}

class TestSpan implements Span {
  private ended = false;
  private recordedExceptions = 0;
  readonly attributes: Record<string, string | number | boolean> = {};
  readonly links: Link[] = [];
  readonly spanContextValue: SpanContext = {
    traceId: invalidSpanContext ? "0".repeat(32) : "a".repeat(32),
    spanId: invalidSpanContext ? "0".repeat(16) : (++nextSpanId).toString(16).padStart(16, "0"),
    traceFlags: 1,
  };

  constructor(
    readonly name: string,
    readonly parentSpanId: string | undefined,
    attributes?: SpanOptions["attributes"],
    links?: SpanOptions["links"],
  ) {
    if (attributes !== undefined) {
      Object.assign(this.attributes, attributes);
    }
    if (links !== undefined) {
      this.links.push(...links);
    }
  }

  spanContext(): SpanContext {
    return this.spanContextValue;
  }

  setAttribute(key: string, value: string | number | boolean): this {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: SpanOptions["attributes"]): this {
    if (attributes !== undefined) {
      Object.assign(this.attributes, attributes);
    }
    return this;
  }

  addEvent(
    _name: Parameters<Span["addEvent"]>[0],
    _attributesOrStartTime?: Parameters<Span["addEvent"]>[1],
    _startTime?: Parameters<Span["addEvent"]>[2],
  ): this {
    return this;
  }

  addLink(link: Parameters<Span["addLink"]>[0]): this {
    this.links.push(link);
    return this;
  }

  addLinks(links: Parameters<Span["addLinks"]>[0]): this {
    this.links.push(...links);
    return this;
  }

  status: Parameters<Span["setStatus"]>[0] = { code: SpanStatusCode.UNSET };

  setStatus(status: Parameters<Span["setStatus"]>[0]): this {
    this.status = status;
    return this;
  }

  updateName(_name: string): this {
    return this;
  }

  end(): void {
    this.ended = true;
  }

  isRecording(): boolean {
    return !this.ended;
  }

  recordException(
    _exception: Parameters<Span["recordException"]>[0],
    _time?: Parameters<Span["recordException"]>[1],
  ): void {
    this.recordedExceptions += 1;
  }
}

class TestTracer implements Tracer {
  readonly spans: TestSpan[] = [];

  startSpan(name: string, options?: SpanOptions, parentContext?: Context): Span {
    const parent = trace.getSpan(parentContext ?? context.active());
    const span = new TestSpan(
      name,
      parent?.spanContext().spanId,
      options?.attributes,
      options?.links,
    );
    this.spans.push(span);
    return span;
  }

  startActiveSpan<F extends (span: Span) => unknown>(name: string, fn: F): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    name: string,
    options: SpanOptions,
    activeContext: Context,
    fn: F,
  ): ReturnType<F>;
  startActiveSpan<F extends (span: Span) => unknown>(
    _name: string,
    _optionsOrCallback: SpanOptions | F,
    _contextOrCallback?: Context | F,
    _callback?: F,
  ): ReturnType<F> {
    throw new Error("startActiveSpan is not used by the recorder.");
  }
}

class TestTracerProvider implements TracerProvider {
  private readonly tracer = new TestTracer();

  getTracer(): Tracer {
    return this.tracer;
  }

  get spans(): readonly TestSpan[] {
    return this.tracer.spans;
  }
}

class TestContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    activeContext: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(activeContext, () => fn.apply(thisArg, args));
  }

  bind<T>(_activeContext: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    this.storage.disable();
    return this;
  }
}

function completion(
  toolCalls: readonly ModelToolCall[] = [],
  content = "answer",
  costMicros = 12,
): ModelCompletion {
  return {
    parts: [
      { type: "text", text: content },
      ...toolCalls.map((toolCall) => ({ type: "tool_call" as const, ...toolCall })),
    ],
    usage: { inputTokens: 3, outputTokens: 5, costMicros },
    finishReason: "stop",
    provider: "test_provider",
    model: "test_model",
    latencyMs: 8,
    schemaValid: true,
    repairAttempts: 0,
    fallbackDepth: 0,
    providerBlobs: { trace: "opaque" },
  };
}

async function createApprovalRun(
  store: EventStore,
  clock: FakeClock,
  args: JsonValueType = { z: 1, a: 3 },
  editable: readonly string[] = ["/a"],
) {
  const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
  let events: Event[] = [];
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    events = await recorder.recordBatch([
      { type: "run_created", v: 1, configHash, policyVersion: "test.policy" },
      { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
      {
        type: "tool_intent",
        v: 1,
        callId: modelCallId,
        toolId: "approval_tool",
        idempotent: false,
        policyDecision: "ask",
        ruleId: "test_rule",
        policyReason: "manual_review",
        policyEditable: [...editable],
        argsHash: "51221262a85f34235978c8dc712134f6e04b6078190d87ef73bee21422c8af3e",
        args,
      },
    ]);
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected approval run events.");
    }
    return last;
  });
  return { recorder, events, state: foldRunState(events) };
}

async function requestApprovalForRun(
  recorder: RunRecorder,
  clock: FakeClock,
  state: ReturnType<typeof foldRunState>,
  approvalTtlMs?: number,
) {
  const intent = state.pendingToolCalls.get(modelCallId);
  if (intent === undefined) {
    throw new Error("Expected a pending approval intent.");
  }
  const payload = buildApprovalPayload({
    call: { callId: intent.callId, toolId: intent.toolId, args: intent.args },
    rule: {
      id: intent.ruleId ?? "test_rule",
      reason: intent.policyReason ?? "manual_review",
      editable: intent.policyEditable ?? [],
      ...(approvalTtlMs === undefined ? {} : { approvalTtlMs }),
    },
    now: Math.floor(clock.now()),
  });
  return requestApproval(recorder, {
    approvalId,
    callId: modelCallId,
    payload: JsonValue.parse(payload),
    ...(approvalTtlMs === undefined ? {} : { expiresAt: Math.floor(clock.now()) + approvalTtlMs }),
    state,
    checkpointer: new Checkpointer({
      recorder,
      runId,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      clock,
    }),
  });
}

async function readApprovalEvents(store: EventStore): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

class TestToolError extends HarnessError {
  readonly code = "tool_broken";

  constructor() {
    super("Synthetic tool failure.");
  }
}

function normalizeEvents(events: readonly Event[]): JsonValueType {
  return events.map((event) => {
    if (event.type === "run_created") {
      return {
        type: event.type,
        seq: event.seq,
        configHash: event.configHash,
        policyVersion: event.policyVersion,
      };
    }
    if (event.type === "run_input") {
      return {
        type: event.type,
        seq: event.seq,
        input: event.input,
        inputKind: event.inputKind,
      };
    }
    if (event.type === "run_status_changed") {
      return {
        type: event.type,
        seq: event.seq,
        from: event.from,
        to: event.to,
        reason: event.reason,
      };
    }
    if (event.type === "model_request") {
      return {
        type: event.type,
        seq: event.seq,
        requestId: event.requestId,
        provider: event.provider,
        model: event.model,
        messages: event.messages,
      };
    }
    if (event.type === "model_response") {
      return {
        type: event.type,
        seq: event.seq,
        requestId: event.requestId,
        provider: event.provider,
        model: event.model,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        ...(event.costMicros === undefined ? {} : { costMicros: event.costMicros }),
        finishReason: event.finishReason,
        latencyMs: event.latencyMs,
        schemaValid: event.schemaValid,
        repairAttempts: event.repairAttempts,
        ...(event.rungUsed === undefined ? {} : { rungUsed: event.rungUsed }),
        fallbackDepth: event.fallbackDepth,
        content: event.content,
        providerBlobs: event.providerBlobs,
      };
    }
    return { type: event.type, seq: event.seq };
  });
}

const tracerProvider = new TestTracerProvider();

async function createRunHistory(
  store: EventStore,
  clock: FakeClock,
  laterEvents: readonly EventPartial[] = [],
): Promise<Event[]> {
  const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
  const initialEvents: EventPartial[] = [
    { type: "run_created", v: 1, configHash, policyVersion: "test.policy" },
    { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
    ...laterEvents,
  ];
  let events: Event[] = [];
  await recorder.withStepSpan(RUN_SPAN, {}, async () => {
    events = await recorder.recordBatch(initialEvents);
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected a seeded run history.");
    }
    return last;
  });
  return events;
}

function createResumeOptions(
  store: EventStore,
  clock: FakeClock,
  overrides: Partial<ResumeRunOptions> = {},
): ResumeRunOptions {
  const ids: IdGenerator = new SequentialIdGenerator();
  return {
    store,
    runId,
    clock,
    model: new FakeModelPort([completion()]),
    tool: new FakeToolPort(),
    context: new NaiveContext(),
    ids,
    goal: "resumed goal",
    signal: new AbortController().signal,
    budgets: defaultBudgets,
    ...overrides,
  };
}

beforeAll(() => {
  context.setGlobalContextManager(new TestContextManager());
  trace.setGlobalTracerProvider(tracerProvider);
});

afterAll(() => {
  context.disable();
});

describe("approval lifecycle", () => {
  it("records a request, suspends the run, and forces a checkpoint", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const { recorder, state } = await createApprovalRun(store, clock);

    const result = await requestApprovalForRun(recorder, clock, state);
    const stored = await readApprovalEvents(store);

    expect(result).toMatchObject({
      status: "suspended",
      approvalIds: [approvalId],
    });
    expect(result.events.map(({ type }) => type)).toEqual([
      "approval_requested",
      "run_status_changed",
      "checkpoint_written",
    ]);
    expect(stored).toMatchObject([
      { type: "run_created" },
      { type: "run_status_changed", to: "running" },
      {
        type: "tool_intent",
        callId: modelCallId,
        argsHash: "51221262a85f34235978c8dc712134f6e04b6078190d87ef73bee21422c8af3e",
      },
      {
        type: "approval_requested",
        approvalId,
        callId: modelCallId,
        payload: {
          kind: "tool_call",
          editableFields: ["/a"],
          args: { z: 1, a: 3 },
        },
      },
      { type: "run_status_changed", from: "running", to: "suspended", reason: "awaiting_approval" },
      { type: "checkpoint_written", atSeq: 5 },
    ]);
    await expect(store.latestSnapshot(runId)).resolves.toMatchObject({ atSeq: 5 });
    expect(foldRunState(stored).pendingApprovals.has(approvalId)).toBe(true);
    await expect(requestApprovalForRun(recorder, clock, state)).rejects.toBeInstanceOf(
      ApprovalRequestStateError,
    );
  });

  it.each(["approve", "deny", "edit"] as const)(
    "resolves and applies the %s decision from a new recorder",
    async (decision) => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      const { recorder, state } = await createApprovalRun(store, clock);
      await requestApprovalForRun(recorder, clock, state);
      clock.advance(25);
      const edits = decision === "edit" ? { z: 1, a: 4 } : undefined;
      const editTool: ToolPort | undefined =
        decision === "edit"
          ? {
              describe: () => ({ idempotent: false, timeoutMs: 1_000 }),
              prepare: (call) => Promise.resolve(call),
              execute: () => Promise.resolve({ outcome: "ok", result: null }),
            }
          : undefined;

      const resolution = await resolveApproval(
        store,
        runId,
        approvalId,
        decision,
        edits,
        clock,
        editTool,
      );
      const eventsBeforeResume = await readApprovalEvents(store);
      expect(foldRunState(eventsBeforeResume).status).toBe("suspended");
      const lastEvent = eventsBeforeResume.at(-1);
      if (lastEvent === undefined) {
        throw new Error("Expected the approval resolution.");
      }
      const resumedRecorder = new RunRecorder(
        store,
        runId,
        lastEvent.segmentId,
        await store.head(runId),
        clock,
      );
      await resumedRecorder.withStepSpan(RUN_SPAN, {}, async () =>
        resumedRecorder.record({
          type: "run_status_changed",
          v: 1,
          from: "suspended",
          to: "running",
          reason: "resumed",
        }),
      );
      const resumedState = foldRunState(await readApprovalEvents(store));
      const tool = new FakeToolPort(
        new Map([
          [
            "approval_tool",
            {
              idempotent: false,
              timeoutMs: 1_000,
              execute: () => Promise.resolve({ outcome: "ok", result: { executed: true } }),
            },
          ],
        ]),
      );
      const applied = await applyResolvedApprovals(
        {
          recorder: resumedRecorder,
          tool,
          policy: allowTestPolicy,
          clock,
          runId,
          signal: new AbortController().signal,
        },
        resumedState,
      );
      const result = applied[0];
      if (result === undefined) {
        throw new Error("Expected the approval result.");
      }

      expect(resolution).toMatchObject({
        type: "approval_resolved",
        approvalId,
        decision,
        waitMs: 25,
        ...(edits === undefined ? {} : { edits }),
      });
      expect(applied.map(({ type }) => type)).toEqual(["tool_result"]);
      expect(tool.calls).toHaveLength(decision === "deny" ? 0 : 1);
      const expectedArgs = decision === "edit" ? { z: 1, a: 4 } : { z: 1, a: 3 };
      expect(tool.calls.map(({ call }) => call.args)).toEqual(
        decision === "deny" ? [] : [expectedArgs],
      );
      const expectedResult: Record<string, string> = {
        outcome: decision === "deny" ? "denied" : "ok",
      };
      if (decision === "deny") {
        expectedResult.errorCode = "approval_denied";
      }
      if (decision === "edit") {
        expectedResult.executedArgsHash =
          "8766e03843f53a53303e4aafafb8dcc5db425524ed73f14934b18b154e4e7953";
      }
      expect(result).toMatchObject(expectedResult);
      const finalState = foldRunState(await readApprovalEvents(store));
      expect(finalState.pendingApprovals.size).toBe(0);
      expect(finalState.pendingToolCalls.size).toBe(0);
      await expect(
        applyResolvedApprovals(
          {
            recorder: resumedRecorder,
            tool,
            clock,
            runId,
            signal: new AbortController().signal,
          },
          finalState,
        ),
      ).resolves.toEqual([]);
    },
  );

  it("validates and tokenizes edits before resolution, then resumes with raw values only in memory", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const vault = new InMemoryVault();
    const piiConfig = PiiConfigSchema.parse({
      defaultAction: "tokenize",
      detokenize: [{ toolId: "approval_tool", args: ["/to"] }],
    });
    const inputSchema = {
      type: "object",
      properties: {
        to: { type: "string", format: "email" },
        cc: { type: "string", pattern: "^<EMAIL_[0-9]+>$" },
        subject: { type: "string" },
      },
      required: ["to", "cc", "subject"],
      additionalProperties: false,
    };
    const executedArgs: JsonValueType[] = [];
    const inner = {
      describe: () => ({ idempotent: false, timeoutMs: 1_000, inputSchema }),
      execute: (call: { readonly args: JsonValueType }) => {
        executedArgs.push(call.args);
        return Promise.resolve({ outcome: "ok" as const, result: null });
      },
    };
    const tokenizer = new Tokenizer({
      policy: piiConfig,
      vault,
      detectors: { detect: (text) => emailDetector.detect(text) },
    });
    const tokenizeJson = vi.spyOn(tokenizer, "tokenizeJson");
    const tool = new PiiToolPort(inner, {
      config: piiConfig,
      tokenizer,
      resolver: new AuditingVaultResolver(vault, () => undefined),
    });
    const initial = await tool.prepare(
      {
        callId: modelCallId,
        toolId: "approval_tool",
        args: {
          to: "old@example.test",
          cc: "copy@example.test",
          subject: "Original",
        },
      },
      { runId, signal: new AbortController().signal },
    );
    if (typeof initial.args !== "object" || initial.args === null || Array.isArray(initial.args)) {
      throw new TypeError("Expected tokenized object arguments.");
    }
    const ccToken = initial.args.cc;
    if (typeof ccToken !== "string") {
      throw new TypeError("Expected a tokenized cc email.");
    }
    const { recorder, state } = await createApprovalRun(store, clock, initial.args, ["/to"]);
    await requestApprovalForRun(recorder, clock, state);

    const resolution = await resolveApproval(
      store,
      runId,
      approvalId,
      "edit",
      {
        to: "new@example.test",
        cc: ccToken,
        subject: "Original",
      },
      clock,
      tool,
    );

    expect(resolution.edits).toMatchObject({
      to: "<EMAIL_3>",
      cc: "<EMAIL_2>",
      subject: "Original",
    });
    expect(JSON.stringify(resolution.edits)).not.toContain("new@example.test");
    expect(
      tokenizeJson.mock.calls.filter(
        ([, , toolInputContext]) => toolInputContext.boundary === "tool_input",
      ),
    ).toHaveLength(2);
    const afterResolution = await readApprovalEvents(store);
    const lastEvent = afterResolution.at(-1);
    if (lastEvent === undefined) {
      throw new TypeError("Expected a durable approval resolution.");
    }
    const resumedRecorder = new RunRecorder(
      store,
      runId,
      lastEvent.segmentId,
      await store.head(runId),
      clock,
    );
    await resumedRecorder.withStepSpan(RUN_SPAN, {}, async () =>
      resumedRecorder.record({
        type: "run_status_changed",
        v: 1,
        from: "suspended",
        to: "running",
        reason: "resumed",
      }),
    );
    await applyResolvedApprovals(
      {
        recorder: resumedRecorder,
        tool,
        policy: allowTestPolicy,
        clock,
        runId,
        signal: new AbortController().signal,
      },
      foldRunState(await readApprovalEvents(store)),
    );

    expect(executedArgs).toEqual([
      {
        to: "new@example.test",
        cc: "<EMAIL_2>",
        subject: "Original",
      },
    ]);
    expect(
      tokenizeJson.mock.calls.filter(
        ([, , toolInputContext]) => toolInputContext.boundary === "tool_input",
      ),
    ).toHaveLength(2);
  });

  it.each([
    {
      changed: { z: 2, a: 4 },
      schema: undefined,
      code: "edit_not_allowed",
    },
    {
      changed: { z: 1, a: -1 },
      schema: {
        type: "object",
        properties: { z: { type: "integer" }, a: { type: "integer", minimum: 0 } },
      },
      code: "edit_invalid",
    },
  ])(
    "rejects invalid approval edits before writing a resolution ($code)",
    async ({ changed, schema, code }) => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      const { recorder, state } = await createApprovalRun(store, clock);
      await requestApprovalForRun(recorder, clock, state);
      const prepare = vi.fn((call: Parameters<NonNullable<ToolPort["prepare"]>>[0]) =>
        Promise.resolve(call),
      );
      const tool: ToolPort = {
        describe: () => ({
          idempotent: false,
          timeoutMs: 1_000,
          ...(schema === undefined ? {} : { inputSchema: schema }),
        }),
        prepare,
        execute: () => Promise.resolve({ outcome: "ok", result: null }),
      };

      await expect(
        resolveApproval(store, runId, approvalId, "edit", changed, clock, tool),
      ).rejects.toMatchObject({ code });
      const events = await readApprovalEvents(store);
      expect(events.some(({ type }) => type === "approval_resolved")).toBe(false);
      expect(events.some(({ type }) => type === "pii_action")).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    },
  );

  it("rejects missing and repeated approval resolutions", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    await expect(
      resolveApproval(store, runId, approvalId, "approve", undefined, clock),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    const { recorder, state } = await createApprovalRun(store, clock);

    await expect(
      resolveApproval(store, runId, approvalId, "approve", undefined, clock),
    ).rejects.toBeInstanceOf(ApprovalNotFoundError);
    await expect(
      resolveApproval(store, runId, approvalId, "edit", undefined, clock),
    ).rejects.toBeInstanceOf(ApprovalEditsRequiredError);
    await requestApprovalForRun(recorder, clock, state);
    await resolveApproval(store, runId, approvalId, "approve", undefined, clock);
    await expect(
      resolveApproval(store, runId, approvalId, "deny", undefined, clock),
    ).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);
  });

  it("resumes reading a legacy resolution as a human decision", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const { recorder, state } = await createApprovalRun(store, clock);
    await requestApprovalForRun(recorder, clock, state);
    const events = await readApprovalEvents(store);
    const last = events.at(-1);
    if (last === undefined) {
      throw new Error("Expected a suspended approval history.");
    }
    const legacyResolution = Event.parse({
      runId,
      seq: events.length,
      ts: clock.now(),
      v: 1,
      traceId: last.traceId,
      spanId: last.spanId,
      segmentId: last.segmentId,
      type: "approval_resolved",
      approvalId,
      decision: "approve",
      waitMs: 0,
    });
    await store.append(runId, [legacyResolution], events.length);

    const resumedState = foldRunState(await readApprovalEvents(store));
    expect(resumedState.resolvedApprovals.get(approvalId)?.decidedBy).toBe("human");
    await expect(
      resolveApproval(store, runId, approvalId, "deny", undefined, clock),
    ).rejects.toBeInstanceOf(ApprovalAlreadyResolvedError);
  });

  it("rejects concurrent duplicate resolutions without retrying a stale head", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const { recorder, state } = await createApprovalRun(store, clock);
    await requestApprovalForRun(recorder, clock, state);

    const resolutions = await Promise.allSettled([
      resolveApproval(store, runId, approvalId, "approve", undefined, clock),
      resolveApproval(store, runId, approvalId, "deny", undefined, clock),
    ]);

    expect(resolutions.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(
      resolutions.filter(
        (result) =>
          result.status === "rejected" && result.reason instanceof ApprovalAlreadyResolvedError,
      ),
    ).toHaveLength(1);
    expect(
      (await readApprovalEvents(store)).filter(({ type }) => type === "approval_resolved"),
    ).toHaveLength(1);
  });

  it("re-reads and retries after an interleaved append", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const { recorder, state } = await createApprovalRun(store, clock);
    await requestApprovalForRun(recorder, clock, state);
    const append = store.append.bind(store);
    let interleaved = false;
    vi.spyOn(store, "append").mockImplementation(async (appendRunId, events, expectedSeq) => {
      if (!interleaved && events.some(({ type }) => type === "approval_resolved")) {
        interleaved = true;
        const existing = await readApprovalEvents(store);
        const lastEvent = existing.at(-1);
        if (lastEvent === undefined) {
          throw new Error("Expected a suspended run event.");
        }
        await append(
          appendRunId,
          [
            {
              runId: appendRunId,
              ts: clock.now(),
              v: 1,
              traceId: lastEvent.traceId,
              spanId: lastEvent.spanId,
              segmentId: lastEvent.segmentId,
              type: "pii_action",
              boundary: "ui",
              action: "allowed",
              entities: [],
            },
          ],
          expectedSeq,
        );
      }
      return append(appendRunId, events, expectedSeq);
    });

    const resolution = await resolveApproval(store, runId, approvalId, "approve", undefined, clock);

    expect(interleaved).toBe(true);
    expect(resolution).toMatchObject({ type: "approval_resolved", decision: "approve", seq: 7 });
    expect(foldRunState(await readApprovalEvents(store)).status).toBe("suspended");
  });

  it("rejects resolution when the run has failed without appending", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const { recorder, state } = await createApprovalRun(store, clock);
    await requestApprovalForRun(recorder, clock, state);
    await recorder.withStepSpan(RUN_SPAN, {}, async () =>
      recorder
        .recordBatch([
          {
            type: "run_status_changed",
            v: 1,
            from: "suspended",
            to: "running",
            reason: "resumed",
          },
          { type: "run_status_changed", v: 1, from: "running", to: "failed", reason: "failure" },
        ])
        .then((events) => {
          const lastEvent = events.at(-1);
          if (lastEvent === undefined) {
            throw new Error("Expected terminal run status events.");
          }
          return lastEvent;
        }),
    );
    const headBeforeResolve = await store.head(runId);

    await expect(
      resolveApproval(store, runId, approvalId, "approve", undefined, clock),
    ).rejects.toBeInstanceOf(ApprovalRunNotSuspendedError);
    await expect(store.head(runId)).resolves.toBe(headBeforeResolve);
    expect(foldRunState(await readApprovalEvents(store)).status).toBe("failed");
  });

  it.each(["approve", "deny"] as const)(
    "resolves and resumes %s through separate durable SQLite connections",
    async (decision) => {
      const directory = await mkdtemp(join(tmpdir(), "harness-approval-resume-"));
      const databasePath = join(directory, "events.sqlite");
      const clock = new FakeClock(100);
      let openStore: SqliteEventStore | undefined;
      try {
        openStore = new SqliteEventStore(databasePath);
        const { recorder, state } = await createApprovalRun(openStore, clock);
        await requestApprovalForRun(recorder, clock, state);
        await openStore.close();
        openStore = undefined;

        openStore = new SqliteEventStore(databasePath);
        await resolveApproval(openStore, runId, approvalId, decision, undefined, clock);
        await openStore.close();
        openStore = undefined;

        openStore = new SqliteEventStore(databasePath);
        const stored = await readApprovalEvents(openStore);
        const lastEvent = stored.at(-1);
        if (lastEvent === undefined) {
          throw new Error("Expected the durable approval decision.");
        }
        const resumedRecorder = new RunRecorder(
          openStore,
          runId,
          lastEvent.segmentId,
          await openStore.head(runId),
          clock,
        );
        const resumed = await resumedRecorder.withStepSpan(RUN_SPAN, {}, async () =>
          resumedRecorder.record({
            type: "run_status_changed",
            v: 1,
            from: "suspended",
            to: "running",
            reason: "resumed",
          }),
        );
        const resumedState = foldRunState([...stored, resumed]);
        const tool = new FakeToolPort(
          new Map([
            [
              "approval_tool",
              {
                idempotent: false,
                timeoutMs: 1_000,
                execute: () => Promise.resolve({ outcome: "ok", result: { executed: true } }),
              },
            ],
          ]),
        );
        const applied = await applyResolvedApprovals(
          {
            recorder: resumedRecorder,
            tool,
            clock,
            runId,
            signal: new AbortController().signal,
          },
          resumedState,
        );

        expect(applied[0]).toMatchObject({
          type: "tool_result",
          outcome: decision === "approve" ? "ok" : "denied",
          ...(decision === "deny" ? { errorCode: "approval_denied" } : {}),
        });
        expect(tool.calls).toHaveLength(decision === "approve" ? 1 : 0);
      } finally {
        if (openStore !== undefined) {
          await openStore.close();
        }
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe("runLoop", () => {
  it("records cancellation when the startup guard rejects a new run", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const model = new FakeModelPort([completion()]);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);

    const result = await runLoop({
      recorder,
      clock,
      model,
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "guarded run goal",
      signal: new AbortController().signal,
      budgets: defaultBudgets,
      configHash,
      policyVersion: "test.policy",
      shouldContinue: () => Promise.resolve(false),
    });

    expect(result.status).toBe("cancelled");
    expect(model.requests).toHaveLength(0);
    expect(result.events.at(-1)).toMatchObject({
      type: "run_status_changed",
      to: "cancelled",
      reason: "cancel_requested",
    });
  });

  it("respects a terminal event written by the startup guard", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const result = await runLoop({
      recorder,
      clock,
      model: new FakeModelPort([completion()]),
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "terminal guarded run goal",
      signal: new AbortController().signal,
      budgets: defaultBudgets,
      configHash,
      policyVersion: "test.policy",
      shouldContinue: async (events) => {
        events.push(
          await recorder.record({
            type: "run_status_changed",
            v: 1,
            from: "running",
            to: "cancelled",
            reason: "cancel_requested",
          }),
        );
        return false;
      },
    });

    expect(result.status).toBe("cancelled");
    expect(result.events.at(-1)).toMatchObject({
      type: "run_status_changed",
      to: "cancelled",
      reason: "cancel_requested",
    });
  });

  it("rejects an empty initial event batch", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    vi.spyOn(recorder, "recordBatch").mockResolvedValue([]);

    await expect(
      runLoop({
        recorder,
        clock,
        model: new FakeModelPort([completion()]),
        tool: new FakeToolPort(),
        context: new NaiveContext(),
        ids: new SequentialIdGenerator(),
        goal: "empty startup batch goal",
        signal: new AbortController().signal,
        budgets: defaultBudgets,
        configHash,
        policyVersion: "test.policy",
      }),
    ).rejects.toThrow("Expected run creation events.");
  });

  it("drains a concurrent sentinel trip into the run log without exposing its canary", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const tripQueue = new TripQueue({ emit: vi.fn(), enabled: () => true });
    const append = store.append.bind(store);
    let enqueued = false;
    vi.spyOn(store, "append").mockImplementation(async (requestedRunId, partials, expectedSeq) => {
      if (!enqueued && partials.some(({ type }) => type === "model_request")) {
        enqueued = true;
        tripQueue.enqueue({
          runId: Id.parse(runId),
          entities: [{ type: "email", count: 1 }],
        });
      }
      return append(requestedRunId, partials, expectedSeq);
    });

    const result = await runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock, tripQueue),
      clock,
      model: new FakeModelPort([completion()]),
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "synthetic run goal",
      signal: new AbortController().signal,
      budgets: defaultBudgets,
      configHash,
      policyVersion: "test.policy",
    });
    const trips = result.events.filter((event) => event.type === "pii_action");

    expect(trips).toHaveLength(1);
    expect(trips[0]).toMatchObject({
      boundary: "telemetry_export",
      action: "blocked",
      entities: [{ type: "email", count: 1 }],
    });
    expect(JSON.stringify(trips)).not.toContain("synthetic run goal");
    expect(result.status).toBe("completed");
    expect(result.events.map(({ seq }) => seq)).toEqual(result.events.map((_, index) => index));
  });

  it("compacts before making the next model call", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const summarize = vi.fn<Summarizer["summarize"]>(({ groups, goal }) =>
      Promise.resolve({
        text: `summary of ${goal}: ${String(groups.length)}`,
        usage: { inputTokens: 5, outputTokens: 2, costMicros: 20 },
      }),
    );
    const summarizer: Summarizer = { summarize };
    const model = new FakeModelPort([
      completion([{ callId: modelCallId, toolId: "lookup", args: { query: "x" } }]),
      completion(),
    ]);
    const tool = new FakeToolPort(
      new Map([
        [
          "lookup",
          {
            idempotent: true,
            timeoutMs: 100,
            execute: () => Promise.resolve({ outcome: "ok", result: { value: "found" } }),
          },
        ],
      ]),
    );

    const result = await runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock),
      clock,
      model,
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "compaction loop goal",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
      compaction: {
        strategy: new SummarizingStrategy({ provider: "test_provider", model: "test_model" }),
        summarizer,
        budget: { maxTokens: 1, reserveOutputTokens: 0 },
        counter: { count: () => 100 },
        sanitizeSummary: (text) => Promise.resolve(text),
        keepRecentGroups: 0,
      },
    });

    const compactedIndex = result.events.findIndex((event) => event.type === "context_compacted");
    const secondRequestId = model.requests[1]?.request.requestId;
    const secondRequestIndex = result.events.findIndex(
      (event) => event.type === "model_request" && event.requestId === secondRequestId,
    );

    expect(result.status).toBe("completed");
    expect(result.state.usage).toEqual({ inputTokens: 11, outputTokens: 12, costMicros: 44 });
    expect(summarize).toHaveBeenCalledOnce();
    expect(compactedIndex).toBeGreaterThan(-1);
    expect(compactedIndex).toBeLessThan(secondRequestIndex);
    expect(
      model.requests[1]?.request.messages.some((message) =>
        message.parts.some(
          (part) => part.type === "text" && part.text.startsWith("Summary of earlier work:"),
        ),
      ),
    ).toBe(true);
  });

  it("checks compaction usage against the run cost budget before requesting the model", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const summarize = vi.fn<Summarizer["summarize"]>(() =>
      Promise.resolve({
        text: "summary",
        usage: { inputTokens: 4, outputTokens: 2, costMicros: 1 },
      }),
    );
    const model = new FakeModelPort([
      completion([{ callId: modelCallId, toolId: "lookup", args: { query: "x" } }]),
    ]);
    const tool = new FakeToolPort(
      new Map([
        [
          "lookup",
          {
            idempotent: true,
            timeoutMs: 100,
            execute: () => Promise.resolve({ outcome: "ok", result: { value: "found" } }),
          },
        ],
      ]),
    );

    const result = await runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock),
      clock,
      model,
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "budget compaction",
      configHash,
      budgets: { ...defaultBudgets, maxCostUsd: 0.000012 },
      policyVersion: "test.policy",
      signal: new AbortController().signal,
      compaction: {
        strategy: new SummarizingStrategy({ provider: "test_provider", model: "test_model" }),
        summarizer: { summarize },
        budget: { maxTokens: 1, reserveOutputTokens: 0 },
        counter: { count: () => 100 },
        sanitizeSummary: (text) => Promise.resolve(text),
        keepRecentGroups: 0,
      },
    });

    expect(result.status).toBe("failed");
    expect(model.requests).toHaveLength(1);
    expect(summarize).toHaveBeenCalledOnce();
    expect(result.state.usage).toEqual({ inputTokens: 7, outputTokens: 7, costMicros: 13 });
    expect(result.events).toContainEqual(
      expect.objectContaining({ type: "budget_exceeded", budget: "cost", observed: 13 }),
    );
  });

  it("does not call the summarizer after the model-step preflight exceeds its budget", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const summarize = vi.fn<Summarizer["summarize"]>(() =>
      Promise.resolve({ text: "unused", usage: { inputTokens: 0, outputTokens: 0 } }),
    );
    const model = new FakeModelPort([
      completion([{ callId: modelCallId, toolId: "lookup", args: { query: "x" } }]),
    ]);
    const tool = new FakeToolPort(
      new Map([
        [
          "lookup",
          {
            idempotent: true,
            timeoutMs: 100,
            execute: () => Promise.resolve({ outcome: "ok", result: { value: "found" } }),
          },
        ],
      ]),
    );

    const result = await runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock),
      clock,
      model,
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "step budget",
      configHash,
      budgets: { ...defaultBudgets, maxSteps: 1 },
      policyVersion: "test.policy",
      signal: new AbortController().signal,
      compaction: {
        strategy: new SummarizingStrategy({ provider: "test_provider", model: "test_model" }),
        summarizer: { summarize },
        budget: { maxTokens: 1, reserveOutputTokens: 0 },
        counter: { count: () => 100 },
        sanitizeSummary: (text) => Promise.resolve(text),
        keepRecentGroups: 0,
      },
    });

    expect(result.status).toBe("failed");
    expect(model.requests).toHaveLength(1);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("continues with the model when summarization fails", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const summarize = vi.fn<Summarizer["summarize"]>(() =>
      Promise.reject(new Error("provider unavailable")),
    );
    const model = new FakeModelPort([
      completion([{ callId: modelCallId, toolId: "lookup", args: { query: "x" } }]),
      completion(),
    ]);
    const tool = new FakeToolPort(
      new Map([
        [
          "lookup",
          {
            idempotent: true,
            timeoutMs: 100,
            execute: () => Promise.resolve({ outcome: "ok", result: { value: "found" } }),
          },
        ],
      ]),
    );

    const result = await runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock),
      clock,
      model,
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "fallback after compaction failure",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
      compaction: {
        strategy: new SummarizingStrategy({ provider: "test_provider", model: "test_model" }),
        summarizer: { summarize },
        budget: { maxTokens: 1, reserveOutputTokens: 0 },
        counter: { count: () => 100 },
        sanitizeSummary: (text) => Promise.resolve(text),
        keepRecentGroups: 0,
      },
    });

    expect(result.status).toBe("completed");
    expect(model.requests).toHaveLength(2);
    expect(summarize).toHaveBeenCalledOnce();
    expect(result.events.some((event) => event.type === "context_compacted")).toBe(false);
  });

  it.each([
    ["SIGTERM", "SIGTERM"],
    ["SIGTERM", "SIGINT"],
  ] as const)(
    "suspends and resumes after %s then %s interrupts a model call",
    async (firstSignal, repeat) => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      const controller = new AbortController();
      const processLike = new FakeShutdownProcess();
      let modelStarted: () => void = () => undefined;
      const started = new Promise<void>((resolve) => {
        modelStarted = resolve;
      });
      const model: ModelPort = {
        complete: async (_request, runContext: RunContext) => {
          modelStarted();
          return new Promise<ModelCompletion>((resolve, reject) => {
            runContext.signal.addEventListener(
              "abort",
              () => {
                reject(new Error("model call aborted"));
              },
              { once: true },
            );
          });
        },
      };
      const uninstall = installShutdownHandler({
        processLike,
        controller,
        graceMs: 60_000,
        onTimeout: () => undefined,
      });
      const running = runLoop({
        recorder: new RunRecorder(store, runId, segmentId, 0, clock),
        clock,
        model,
        tool: new FakeToolPort(),
        context: new NaiveContext(),
        ids: new SequentialIdGenerator(),
        goal: "shutdown during model call",
        configHash,
        budgets: defaultBudgets,
        policyVersion: "test.policy",
        signal: controller.signal,
      });

      await started;
      processLike.emit(firstSignal);
      processLike.emit(repeat);
      const result = await running;
      uninstall();

      expect(result.status).toBe("suspended");
      expect(result.events.map(({ type }) => type)).toEqual([
        "run_created",
        "run_input",
        "run_status_changed",
        "model_request",
        "run_status_changed",
        "checkpoint_written",
      ]);
      expect(processLike.exitCode).toBe(143);
      expect(processLike.forcedTerminations).toEqual([]);

      const resumed = await resumeRun(
        createResumeOptions(store, clock, { model: new FakeModelPort([completion()]) }),
      );
      expect(resumed.status).toBe("completed");
    },
  );

  it("suspends and checkpoints when shutdown aborts a resumed tool rerun", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const controller = new AbortController();
    const processLike = new FakeShutdownProcess();
    await createRunHistory(store, clock, [
      {
        type: "tool_intent",
        v: 1,
        callId: modelCallId,
        toolId: "idempotent_tool",
        idempotent: true,
        policyDecision: "allow",
        argsHash: "a".repeat(64),
        args: { value: 1 },
      },
    ]);
    let toolStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const tool = new FakeToolPort(
      new Map([
        [
          "idempotent_tool",
          {
            idempotent: true,
            timeoutMs: 60_000,
            execute: (_call, { signal }) =>
              new Promise<ToolExecutionResult>((_resolve, reject) => {
                toolStarted();
                signal.addEventListener(
                  "abort",
                  () => {
                    reject(new Error("tool aborted"));
                  },
                  { once: true },
                );
              }),
          },
        ],
      ]),
    );
    const uninstall = installShutdownHandler({
      processLike,
      controller,
      graceMs: 60_000,
      onTimeout: () => undefined,
    });

    try {
      const resuming = resumeRun(
        createResumeOptions(store, clock, { tool, signal: controller.signal }),
      );
      await started;
      processLike.emit("SIGTERM");
      const result = await resuming;
      const stored = await readApprovalEvents(store);

      expect(result.status).toBe("suspended");
      expect(result.events.map(({ type }) => type)).toContain("checkpoint_written");
      expect(stored.filter(({ type }) => type === "tool_intent")).toHaveLength(1);
      expect(stored.filter(({ type }) => type === "tool_result")).toHaveLength(0);
      expect(processLike.exitCode).toBe(143);
      expect(processLike.forcedTerminations).toEqual([]);
    } finally {
      uninstall();
    }
  });

  it("leaves a dangling tool intent when SIGINT aborts tool execution", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const controller = new AbortController();
    const processLike = new FakeShutdownProcess();
    let toolStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const call = { callId: modelCallId, toolId: "slow_tool", args: {} };
    const tool = new FakeToolPort(
      new Map([
        [
          "slow_tool",
          {
            idempotent: false,
            timeoutMs: 60_000,
            execute: (_call: ModelToolCall, { signal }: RunContext) => {
              toolStarted();
              return new Promise<ToolExecutionResult>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    reject(new Error("tool call aborted"));
                  },
                  { once: true },
                );
              });
            },
          },
        ],
      ]),
    );
    const uninstall = installShutdownHandler({
      processLike,
      controller,
      graceMs: 60_000,
      onTimeout: () => undefined,
    });
    const running = runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([completion([call])]),
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "shutdown during tool call",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: controller.signal,
    });

    await started;
    processLike.emit("SIGINT");
    const result = await running;
    uninstall();

    expect(result.status).toBe("suspended");
    expect(result.events.map(({ type }) => type)).toContain("tool_intent");
    expect(result.events.map(({ type }) => type)).not.toContain("tool_result");
    expect(processLike.exitCode).toBe(130);
  });

  it("completes a scripted one-step run with a deterministic golden event sequence", async () => {
    const startingSpanIndex = tracerProvider.spans.length;
    const store = new InMemoryEventStore();
    const append = vi.spyOn(store, "append");
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const ids = new SequentialIdGenerator();
    const signal = new AbortController().signal;
    const model = new FakeModelPort([completion()]);
    const complete = model.complete.bind(model);
    vi.spyOn(model, "complete").mockImplementation(async (request, callContext) => {
      const durableTypes: string[] = [];
      for await (const event of store.read(runId)) {
        durableTypes.push(event.type);
      }
      expect(durableTypes.at(-1)).toBe("model_request");
      return complete(request, callContext);
    });

    const contextPort = new NaiveContext();
    const build = vi.spyOn(contextPort, "build");
    const result = await runLoop({
      recorder,
      clock,
      model,
      tool: {
        describe: () => undefined,
        execute: () => Promise.resolve({ outcome: "ok", result: null }),
        getToolSpecs: () => [
          {
            toolId: "read_offloaded",
            description: "Read a page of a large tool result stored in the run workspace.",
            inputSchema: { type: "object" },
          },
        ],
      },
      context: contextPort,
      ids,
      goal: "test goal",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal,
      role: "assistant",
      provider: "test_provider",
      modelName: "test_model",
    });

    expect(result.status).toBe("completed");
    expect(result.approvalIds).toEqual([]);
    expect(result.state.status).toBe("completed");
    expect(result.state.steps).toBe(1);
    expect(result.state.usage).toEqual({ inputTokens: 3, outputTokens: 5, costMicros: 12 });
    expect(result.events.map(({ type }) => type)).toEqual([
      "run_created",
      "run_input",
      "run_status_changed",
      "model_request",
      "model_response",
      "run_status_changed",
    ]);
    expect(build).toHaveBeenCalledWith(result.events.slice(0, 3));
    expect(append.mock.calls.map(([, , expectedSeq]) => expectedSeq)).toEqual([0, 3, 4, 5]);
    const capturedRequest = model.requests[0];
    expect(capturedRequest?.request).toEqual({
      requestId: "00000000000000000000000000",
      model: { provider: "test_provider", model: "test_model" },
      messages: [{ role: "user", parts: [{ type: "text", text: "test goal" }] }],
      stablePrefixMessages: 1,
      tools: [
        {
          toolId: "read_offloaded",
          description: "Read a page of a large tool result stored in the run workspace.",
          inputSchema: { type: "object" },
        },
      ],
      role: "assistant",
    });
    expect(capturedRequest?.context).toMatchObject({ runId, signal, deadlineTs: 3_600_100 });
    expect(typeof capturedRequest?.context.recordPiiAction).toBe("function");
    expect(capturedRequest?.context.recordVaultAudit).toBeUndefined();
    expect(capturedRequest?.context.recordSubagentSpawned).toBeUndefined();
    expect(await store.head(runId)).toBe(6);
    const spans = tracerProvider.spans.slice(startingSpanIndex);
    const runSpans = spans.filter(({ name }) => name === "harness.run");
    const modelSpans = spans.filter(({ name }) => name === "harness.model_call");
    expect(runSpans).toHaveLength(1);
    expect(modelSpans).toHaveLength(1);
    expect(modelSpans[0]?.parentSpanId).toBe(runSpans[0]?.spanContextValue.spanId);
    expect(modelSpans[0]?.attributes).toMatchObject({
      "harness.context.strategy": "naive",
      "harness.context.strategy_version": "v6",
      "harness.context.estimated_tokens": 0,
      "harness.context.message_count": 1,
    });
    expect(runSpans[0]?.attributes["harness.event.seq"]).toBe(5);

    const actual = `${JSON.stringify(normalizeEvents(result.events), null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === "1") {
      await writeFile(goldenPath, actual);
    }
    const goldenInput: unknown = JSON.parse(await readFile(goldenPath, "utf8"));
    expect(JsonValue.parse(goldenInput)).toEqual(normalizeEvents(result.events));
  });

  it("writes a traceparent checkpoint at the configured event cadence", async () => {
    const startingSpanIndex = tracerProvider.spans.length;
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const result = await runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([completion()]),
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "checkpoint cadence",
      configHash,
      budgets: defaultBudgets,
      checkpointEveryEvents: 4,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    const checkpoint = result.events.find(
      (event): event is Extract<Event, { type: "checkpoint_written" }> =>
        event.type === "checkpoint_written",
    );
    expect(checkpoint).toBeDefined();
    if (checkpoint === undefined) {
      throw new Error("Expected a checkpoint event.");
    }
    expect(checkpoint.atSeq).toBe(checkpoint.seq);
    const traceparent = Traceparent.parse(checkpoint.traceparent);
    expect(checkpoint).toMatchObject({
      traceId: traceparent.slice(3, 35),
      spanId: traceparent.slice(36, 52),
    });
    await expect(store.latestSnapshot(runId)).resolves.toMatchObject({
      snapshotId: checkpoint.checkpointId,
      runId,
      atSeq: checkpoint.seq,
      traceparent,
      context: {
        strategyId: "naive",
        strategyVersion: "v6",
        calibration: null,
      },
      plan: null,
    });
    expect(result.events.map(({ type }) => type)).toEqual([
      "run_created",
      "run_input",
      "run_status_changed",
      "model_request",
      "model_response",
      "checkpoint_written",
      "run_status_changed",
    ]);
    const checkpointSpan = tracerProvider.spans
      .slice(startingSpanIndex)
      .find(({ name }) => name === "harness.checkpoint");
    expect(checkpointSpan?.attributes["harness.event.seq"]).toBe(checkpoint.seq);
    expect(checkpointSpan?.attributes["harness.checkpoint.reason"]).toBe("cadence");
  });

  it("calibrates after a model response and restores calibration when resumed", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const controller = new AbortController();
    const modelRef = { provider: "test_provider", model: "test_model" };
    const resumeToolCall = { callId: modelCallId, toolId: "resume_tool", args: {} };
    const tool = new FakeToolPort(
      new Map([
        [
          "resume_tool",
          {
            idempotent: true,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: null }),
          },
        ],
      ]),
    );
    const counter = new CalibratingTokenCounter(new HeuristicTokenCounter());
    const contextPort = new StrategyContextPort(new NaiveStrategy(), {
      budget: { maxTokens: 1_000, reserveOutputTokens: 100 },
      model: modelRef,
      counter,
    });
    const initialModel: ModelPort = {
      complete: () => {
        controller.abort("shutdown");
        return Promise.resolve({
          ...completion([resumeToolCall]),
          usage: { inputTokens: 150, outputTokens: 5 },
        });
      },
    };
    const suspended = await runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock),
      clock,
      model: initialModel,
      tool,
      context: contextPort,
      ids: new SequentialIdGenerator(),
      goal: "calibration resume",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: controller.signal,
    });

    expect(suspended.status).toBe("suspended");
    const savedSnapshot = await store.latestSnapshot(runId);
    const savedCalibration = counter.snapshot();
    expect(savedSnapshot?.context).toMatchObject({ calibration: savedCalibration });
    expect(savedCalibration[0]?.ratio).toBeGreaterThan(1);

    const resumedCounter = new CalibratingTokenCounter(new HeuristicTokenCounter());
    const resumedContext = new StrategyContextPort(new NaiveStrategy(), {
      budget: { maxTokens: 1_000, reserveOutputTokens: 100 },
      model: modelRef,
      counter: resumedCounter,
    });
    let calibrationAtResume: ReturnType<typeof resumedCounter.snapshot> = [];
    const resumedModel: ModelPort = {
      complete: () => {
        calibrationAtResume = resumedCounter.snapshot();
        return Promise.resolve(completion());
      },
    };
    const resumed = await resumeRun(
      createResumeOptions(store, clock, {
        context: resumedContext,
        model: resumedModel,
        tool,
      }),
    );

    expect(resumed.status).toBe("completed");
    expect(calibrationAtResume).toEqual(savedCalibration);
  });

  it("keeps suspended runs registered through resume until completion", async () => {
    const lifecycleRunId = Id.parse("66666666666666666666666666");
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const controller = new AbortController();
    const model: ModelPort = {
      complete: () => {
        controller.abort("shutdown");
        return Promise.resolve(completion());
      },
    };

    const suspended = await runLoop({
      recorder: new RunRecorder(store, lifecycleRunId, segmentId, 0, clock),
      clock,
      model,
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "retain suspended run",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: controller.signal,
    });

    expect(suspended.status).toBe("suspended");
    expect(activeRuns.runIds()).toContain(lifecycleRunId);

    const resumed = await resumeRun(createResumeOptions(store, clock, { runId: lifecycleRunId }));

    expect(resumed.status).toBe("completed");
    expect(activeRuns.runIds()).toContain(lifecycleRunId);
  });

  it("forces a checkpoint when the run is suspended before the cadence", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    let events: Event[] = [];
    await recorder.withStepSpan(RUN_SPAN, {}, async () => {
      events = await recorder.recordBatch([
        { type: "run_created", v: 1, configHash, policyVersion: "test.policy" },
        { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
        { type: "run_status_changed", v: 1, from: "running", to: "suspended", reason: "shutdown" },
      ]);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected a suspension status event.");
      }
      return last;
    });
    const state = foldRunState(events);
    const checkpointer = new Checkpointer({
      recorder,
      runId,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      clock,
      checkpointEveryEvents: 20,
    });

    const checkpoint = await checkpointer.maybeCheckpoint(state);

    expect(state.status).toBe("suspended");
    expect(checkpoint).toMatchObject({ type: "checkpoint_written", seq: 3, atSeq: 3 });
    await expect(store.latestSnapshot(runId)).resolves.toMatchObject({ atSeq: 3 });

    if (checkpoint === undefined) {
      throw new Error("Expected a checkpoint event.");
    }
    const stateAfterCheckpoint = foldRunState([...events, checkpoint]);
    await expect(checkpointer.maybeCheckpoint(stateAfterCheckpoint)).resolves.toBeUndefined();
    const storedEvents: Event[] = [];
    for await (const event of store.read(runId)) {
      storedEvents.push(event);
    }
    expect(storedEvents.filter(({ type }) => type === "checkpoint_written")).toHaveLength(1);
  });

  it("checks cadence across multi-event steps and resets after a checkpoint", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    let events: Event[] = [];
    await recorder.withStepSpan(RUN_SPAN, {}, async () => {
      events = await recorder.recordBatch([
        { type: "run_created", v: 1, configHash, policyVersion: "test.policy" },
        { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
      ]);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error("Expected a running status event.");
      }
      return last;
    });
    const checkpointer = new Checkpointer({
      recorder,
      runId,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      clock,
      checkpointEveryEvents: 20,
    });
    const firstCheckpoint = await checkpointer.write(foldRunState(events), "cadence");
    const stateAfterCheckpoint = foldRunState([...events, firstCheckpoint]);
    const lastCheckpoint = stateAfterCheckpoint.lastCheckpoint;
    if (lastCheckpoint === undefined) {
      throw new Error("Expected the written checkpoint in run state.");
    }
    const write = vi.spyOn(checkpointer, "write").mockResolvedValue(firstCheckpoint);

    await expect(
      checkpointer.maybeCheckpoint({
        ...stateAfterCheckpoint,
        nextSeq: lastCheckpoint.atSeq + 1 + 19,
      }),
    ).resolves.toBeUndefined();
    await checkpointer.maybeCheckpoint({
      ...stateAfterCheckpoint,
      nextSeq: lastCheckpoint.atSeq + 1 + 21,
    });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenLastCalledWith(
      { ...stateAfterCheckpoint, nextSeq: lastCheckpoint.atSeq + 1 + 21 },
      "cadence",
    );

    write.mockClear();
    await expect(
      checkpointer.maybeCheckpoint({
        ...stateAfterCheckpoint,
        nextSeq: lastCheckpoint.atSeq + 1 + 19,
      }),
    ).resolves.toBeUndefined();
    expect(write).not.toHaveBeenCalled();
    await checkpointer.maybeCheckpoint({
      ...stateAfterCheckpoint,
      nextSeq: lastCheckpoint.atSeq + 1 + 20,
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("leaves neither checkpoint event nor snapshot when the atomic append conflicts", async () => {
    const store = new InMemoryEventStore();
    const recorder = new RunRecorder(store, runId, segmentId, 0, new FakeClock(100));
    vi.spyOn(store, "appendWithSnapshot").mockRejectedValue(new SeqConflictError(4, 5));

    await expect(
      runLoop({
        recorder,
        clock: new FakeClock(100),
        model: new FakeModelPort([completion()]),
        tool: new FakeToolPort(),
        context: new NaiveContext(),
        ids: new SequentialIdGenerator(),
        goal: "checkpoint conflict",
        configHash,
        budgets: defaultBudgets,
        checkpointEveryEvents: 4,
        policyVersion: "test.policy",
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });

    const storedEvents: Event[] = [];
    for await (const event of store.read(runId)) {
      storedEvents.push(event);
    }
    expect(storedEvents).toHaveLength(5);
    expect(storedEvents.some(({ type }) => type === "checkpoint_written")).toBe(false);
    await expect(store.latestSnapshot(runId)).resolves.toBeUndefined();
    expect(recorder.nextSeq).toBe(5);
  });

  it("rejects a checkpoint whose active span context is invalid", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const result = await runLoop({
      recorder,
      clock,
      model: new FakeModelPort([completion()]),
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "invalid checkpoint span",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });
    const checkpointer = new Checkpointer({
      recorder,
      runId,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      clock,
    });
    invalidSpanContext = true;
    try {
      await expect(checkpointer.write(result.state, "manual")).rejects.toMatchObject({
        code: "no_active_span",
      });
    } finally {
      invalidSpanContext = false;
    }
  });

  it("durably records tool intent and feeds tool results into the next model request", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(store, runId, segmentId, 0, clock);
    const signal = new AbortController().signal;
    let intentWasDurable = false;
    const call = {
      callId: modelCallId,
      toolId: "test_tool",
      args: { z: 1, a: { z: 2, a: 3 } },
    };
    const tool = new FakeToolPort(
      new Map([
        [
          "test_tool",
          {
            idempotent: true,
            timeoutMs: 1000,
            execute: async () => {
              const types: string[] = [];
              for await (const event of store.read(runId)) {
                types.push(event.type);
              }
              intentWasDurable = types.at(-1) === "tool_intent";
              expect(intentWasDurable).toBe(true);
              clock.advance(7);
              return { outcome: "ok", result: { value: "tool output" } };
            },
          },
        ],
      ]),
    );
    const model = new FakeModelPort([
      completion([call], "tool request"),
      completion([], "final answer"),
    ]);
    const result = await runLoop({
      recorder,
      clock,
      model,
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "tool goal",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal,
    });

    expect(intentWasDurable).toBe(true);
    expect(result.state.status).toBe("completed");
    expect(result.events.map(({ type }) => type)).toEqual([
      "run_created",
      "run_input",
      "run_status_changed",
      "model_request",
      "model_response",
      "tool_intent",
      "tool_result",
      "model_request",
      "model_response",
      "run_status_changed",
    ]);
    expect(result.events.find(({ type }) => type === "tool_result")).toMatchObject({
      outcome: "ok",
      result: { value: "tool output" },
      latencyMs: 7,
    });
    expect(result.events.find(({ type }) => type === "tool_intent")).toMatchObject({
      argsHash: "e634af6ecfc23845fdae9c393661c63b99ad304d3f05a08faab28727c785d718",
    });
    expect(model.requests[1]?.request.messages).toEqual([
      { role: "user", parts: [{ type: "text", text: "tool goal" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "tool request" },
          { type: "tool_call", callId: modelCallId, toolId: "test_tool", args: call.args },
        ],
      },
      {
        role: "tool",
        parts: [
          {
            type: "tool_result",
            callId: modelCallId,
            result: { value: "tool output" },
            isError: false,
          },
        ],
      },
    ]);
    expect(tool.calls).toHaveLength(1);
  });

  it("stops before the next model call when the run is aborted", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const controller = new AbortController();
    let toolResults = 0;
    const append = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation(
      async (appendedRunId, appendedEvents, expectedSeq) => {
        const result = await append(appendedRunId, appendedEvents, expectedSeq);
        if (appendedEvents.some(({ type }) => type === "tool_result")) {
          toolResults += 1;
          if (toolResults === 3) {
            controller.abort();
          }
        }
        return result;
      },
    );
    const call = { callId: modelCallId, toolId: "repeating_tool", args: {} };
    const complete = vi.fn(() => Promise.resolve(completion([call])));
    const model: ModelPort = {
      complete,
    };
    const tool = new FakeToolPort(
      new Map([
        [
          "repeating_tool",
          {
            idempotent: true,
            timeoutMs: 1000,
            execute: () => Promise.resolve({ outcome: "ok", result: null }),
          },
        ],
      ]),
    );
    const contextPort = {
      build: vi.fn(() =>
        Promise.resolve({
          messages: [],
          metadata: {
            strategyId: "naive",
            strategyVersion: "v4",
            estimatedTokens: 0,
            messageCount: 0,
            stablePrefixMessages: 0,
          },
        }),
      ),
      snapshot: vi.fn(() => Promise.resolve([])),
      restore: vi.fn(() => Promise.resolve()),
    };

    await expect(
      runLoop({
        recorder: new RunRecorder(store, runId, segmentId, 0, clock),
        clock,
        model,
        tool,
        context: contextPort,
        ids: new SequentialIdGenerator(),
        goal: "abort after three tool calls",
        configHash,
        budgets: defaultBudgets,
        policyVersion: "test.policy",
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "run_aborted" });

    const recordedTypes: string[] = [];
    for await (const event of store.read(runId)) {
      recordedTypes.push(event.type);
    }
    expect(recordedTypes).toEqual([
      "run_created",
      "run_input",
      "run_status_changed",
      "model_request",
      "model_response",
      "tool_intent",
      "tool_result",
      "model_request",
      "model_response",
      "tool_intent",
      "tool_result",
      "model_request",
      "model_response",
      "tool_intent",
      "tool_result",
    ]);
    expect(complete).toHaveBeenCalledTimes(3);
    expect(tool.calls).toHaveLength(3);
    expect(contextPort.build).toHaveBeenCalledTimes(3);
    expect(await store.head(runId)).toBe(recordedTypes.length);
  });

  it("denies unknown tools without executing them", async () => {
    const clock = new FakeClock(100);
    const tool = new FakeToolPort();
    const result = await runLoop({
      recorder: new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([
        completion([{ callId: modelCallId, toolId: "unknown_tool", args: {} }]),
        completion(),
      ]),
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "unknown tool goal",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("completed");
    expect(tool.calls).toEqual([]);
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_intent",
        toolId: UNREGISTERED_TOOL_ID,
        idempotent: false,
        policyDecision: "deny",
      }),
    );
    expect(result.events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        toolId: UNREGISTERED_TOOL_ID,
        outcome: "denied",
        errorCode: "unknown_tool",
      }),
    );
    const response = result.events.find((event) => event.type === "model_response");
    const responseToolIds =
      response?.type === "model_response"
        ? response.content.flatMap((part) => (part.type === "tool_call" ? [part.toolId] : []))
        : [];
    expect(responseToolIds).toEqual([UNREGISTERED_TOOL_ID]);
  });

  it("suspends an ask decision durably and executes only after approval on resume", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const tool = new FakeToolPort(
      new Map([
        [
          "reviewed_tool",
          {
            idempotent: false,
            timeoutMs: 1_000,
            execute: () => Promise.resolve({ outcome: "ok", result: { completed: true } }),
          },
        ],
      ]),
    );
    const policy: PolicyPort = {
      version: "test.policy",
      decide: () => ({
        decision: "ask",
        ruleId: "review_rule",
        reason: "human_review",
        editable: [],
      }),
    };
    const first = await runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([
        completion([{ callId: modelCallId, toolId: "reviewed_tool", args: { path: "<PATH_1>" } }]),
      ]),
      tool,
      policy,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "request approval",
      configHash,
      budgets: defaultBudgets,
      policyVersion: policy.version,
      signal: new AbortController().signal,
    });
    const approval = first.state.pendingApprovals.values().next().value;

    expect(first.status).toBe("suspended");
    expect(tool.calls).toHaveLength(0);
    expect(first.events).toContainEqual(
      expect.objectContaining({
        type: "tool_intent",
        policyDecision: "ask",
        ruleId: "review_rule",
      }),
    );
    expect(approval).toBeDefined();
    if (approval === undefined) {
      throw new Error("Expected the policy approval.");
    }
    await resolveApproval(store, runId, approval.approvalId, "approve", undefined, clock);

    const resumed = await resumeRun(
      createResumeOptions(store, clock, {
        model: new FakeModelPort([completion()]),
        tool,
        policy,
      }),
    );
    const stored = await readApprovalEvents(store);

    expect(resumed.status).toBe("completed");
    expect(tool.calls.map(({ call }) => call.callId)).toEqual([modelCallId]);
    expect(stored.filter((event) => event.type === "tool_intent")).toHaveLength(1);
    expect(stored.find((event) => event.type === "tool_intent")).toMatchObject({
      policyDecision: "ask",
      ruleId: "review_rule",
    });
  });

  it("applies an expired approval as a denial when the run resumes", async () => {
    const store = new InMemoryEventStore();
    const clock = new FakeClock(100);
    const { recorder, state } = await createApprovalRun(store, clock);
    await requestApprovalForRun(recorder, clock, state, 10);
    clock.advance(10);

    const sweepStore: ApprovalSweepStore = {
      listRuns: (options) => store.listRuns(options),
      read: (forRun) => store.read(forRun),
      claimApprovalNotification: (forApproval, forRun, claimedAt, leaseMs) =>
        store.claimApprovalNotification(forApproval, forRun, claimedAt, leaseMs),
      markApprovalNotificationSent: (forApproval, forRun, claimedAt, sentAt) =>
        store.markApprovalNotificationSent(forApproval, forRun, claimedAt, sentAt),
      releaseApprovalNotification: (forApproval, forRun, claimedAt) =>
        store.releaseApprovalNotification(forApproval, forRun, claimedAt),
      resolveApproval: (forRun, forApproval, metadata) =>
        resolveApproval(store, forRun, forApproval, "deny", undefined, clock, undefined, metadata),
    };
    const sweepResult = await sweepApprovals({
      store: sweepStore,
      clock,
      notifier: { notify: () => Promise.resolve() },
    });
    const tool = new FakeToolPort();
    const resumed = await resumeRun(
      createResumeOptions(store, clock, {
        model: new FakeModelPort([completion()]),
        tool,
      }),
    );
    const events = await readApprovalEvents(store);

    expect(sweepResult).toMatchObject({ examined: 1, expired: 1 });
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "approval_resolved",
        approvalId,
        decision: "deny",
        decidedBy: "expiry",
        reason: "expired",
      }),
    );
    expect(resumed.status).toBe("completed");
    expect(tool.calls).toHaveLength(0);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "tool_result",
        outcome: "denied",
        errorCode: "approval_denied",
      }),
    );
  });

  it("records timeouts and allows the model to continue", async () => {
    const clock = new FakeClock(100);
    let executionStopped = false;
    const tool = new FakeToolPort(
      new Map([
        [
          "slow_tool",
          {
            idempotent: false,
            timeoutMs: 1,
            execute: (_call, { signal }) =>
              new Promise<never>((_resolve, reject) => {
                signal.addEventListener(
                  "abort",
                  () => {
                    executionStopped = true;
                    reject(new Error("Aborted."));
                  },
                  { once: true },
                );
              }),
          },
        ],
      ]),
    );
    const result = await runLoop({
      recorder: new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([
        completion([{ callId: modelCallId, toolId: "slow_tool", args: {} }]),
        completion(),
      ]),
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "timeout goal",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("completed");
    expect(executionStopped).toBe(true);
    const toolResult = result.events.find(
      (event): event is Extract<Event, { type: "tool_result" }> => event.type === "tool_result",
    );
    expect(toolResult).toMatchObject({
      outcome: "timeout",
      errorCode: "tool_timeout",
      result: null,
    });
    expect(toolResult?.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("maps returned tool errors and thrown errors to stable result codes", async () => {
    const clock = new FakeClock(100);
    const tool = new FakeToolPort(
      new Map([
        [
          "returned_error",
          {
            idempotent: true,
            timeoutMs: 1000,
            execute: () =>
              Promise.resolve({
                outcome: "error",
                errorCode: "tool_rejected",
                result: { reason: "rejected" },
              }),
          },
        ],
        [
          "harness_error",
          {
            idempotent: true,
            timeoutMs: 1000,
            execute: () => Promise.reject(new TestToolError()),
          },
        ],
        [
          "unknown_error",
          {
            idempotent: true,
            timeoutMs: 1000,
            execute: () => Promise.reject(new Error("Synthetic failure.")),
          },
        ],
      ]),
    );
    const result = await runLoop({
      recorder: new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([
        completion([
          { callId: modelCallId, toolId: "returned_error", args: {} },
          { callId: "33333333333333333333333333", toolId: "harness_error", args: {} },
          { callId: "44444444444444444444444444", toolId: "unknown_error", args: {} },
        ]),
        completion(),
      ]),
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "tool error goal",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("completed");
    expect(
      result.events
        .filter((event) => event.type === "tool_result")
        .map((event) => [event.outcome, event.errorCode]),
    ).toEqual([
      ["error", "tool_rejected"],
      ["error", "tool_broken"],
      ["error", "tool_failed"],
    ]);
  });

  it("records a step-budget failure before making a model call beyond the limit", async () => {
    const clock = new FakeClock(100);
    const model = new FakeModelPort([
      completion([{ callId: modelCallId, toolId: "unknown_tool", args: {} }]),
      completion(),
    ]);
    const result = await runLoop({
      recorder: new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock),
      clock,
      model,
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "step budget goal",
      configHash,
      budgets: RunConfigSchema.parse({ budgets: { maxSteps: 1 } }).budgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("failed");
    expect(model.requests).toHaveLength(1);
    expect(result.events.slice(-2)).toMatchObject([
      { type: "budget_exceeded", budget: "steps", limit: 1, observed: 2 },
      { type: "run_status_changed", from: "running", to: "failed", reason: "budget_exceeded" },
    ]);
  });

  it("fails before executing tools when a model response exceeds the cost budget", async () => {
    const clock = new FakeClock(100);
    const call = { callId: modelCallId, toolId: "budgeted_tool", args: {} };
    const execute = vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: null }));
    const tool = new FakeToolPort(
      new Map([["budgeted_tool", { idempotent: true, timeoutMs: 1_000, execute }]]),
    );
    const store = new InMemoryEventStore();
    const append = vi.spyOn(store, "append");
    const result = await runLoop({
      recorder: new RunRecorder(store, runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([completion([call], "over budget", 2)]),
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "cost budget goal",
      configHash,
      budgets: RunConfigSchema.parse({ budgets: { maxCostUsd: 0.000001 } }).budgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("failed");
    expect(result.events.find(({ type }) => type === "model_response")).toMatchObject({
      costMicros: 2,
    });
    expect(result.events.at(-2)).toMatchObject({
      type: "budget_exceeded",
      budget: "cost",
      limit: 1,
      observed: 2,
    });
    expect(result.events.at(-1)).toMatchObject({
      type: "run_status_changed",
      from: "running",
      to: "failed",
      reason: "budget_exceeded",
    });
    expect(tool.calls).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    const budgetAppendCalls = append.mock.calls.filter(([, appended]) =>
      appended.some(({ type }) => type === "budget_exceeded"),
    );
    expect(budgetAppendCalls).toHaveLength(1);
    expect(budgetAppendCalls[0]?.[1]).toMatchObject([
      { type: "budget_exceeded", budget: "cost" },
      {
        type: "run_status_changed",
        from: "running",
        to: "failed",
        reason: "budget_exceeded",
      },
    ]);
  });

  it("completes a final answer even when its response exceeds the cost budget", async () => {
    const clock = new FakeClock(100);
    const result = await runLoop({
      recorder: new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock),
      clock,
      model: new FakeModelPort([completion([], "final answer", 2)]),
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "final answer cost budget goal",
      configHash,
      budgets: RunConfigSchema.parse({ budgets: { maxCostUsd: 0.000001 } }).budgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("completed");
    expect(result.events.at(-1)).toMatchObject({
      type: "run_status_changed",
      from: "running",
      to: "completed",
      reason: "final_answer",
    });
    expect(result.events.find(({ type }) => type === "model_response")).toMatchObject({
      costMicros: 2,
    });
  });

  describe("resumeRun", () => {
    it("resumes after a crash during a model request and restores the event history", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      const prior = await createRunHistory(store, clock, [
        {
          type: "model_request",
          v: 1,
          requestId: modelCallId,
          provider: "test_provider",
          model: "test_model",
          messages: [{ role: "user", parts: [{ type: "text", text: "resumed goal" }] }],
        },
      ]);
      const contextPort: ContextPort = new NaiveContext();
      const restore = vi.spyOn(contextPort, "restore");
      const result = await resumeRun(createResumeOptions(store, clock, { context: contextPort }));

      expect(result.status).toBe("completed");
      expect(result.state.steps).toBe(1);
      expect(result.events.filter(({ type }) => type === "run_created")).toHaveLength(0);
      expect(
        result.events
          .filter((event) => event.type === "run_status_changed")
          .map((event) => event.reason),
      ).toEqual(["interrupted", "resumed", "final_answer"]);
      expect(result.state.segmentId).not.toBe(segmentId);
      expect(restore).toHaveBeenCalledWith(undefined, prior);
    });

    it("reruns idempotent dangling calls and escalates non-idempotent calls", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      const idempotentCallId = "44444444444444444444444444";
      const ambiguousCallId = "55555555555555555555555555";
      await createRunHistory(store, clock, [
        {
          type: "tool_intent",
          v: 1,
          callId: idempotentCallId,
          toolId: "idempotent_tool",
          idempotent: true,
          policyDecision: "allow",
          argsHash: "a".repeat(64),
          args: { value: 1 },
        },
        {
          type: "tool_intent",
          v: 1,
          callId: ambiguousCallId,
          toolId: "ambiguous_tool",
          idempotent: false,
          policyDecision: "allow",
          argsHash: "b".repeat(64),
          args: { value: 2 },
        },
      ]);
      const tool = new FakeToolPort(
        new Map([
          [
            "idempotent_tool",
            {
              idempotent: true,
              timeoutMs: 1000,
              execute: () => Promise.resolve({ outcome: "ok", result: { completed: true } }),
            },
          ],
          [
            "ambiguous_tool",
            {
              idempotent: false,
              timeoutMs: 1000,
              execute: () => Promise.resolve({ outcome: "ok", result: { completed: true } }),
            },
          ],
        ]),
      );
      const result = await resumeRun(createResumeOptions(store, clock, { tool }));
      const stored = await readApprovalEvents(store);

      expect(result.status).toBe("suspended");
      expect(tool.calls.map(({ call }) => call.callId)).toEqual([idempotentCallId]);
      expect(stored.filter(({ type }) => type === "tool_intent")).toHaveLength(2);
      expect(stored.filter(({ type }) => type === "tool_result")).toHaveLength(1);
      expect(result.state.pendingToolCalls.has(ambiguousCallId)).toBe(true);
      expect(result.state.pendingApprovals.size).toBe(1);
    });

    it("re-suspends an unresolved approval, then applies its durable decision", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      await createRunHistory(store, clock, [
        {
          type: "tool_intent",
          v: 1,
          callId: modelCallId,
          toolId: "approval_tool",
          idempotent: false,
          policyDecision: "ask",
          argsHash: "c".repeat(64),
          args: { value: 1 },
        },
        {
          type: "approval_requested",
          v: 1,
          approvalId,
          callId: modelCallId,
          payload: { kind: "approval" },
        },
        {
          type: "run_status_changed",
          v: 1,
          from: "running",
          to: "suspended",
          reason: "awaiting_approval",
        },
      ]);
      const tool = new FakeToolPort(
        new Map([
          [
            "approval_tool",
            {
              idempotent: false,
              timeoutMs: 1000,
              execute: () => Promise.resolve({ outcome: "ok", result: { approved: true } }),
            },
          ],
        ]),
      );
      const options = createResumeOptions(store, clock, { tool });
      const headBeforeBlockedResume = await store.head(runId);
      await expect(resumeRun(options)).rejects.toBeInstanceOf(RunAwaitingApprovalError);
      await expect(store.head(runId)).resolves.toBe(headBeforeBlockedResume);

      await resolveApproval(store, runId, approvalId, "approve", undefined, clock);
      const resumed = await resumeRun(options);
      const stored = await readApprovalEvents(store);

      expect(resumed.status).toBe("completed");
      expect(tool.calls.map(({ call }) => call.callId)).toEqual([modelCallId]);
      expect(stored.filter(({ type }) => type === "tool_intent")).toHaveLength(1);
      expect(stored.filter(({ type }) => type === "tool_result")).toHaveLength(1);
    });

    it.each(["approve", "deny"] as const)(
      "applies a %s decision for a resume-ambiguity approval",
      async (decision) => {
        const store = new InMemoryEventStore();
        const clock = new FakeClock(100);
        await createRunHistory(store, clock, [
          {
            type: "tool_intent",
            v: 1,
            callId: modelCallId,
            toolId: "ambiguous_tool",
            idempotent: false,
            policyDecision: "allow",
            policyApprovalTtlMs: 50,
            argsHash: "d".repeat(64),
            args: { value: 1 },
          },
        ]);
        const execute = vi.fn(() =>
          Promise.resolve({ outcome: "ok" as const, result: { approved: true } }),
        );
        const tool = new FakeToolPort(
          new Map([["ambiguous_tool", { idempotent: false, timeoutMs: 1_000, execute }]]),
        );
        const options = createResumeOptions(store, clock, { tool });
        const requested = await resumeRun(options);
        const approval = requested.state.pendingApprovals.values().next().value;
        if (approval === undefined) {
          throw new Error("Expected the resume-ambiguity approval.");
        }

        expect(approval).toMatchObject({
          expiresAt: 150,
          payload: { kind: "resume_ambiguity", expiresAt: 150 },
        });
        await resolveApproval(store, runId, approval.approvalId, decision, undefined, clock);
        const resumed = await resumeRun(options);
        const result = (await readApprovalEvents(store)).find(
          (event) => event.type === "tool_result" && event.callId === modelCallId,
        );

        expect(resumed.status).toBe("completed");
        expect(result).toMatchObject(
          decision === "deny"
            ? { outcome: "error", errorCode: "resume_ambiguous" }
            : { outcome: "ok" },
        );
        expect(execute).toHaveBeenCalledTimes(decision === "deny" ? 0 : 1);
      },
    );

    it("rejects a no-op edit decision for a resume-ambiguity approval before recording", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      await createRunHistory(store, clock, [
        {
          type: "tool_intent",
          v: 1,
          callId: modelCallId,
          toolId: "ambiguous_tool",
          idempotent: false,
          policyDecision: "allow",
          argsHash: "d".repeat(64),
          args: { value: 1 },
        },
      ]);
      const prepare = vi.fn((call: Parameters<NonNullable<ToolPort["prepare"]>>[0]) =>
        Promise.resolve(call),
      );
      const tool: ToolPort = {
        describe: () => ({ idempotent: false, timeoutMs: 1_000 }),
        prepare,
        execute: () => Promise.resolve({ outcome: "ok", result: null }),
      };
      const requested = await resumeRun(createResumeOptions(store, clock, { tool }));
      const approval = requested.state.pendingApprovals.values().next().value;
      if (approval === undefined) {
        throw new Error("Expected the resume-ambiguity approval.");
      }

      await expect(
        resolveApproval(store, runId, approval.approvalId, "edit", { value: 1 }, clock, tool),
      ).rejects.toMatchObject({ code: "edit_not_allowed" });
      expect(
        (await readApprovalEvents(store)).some(({ type }) => type === "approval_resolved"),
      ).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
    });

    it("checks the wall-clock budget before rerunning a dangling tool", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      await createRunHistory(store, clock, [
        {
          type: "tool_intent",
          v: 1,
          callId: modelCallId,
          toolId: "idempotent_tool",
          idempotent: true,
          policyDecision: "allow",
          argsHash: "e".repeat(64),
          args: { value: 1 },
        },
      ]);
      clock.advance(11);
      const execute = vi.fn(() =>
        Promise.resolve({ outcome: "ok" as const, result: { completed: true } }),
      );
      const tool = new FakeToolPort(
        new Map([["idempotent_tool", { idempotent: true, timeoutMs: 1_000, execute }]]),
      );
      const options = createResumeOptions(store, clock, {
        tool,
        budgets: RunConfigSchema.parse({ budgets: { maxWallClockMs: 10 } }).budgets,
      });

      const result = await resumeRun(options);

      expect(result.status).toBe("failed");
      const budgetFailureIndex = result.events.findIndex(({ type }) => type === "budget_exceeded");
      expect(result.events.slice(budgetFailureIndex, budgetFailureIndex + 2)).toMatchObject([
        { type: "budget_exceeded", budget: "wall_clock", limit: 10, observed: 11 },
        { type: "run_status_changed", from: "running", to: "failed", reason: "budget_exceeded" },
      ]);
      expect(execute).not.toHaveBeenCalled();
    });

    it("checks the wall-clock budget before executing an approved tool", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      await createRunHistory(store, clock, [
        {
          type: "tool_intent",
          v: 1,
          callId: modelCallId,
          toolId: "approval_tool",
          idempotent: false,
          policyDecision: "ask",
          argsHash: "f".repeat(64),
          args: { value: 1 },
        },
        {
          type: "approval_requested",
          v: 1,
          approvalId,
          callId: modelCallId,
          payload: { kind: "approval" },
        },
        {
          type: "run_status_changed",
          v: 1,
          from: "running",
          to: "suspended",
          reason: "awaiting_approval",
        },
      ]);
      clock.advance(11);
      await resolveApproval(store, runId, approvalId, "approve", undefined, clock);
      const execute = vi.fn(() =>
        Promise.resolve({ outcome: "ok" as const, result: { approved: true } }),
      );
      const tool = new FakeToolPort(
        new Map([["approval_tool", { idempotent: false, timeoutMs: 1_000, execute }]]),
      );
      const options = createResumeOptions(store, clock, {
        tool,
        budgets: RunConfigSchema.parse({
          budgets: { maxWallClockMs: 10, countSuspendedTime: true },
        }).budgets,
      });

      const result = await resumeRun(options);

      expect(result.status).toBe("failed");
      expect(result.events).toContainEqual(
        expect.objectContaining({
          type: "budget_exceeded",
          budget: "wall_clock",
          limit: 10,
          observed: 11,
        }),
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it("allows exactly one concurrent resumer to claim a run", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      await createRunHistory(store, clock);
      const readHead = store.head.bind(store);
      let headReads = 0;
      let releaseBarrier: (() => void) | undefined;
      const bothHeadsRead = new Promise<void>((resolve) => {
        releaseBarrier = resolve;
      });
      vi.spyOn(store, "head").mockImplementation(async (requestedRunId) => {
        const currentHead = await readHead(requestedRunId);
        headReads += 1;
        if (headReads === 2) {
          releaseBarrier?.();
        }
        await bothHeadsRead;
        return currentHead;
      });

      const attempts = await Promise.allSettled([
        resumeRun(createResumeOptions(store, clock)),
        resumeRun(createResumeOptions(store, clock)),
      ]);
      const winners = attempts.filter(({ status }) => status === "fulfilled");
      const losers = attempts.filter(({ status }) => status === "rejected");
      const loser = losers[0];

      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      if (loser?.status !== "rejected") {
        throw new Error("Expected one concurrent resume attempt to lose.");
      }
      expect(loser.reason).toBeInstanceOf(ResumeConflictError);
    });

    it("rejects a terminal run", async () => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      await createRunHistory(store, clock, [
        {
          type: "run_status_changed",
          v: 1,
          from: "running",
          to: "completed",
          reason: "final_answer",
        },
      ]);

      await expect(resumeRun(createResumeOptions(store, clock))).rejects.toBeInstanceOf(
        RunAlreadyTerminalError,
      );
    });

    it("creates a new segment linked to the checkpoint span", async () => {
      const startingSpanIndex = tracerProvider.spans.length;
      const store = new InMemoryEventStore();
      const clock = new FakeClock(100);
      const history = await createRunHistory(store, clock);
      const contextPort: ContextPort = new NaiveContext();
      const recorder = new RunRecorder(store, runId, segmentId, history.length, clock);
      const checkpointEvents: Event[] = [];
      await recorder.withStepSpan(RUN_SPAN, {}, async () => {
        const checkpointer = new Checkpointer({
          recorder,
          runId,
          context: contextPort,
          ids: new SequentialIdGenerator(),
          clock,
        });
        checkpointEvents.push(await checkpointer.write(foldRunState(history), "cadence"));
        checkpointEvents.push(
          ...(await recorder.recordBatch([
            {
              type: "model_request",
              v: 1,
              requestId: modelCallId,
              provider: "test_provider",
              model: "test_model",
              messages: [{ role: "user", parts: [{ type: "text", text: "resumed goal" }] }],
            },
            {
              type: "run_status_changed",
              v: 1,
              from: "running",
              to: "suspended",
              reason: "shutdown",
            },
          ])),
        );
        const last = checkpointEvents.at(-1);
        if (last === undefined) {
          throw new Error("Expected run history with a checkpoint.");
        }
        return last;
      });
      const snapshot = await store.latestSnapshot(runId);
      const restore = vi.spyOn(contextPort, "restore");
      const result = await resumeRun(createResumeOptions(store, clock, { context: contextPort }));
      const resumedRunSpan = tracerProvider.spans
        .slice(startingSpanIndex)
        .find(
          (span) =>
            span.name === "harness.run" &&
            span.attributes["harness.segment.id"] === result.state.segmentId,
        );

      expect(snapshot).toBeDefined();
      if (snapshot === undefined || resumedRunSpan === undefined) {
        throw new Error("Expected the checkpoint snapshot and resumed run span.");
      }
      expect(result.state.segmentId).not.toBe(segmentId);
      expect(resumedRunSpan.links).toHaveLength(1);
      expect(resumedRunSpan.links[0]?.context).toMatchObject({
        traceId: snapshot.traceparent.slice(3, 35),
        spanId: snapshot.traceparent.slice(36, 52),
      });
      expect(restore.mock.calls[0]?.[1].map(({ type }) => type)).toEqual([
        "model_request",
        "run_status_changed",
      ]);
    });
  });

  it("fails before executing tools when model work crosses the wall-clock budget", async () => {
    const clock = new FakeClock(100);
    const call = { callId: modelCallId, toolId: "budgeted_tool", args: {} };
    const execute = vi.fn(() => Promise.resolve({ outcome: "ok" as const, result: null }));
    const tool = new FakeToolPort(
      new Map([["budgeted_tool", { idempotent: true, timeoutMs: 1_000, execute }]]),
    );
    const model: ModelPort = {
      complete() {
        clock.advance(11);
        return Promise.resolve(completion([call]));
      },
    };
    const result = await runLoop({
      recorder: new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock),
      clock,
      model,
      tool,
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "wall-clock budget goal",
      configHash,
      budgets: RunConfigSchema.parse({ budgets: { maxWallClockMs: 10 } }).budgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("failed");
    expect(result.events.slice(-2)).toMatchObject([
      { type: "budget_exceeded", budget: "wall_clock", limit: 10, observed: 11 },
      { type: "run_status_changed", from: "running", to: "failed", reason: "budget_exceeded" },
    ]);
    expect(tool.calls).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    [
      Object.assign(new Error("provider failure"), { code: "provider_unavailable" }),
      "provider_unavailable",
    ],
    [Object.assign(new Error("provider failure"), { code: "Invalid Code" }), "model_failed"],
    [new Error("provider detail"), "model_failed"],
  ])("records a failed status when the model port rejects", async (error, expectedCode) => {
    const startingSpanIndex = tracerProvider.spans.length;
    const clock = new FakeClock(100);
    const recorder = new RunRecorder(new InMemoryEventStore(), runId, segmentId, 0, clock);
    const model: ModelPort = {
      complete() {
        return Promise.reject(error);
      },
    };
    const result = await runLoop({
      recorder,
      clock,
      model,
      tool: new FakeToolPort(),
      context: new NaiveContext(),
      ids: new SequentialIdGenerator(),
      goal: "error goal",
      configHash,
      budgets: defaultBudgets,
      policyVersion: "test.policy",
      signal: new AbortController().signal,
    });

    expect(result.state.status).toBe("failed");
    expect(result.events.at(-1)).toMatchObject({
      type: "run_status_changed",
      from: "running",
      to: "failed",
      reason: expectedCode,
    });
    const spans = tracerProvider.spans.slice(startingSpanIndex);
    const runSpan = spans.find(({ name }) => name === "harness.run");
    const modelSpan = spans.find(({ name }) => name === "harness.model_call");
    expect(modelSpan?.status.code).toBe(SpanStatusCode.ERROR);
    expect(modelSpan?.attributes["harness.error.code"]).toBe(expectedCode);
    expect(runSpan?.attributes["harness.event.seq"]).toBe(4);
  });
});
