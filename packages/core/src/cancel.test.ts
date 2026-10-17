// SPDX-License-Identifier: Apache-2.0
import { context, trace } from "@opentelemetry/api";
import { FakeClock, Id, SequentialIdGenerator, Sha256Hex, type Event } from "@harness/schemas";
import { InMemoryEventStore, type EventStore } from "@harness/store";
import { createTestContextManager, createTestTracerProvider } from "@harness/telemetry/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cancelRun } from "./cancel.js";
import { RunRecorder, type EventPartial } from "./recorder.js";
import { foldRunState } from "./run-state.js";
import { RUN_SPAN } from "./spans.js";

const runId = Id.parse("00000000000000000000000000");
const childRunId = Id.parse("22222222222222222222222222");
const grandchildRunId = Id.parse("33333333333333333333333333");
const siblingRunId = Id.parse("55555555555555555555555555");
const segmentId = Id.parse("11111111111111111111111111");
const tracerProvider = createTestTracerProvider();

beforeAll(() => {
  context.setGlobalContextManager(createTestContextManager());
  trace.setGlobalTracerProvider(tracerProvider);
});

afterAll(() => {
  context.disable();
  trace.disable();
});

async function seedRun(
  store: EventStore,
  status: "pending" | "running" | "suspended" | "completed",
): Promise<void> {
  const events: EventPartial[] = [
    {
      type: "run_created",
      v: 1,
      configHash: Sha256Hex.parse("a".repeat(64)),
      policyVersion: "test",
    },
  ];
  if (status !== "pending") {
    events.push({
      type: "run_status_changed",
      v: 1,
      from: "pending",
      to: "running",
      reason: "start",
    });
  }
  if (status === "suspended") {
    events.push({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "suspended",
      reason: "shutdown",
    });
  }
  if (status === "completed") {
    events.push({
      type: "run_status_changed",
      v: 1,
      from: "running",
      to: "completed",
      reason: "final_answer",
    });
  }
  const recorder = new RunRecorder(store, runId, segmentId, 0, new FakeClock(100));
  await recorder.withStepSpan(RUN_SPAN, {}, () =>
    recorder.recordBatch(events).then((recorded) => {
      const last = recorded.at(-1);
      if (last === undefined) {
        throw new Error("Expected seeded run events.");
      }
      return last;
    }),
  );
}

async function readEvents(store: EventStore): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of store.read(runId)) {
    events.push(event);
  }
  return events;
}

async function seedChild(
  store: EventStore,
  childId: ReturnType<typeof Id.parse>,
  parentId: ReturnType<typeof Id.parse>,
  status: "running" | "suspended",
): Promise<void> {
  const events: EventPartial[] = [
    {
      type: "run_created",
      v: 1,
      parentRunId: parentId,
      parentCallId: Id.parse("44444444444444444444444444"),
      depth: 1,
      configHash: Sha256Hex.parse("a".repeat(64)),
      policyVersion: "test",
    },
    { type: "run_status_changed", v: 1, from: "pending", to: "running", reason: "start" },
    ...(status === "suspended"
      ? [
          {
            type: "run_status_changed" as const,
            v: 1 as const,
            from: "running" as const,
            to: "suspended" as const,
            reason: "shutdown" as const,
          },
        ]
      : []),
  ];
  const recorder = new RunRecorder(store, childId, segmentId, 0, new FakeClock(100));
  await recorder.withStepSpan(RUN_SPAN, {}, () =>
    recorder.recordBatch(events).then((recorded) => {
      const last = recorded.at(-1);
      if (last === undefined) {
        throw new Error("Expected seeded child events.");
      }
      return last;
    }),
  );
}

async function linkChild(
  store: EventStore,
  parentId: ReturnType<typeof Id.parse>,
  childId: ReturnType<typeof Id.parse>,
  seq: number,
): Promise<void> {
  await store.append(
    parentId,
    [
      {
        runId: parentId,
        ts: 101 + seq,
        type: "subagent_spawned",
        v: 1,
        traceId: "a".repeat(32),
        spanId: "b".repeat(16),
        segmentId,
        childRunId: childId,
        role: "worker",
        parentCallId: Id.parse("44444444444444444444444444"),
      },
    ],
    seq,
  );
}

function competingEvent(seq: number): {
  readonly type: "model_request";
  readonly v: 1;
  readonly requestId: ReturnType<typeof Id.parse>;
  readonly provider: "test";
  readonly model: "test";
  readonly messages: [];
  readonly runId: ReturnType<typeof Id.parse>;
  readonly ts: number;
  readonly traceId: string;
  readonly spanId: string;
  readonly segmentId: ReturnType<typeof Id.parse>;
} {
  return {
    type: "model_request",
    v: 1,
    requestId: Id.parse(String(seq).padStart(26, "0")),
    provider: "test",
    model: "test",
    messages: [],
    runId,
    ts: 101 + seq,
    traceId: "a".repeat(32),
    spanId: "b".repeat(16),
    segmentId,
  };
}

describe("cancelRun", () => {
  it.each(["pending", "running", "suspended"] as const)(
    "cancels a %s run with one durable terminal status event",
    async (status) => {
      const store = new InMemoryEventStore();
      const clock = new FakeClock(200);
      await seedRun(store, status);

      await expect(cancelRun(store, runId, clock, new SequentialIdGenerator())).resolves.toBe(
        "cancelled",
      );

      const events = await readEvents(store);
      const statusEvents = events.filter(
        (event) => event.type === "run_status_changed" && event.to === "cancelled",
      );
      expect(statusEvents).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({
        type: "run_status_changed",
        from: status,
        to: "cancelled",
        reason: "cancel_requested",
      });
      expect(foldRunState(events).status).toBe("cancelled");
    },
  );

  it("returns already_terminal without appending to a completed run", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "completed");
    const head = await store.head(runId);

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).resolves.toBe("already_terminal");

    expect(await store.head(runId)).toBe(head);
  });

  it("does not report a busy run as already terminal after every sweep races", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    const readHead = store.head.bind(store);
    let races = 0;
    vi.spyOn(store, "head").mockImplementation(async (requestedRunId) => {
      const head = await readHead(requestedRunId);
      if (requestedRunId === runId && races < 3) {
        await store.append(runId, [competingEvent(head)], head);
        races += 1;
      }
      return requestedRunId === runId && races > 0 ? readHead(requestedRunId) : head;
    });

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).rejects.toMatchObject({ code: "cancel_conflict" });

    expect(races).toBe(3);
    expect(foldRunState(await readEvents(store)).status).toBe("running");
  });

  it.each(["running", "suspended"] as const)(
    "cancels a %s child and its descendant before cancelling the parent",
    async (childStatus) => {
      const store = new InMemoryEventStore();
      await seedRun(store, "running");
      await linkChild(store, runId, childRunId, 2);
      await seedChild(store, childRunId, runId, childStatus);
      await linkChild(store, childRunId, grandchildRunId, childStatus === "running" ? 2 : 3);
      await seedChild(store, grandchildRunId, childRunId, "running");
      const childSpawn = await (async () => {
        for await (const event of store.read(childRunId)) {
          if (event.type === "subagent_spawned") {
            return event;
          }
        }
        return undefined;
      })();
      expect(childSpawn?.childRunId).toBe(grandchildRunId);

      await expect(
        cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
      ).resolves.toBe("cancelled");

      const parentEvents = await readEvents(store);
      const childEvents = await (async () => {
        const values: Event[] = [];
        for await (const event of store.read(childRunId)) {
          values.push(event);
        }
        return values;
      })();
      const grandchildEvents: Event[] = [];
      for await (const event of store.read(grandchildRunId)) {
        grandchildEvents.push(event);
      }
      expect(childEvents.at(-1)).toMatchObject({ type: "run_status_changed", to: "cancelled" });
      expect(grandchildEvents.at(-1)).toMatchObject({
        type: "run_status_changed",
        to: "cancelled",
      });
      expect(parentEvents.find((event) => event.type === "subagent_completed")).toMatchObject({
        childRunId,
        outcome: "cancelled",
      });
      expect(childEvents.find((event) => event.type === "subagent_completed")).toMatchObject({
        childRunId: grandchildRunId,
        outcome: "cancelled",
      });
      expect(parentEvents.at(-1)).toMatchObject({ type: "run_status_changed", to: "cancelled" });
    },
  );

  it("re-reads and retries when a live worker wins an append race", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    const append = store.append.bind(store);
    let raced = false;
    vi.spyOn(store, "append").mockImplementation(async (id, events, expectedSeq) => {
      if (!raced && events.some((event) => event.type === "run_status_changed")) {
        raced = true;
        await append(id, [competingEvent(expectedSeq)], expectedSeq);
      }
      return append(id, events, expectedSeq);
    });

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).resolves.toBe("cancelled");

    const events = await readEvents(store);
    expect(events.map((event) => event.type)).toContain("model_request");
    expect(
      events.filter((event) => event.type === "run_status_changed" && event.to === "cancelled"),
    ).toHaveLength(1);
  });

  it("re-reads when the log head advances beyond the event snapshot", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    const readHead = store.head.bind(store);
    let firstRead = true;
    vi.spyOn(store, "head").mockImplementation(async (id) => {
      const head = await readHead(id);
      if (firstRead && id === runId) {
        firstRead = false;
        return head + 1;
      }
      return head;
    });

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).resolves.toBe("cancelled");

    expect(firstRead).toBe(false);
    expect((await readEvents(store)).at(-1)).toMatchObject({
      type: "run_status_changed",
      to: "cancelled",
    });
  });

  it("stops after three consecutive append conflicts", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    const append = store.append.bind(store);
    let conflicts = 0;
    vi.spyOn(store, "append").mockImplementation(async (id, events, expectedSeq) => {
      if (events.some((event) => event.type === "run_status_changed") && conflicts < 3) {
        conflicts += 1;
        await append(id, [competingEvent(expectedSeq)], expectedSeq);
      }
      return append(id, events, expectedSeq);
    });

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).rejects.toMatchObject({ code: "cancel_conflict" });
    expect(conflicts).toBe(3);
    expect(
      (await readEvents(store)).some(
        (event) => event.type === "run_status_changed" && event.to === "cancelled",
      ),
    ).toBe(false);
  });

  it("records cancellation for an announced child whose run never started", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    await linkChild(store, runId, childRunId, 2);

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).resolves.toBe("cancelled");

    expect(await readEvents(store)).toContainEqual(
      expect.objectContaining({
        type: "subagent_completed",
        childRunId,
        outcome: "cancelled",
        inputTokens: 0,
        outputTokens: 0,
        steps: 0,
      }),
    );
    expect(
      await (async () => {
        const events: Event[] = [];
        for await (const event of store.read(childRunId)) {
          events.push(event);
        }
        return events;
      })(),
    ).toEqual([]);
  });

  it("sweeps a child announced between the tree scan and parent cancellation", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    const append = store.append.bind(store);
    let announced = false;
    vi.spyOn(store, "append").mockImplementation(async (id, events, expectedSeq) => {
      if (
        id === runId &&
        !announced &&
        events.some((event) => event.type === "run_status_changed")
      ) {
        announced = true;
        await append(
          id,
          [
            {
              runId,
              ts: 201,
              type: "subagent_spawned",
              v: 1,
              traceId: "a".repeat(32),
              spanId: "b".repeat(16),
              segmentId,
              childRunId: grandchildRunId,
              role: "worker",
              parentCallId: Id.parse("44444444444444444444444444"),
            },
          ],
          expectedSeq,
        );
      }
      return append(id, events, expectedSeq);
    });

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).resolves.toBe("cancelled");

    const parentEvents = await readEvents(store);
    expect(parentEvents).toContainEqual(
      expect.objectContaining({
        type: "subagent_completed",
        childRunId: grandchildRunId,
        outcome: "cancelled",
      }),
    );
    expect(parentEvents.at(-1)).toMatchObject({ type: "run_status_changed", to: "cancelled" });
  });

  it("cancels siblings and the root when a middle-level descendant fails cancellation", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    await linkChild(store, runId, childRunId, 2);
    await seedChild(store, childRunId, runId, "running");
    await linkChild(store, childRunId, grandchildRunId, 2);
    await linkChild(store, childRunId, siblingRunId, 3);
    await seedChild(store, grandchildRunId, childRunId, "running");
    await seedChild(store, siblingRunId, childRunId, "running");
    const append = store.append.bind(store);
    vi.spyOn(store, "append").mockImplementation((id, events, expectedSeq) => {
      if (
        id === grandchildRunId &&
        events.some((event) => event.type === "run_status_changed" && event.to === "cancelled")
      ) {
        return Promise.reject(new Error("injected child cancellation failure"));
      }
      return append(id, events, expectedSeq);
    });

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).rejects.toBeInstanceOf(AggregateError);

    const [middleEvents, siblingEvents] = await Promise.all([
      (async () => {
        const events: Event[] = [];
        for await (const event of store.read(childRunId)) {
          events.push(event);
        }
        return events;
      })(),
      (async () => {
        const events: Event[] = [];
        for await (const event of store.read(siblingRunId)) {
          events.push(event);
        }
        return events;
      })(),
    ]);
    expect(middleEvents.findLast((event) => event.type === "run_status_changed")).toMatchObject({
      type: "run_status_changed",
      to: "cancelled",
    });
    expect(siblingEvents.at(-1)).toMatchObject({
      type: "run_status_changed",
      to: "cancelled",
    });
    expect((await readEvents(store)).at(-1)).toMatchObject({
      type: "run_status_changed",
      to: "cancelled",
    });
  });

  it("re-reads and retries a child completion after a sequence conflict", async () => {
    const store = new InMemoryEventStore();
    await seedRun(store, "running");
    await linkChild(store, runId, childRunId, 2);
    await seedChild(store, childRunId, runId, "running");
    const append = store.append.bind(store);
    let raced = false;
    vi.spyOn(store, "append").mockImplementation(async (id, events, expectedSeq) => {
      if (id === runId && !raced && events.some((event) => event.type === "subagent_completed")) {
        raced = true;
        await append(id, [competingEvent(expectedSeq)], expectedSeq);
      }
      return append(id, events, expectedSeq);
    });

    await expect(
      cancelRun(store, runId, new FakeClock(200), new SequentialIdGenerator()),
    ).resolves.toBe("cancelled");

    expect(raced).toBe(true);
    expect(await readEvents(store)).toContainEqual(
      expect.objectContaining({
        type: "subagent_completed",
        childRunId,
        outcome: "cancelled",
      }),
    );
  });
});
