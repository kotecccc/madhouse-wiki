import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionQueue, retryDelay } from "./action-queue.mjs";

function setup(saved = []) {
  let time = 1000;
  let stored = [];
  let calls = [];
  let execute = async () => ({ status: "completed" });
  let reconcile = async () => ({ status: "completed" });
  const queue = createActionQueue({
    saved,
    now: () => time,
    random: () => 0,
    persist: (entries) => {
      stored = entries;
    },
    adapters: {
      buy: {
        validate: (args) => {
          if (!Number.isInteger(args?.id)) throw new Error("invalid");
          return { id: args.id };
        },
        execute: async (...args) => {
          calls.push("execute");
          return execute(...args);
        },
        reconcile: async (...args) => {
          calls.push("reconcile");
          return reconcile(...args);
        },
      },
    },
  });
  return {
    queue,
    calls,
    stored: () => stored,
    advance: (n) => {
      time += n;
    },
    execute: (fn) => {
      execute = fn;
    },
    reconcile: (fn) => {
      reconcile = fn;
    },
  };
}

test("saves validated intent, deduplicates ID and runs priority first", async () => {
  const h = setup();
  h.queue.add({
    id: "action-0001",
    type: "buy",
    args: { id: 1, secret: "discard" },
    priority: 1,
  });
  h.queue.add({ id: "action-0002", type: "buy", args: { id: 2 }, priority: 2 });
  h.queue.add({ id: "action-0001", type: "buy", args: { id: 3 } });
  assert.deepEqual(h.stored()[0].args, { id: 1 });
  assert.equal(h.stored().length, 2);
  await h.queue.tick();
  assert.equal(h.stored()[1].status, "completed");
  assert.equal(h.stored()[0].status, "queued");
});

test("retry uses increasing persisted deadlines and honors cancellation", async () => {
  const h = setup();
  h.execute(async () => ({ status: "retry", retryAfterMs: 20000 }));
  h.queue.add({ id: "action-0001", type: "buy", args: { id: 1 } });
  await h.queue.tick();
  assert.equal(h.stored()[0].nextAt, 21000);
  h.advance(19999);
  await h.queue.tick();
  assert.equal(h.calls.length, 1);
  h.advance(1);
  await h.queue.tick();
  assert.equal(h.stored()[0].nextAt, 51000);
  assert.equal(h.queue.stop("action-0001"), true);
  h.advance(60000);
  await h.queue.tick();
  assert.equal(h.calls.length, 2);
  assert.equal(h.stored()[0].status, "cancelled");
  assert.equal(
    retryDelay(99, () => 1),
    3600000,
  );
});

test("Retry-After may exceed the automatic backoff limit", async () => {
  const h = setup();
  h.execute(async () => ({ status: "retry", retryAfterMs: 7_200_000 }));
  h.queue.add({ id: "action-0001", type: "buy", args: { id: 1 } });
  await h.queue.tick();
  assert.equal(h.stored()[0].nextAt, 7_201_000);
});

test("a retry deadline survives queue reconstruction", async () => {
  const first = setup();
  first.execute(async () => ({ status: "retry" }));
  first.queue.add({ id: "action-0001", type: "buy", args: { id: 1 } });
  await first.queue.tick();
  const saved = first.stored();
  assert.equal(saved[0].nextAt, 11000);

  const restarted = setup(saved);
  await restarted.queue.tick();
  assert.deepEqual(restarted.calls, []);
  restarted.advance(9999);
  await restarted.queue.tick();
  assert.deepEqual(restarted.calls, []);
  restarted.advance(1);
  await restarted.queue.tick();
  assert.deepEqual(restarted.calls, ["execute"]);
  assert.equal(restarted.stored()[0].status, "completed");
});

test("restart after dispatch only reconciles and never replays", async () => {
  const h = setup([
    {
      id: "action-0001",
      type: "buy",
      args: { id: 1 },
      priority: 0,
      createdAt: 1,
      status: "running",
      attempts: 0,
      nextAt: null,
    },
  ]);
  h.reconcile(async () => ({ status: "uncertain" }));
  await h.queue.tick();
  assert.deepEqual(h.calls, ["reconcile"]);
  assert.equal(h.stored()[0].status, "reconciling");
  assert.equal(h.queue.stop("action-0001"), true);
  h.reconcile(async () => ({ status: "completed" }));
  h.advance(10000);
  await h.queue.tick();
  assert.equal(h.stored()[0].status, "completed");
  assert.deepEqual(h.calls, ["reconcile", "reconcile"]);
});

test("due reconciliation runs before a newer ordinary action", async () => {
  const h = setup([
    {
      id: "old-uncertain",
      type: "buy",
      args: { id: 1 },
      priority: 15,
      createdAt: 1000,
      status: "reconciling",
      attempts: 0,
      nextAt: 1000,
    },
  ]);
  h.queue.add({
    id: "ordinary-action",
    type: "buy",
    args: { id: 2 },
    priority: 30,
  });
  await h.queue.tick();
  assert.deepEqual(h.calls, ["reconcile"]);
  assert.equal(
    h.stored().find((item) => item.id === "old-uncertain").status,
    "completed",
  );
  assert.equal(
    h.stored().find((item) => item.id === "ordinary-action").status,
    "queued",
  );
});

test("stop during an attempt invalidates dispatch permission", async () => {
  const h = setup();
  let proceed;
  let permitted;
  h.execute(async (_entry, { canDispatch }) => {
    await new Promise((resolve) => {
      proceed = resolve;
    });
    permitted = canDispatch();
    return { status: "retry" };
  });
  h.queue.add({ id: "action-0001", type: "buy", args: { id: 1 } });
  const tick = h.queue.tick();
  assert.equal(h.stored()[0].status, "running");
  h.queue.stop("action-0001");
  proceed();
  await tick;
  assert.equal(permitted, false);
  assert.equal(h.stored()[0].status, "cancelled");
});

test("a newer setting supersedes an in-flight check without applying it", async () => {
  let release;
  let applied = [];
  let stored;
  const adapter = {
    validate: (args) => args,
    dedupeKey: (args) => `${args.id}:${args.enabled}`,
    supersedes: (args, previous) => args.id === previous.id,
    execute: async (job, { canDispatch }) => {
      if (job.args.enabled)
        await new Promise((resolve) => {
          release = resolve;
        });
      if (!canDispatch()) return { status: "retry" };
      applied.push(job.args.enabled);
      return { status: "completed" };
    },
  };
  adapter.reconcile = adapter.execute;
  const queue = createActionQueue({
    adapters: { setting: adapter },
    persist: (items) => {
      stored = items;
    },
  });
  queue.add({
    id: "setting-0001",
    type: "setting",
    args: { id: 1, enabled: true },
  });
  const first = queue.tick();
  queue.add({
    id: "setting-0002",
    type: "setting",
    args: { id: 1, enabled: false },
  });
  release();
  await first;
  await queue.tick();
  assert.deepEqual(applied, [false]);
  assert.deepEqual(
    stored.map((item) => item.status),
    ["cancelled", "completed"],
  );
});

test("an ineligible older action does not block an independent ready action", async () => {
  let allowFirst = false;
  const executed = [];
  const queue = createActionQueue({
    persist: () => true,
    now: () => 1000,
    eligible: (entry) => entry.args.id !== 1 || allowFirst,
    adapters: {
      buy: {
        validate: (args) => args,
        execute: async (job) => {
          executed.push(job.args.id);
          return { status: "completed" };
        },
        reconcile: async () => ({ status: "uncertain" }),
      },
    },
  });
  queue.add({ id: "action-0001", type: "buy", args: { id: 1 }, priority: 10 });
  queue.add({ id: "action-0002", type: "buy", args: { id: 2 }, priority: 1 });
  assert.equal(queue.snapshot()[0].eligible, false);
  await queue.tick();
  assert.deepEqual(executed, [2]);
  allowFirst = true;
  await queue.tick();
  assert.deepEqual(executed, [2, 1]);
});

test("aging lets an older low-priority action outrank a new urgent action", async () => {
  const executed = [];
  let time = 1000;
  const queue = createActionQueue({
    persist: () => true,
    now: () => time,
    adapters: {
      buy: {
        validate: (args) => args,
        execute: async (job) => {
          executed.push(job.args.id);
          return { status: "completed" };
        },
        reconcile: async () => ({ status: "uncertain" }),
      },
    },
  });
  queue.add({ id: "action-older", type: "buy", args: { id: 1 }, priority: 0 });
  time += 61 * 60_000;
  queue.add({ id: "action-newer", type: "buy", args: { id: 2 }, priority: 60 });

  await queue.tick();
  assert.deepEqual(executed, [1]);
});

test("terminal history stays bounded while uncertain checkpoints remain", async () => {
  // Simulate a checkpoint recovered after an interrupted submission.
  const paused = createActionQueue({
    saved: [
      {
        id: "uncertain-0001",
        type: "buy",
        args: { id: -1 },
        priority: -1,
        createdAt: 0,
        status: "reconciling",
        attempts: 0,
        nextAt: Number.MAX_SAFE_INTEGER,
      },
    ],
    persist: () => true,
    adapters: {
      buy: {
        validate: (args) => args,
        execute: async () => ({ status: "completed" }),
        reconcile: async () => ({ status: "uncertain" }),
      },
    },
  });
  for (let index = 0; index < 140; index++) {
    paused.add({
      id: `action-${String(index).padStart(4, "0")}`,
      type: "buy",
      args: { id: index },
    });
    await paused.tick();
  }
  assert.equal(paused.snapshot().length, 130);
  assert.equal(paused.snapshot()[0].id, "uncertain-0001");
  assert.equal(paused.snapshot().at(-1).id, "action-0139");
});
