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

test("history pruning retains a current actor handoff without keeping unrelated old entries", () => {
  const saved = Array.from({ length: 130 }, (_, i) => ({
    id: `old-${String(i).padStart(5, "0")}`,
    type: "buy",
    args: { id: i },
    status: "completed",
    priority: 0,
    createdAt: i,
    finishedAt: i,
  }));
  const queue = createActionQueue({
    saved,
    now: () => 1000,
    persist: () => true,
    retainIds: () => ["old-00000"],
    adapters: { buy: { validate: (args) => args } },
  });
  queue.add({ id: "new-action", type: "buy", args: { id: 999 } });
  const ids = queue.snapshot().map((item) => item.id);
  assert.ok(ids.includes("old-00000"));
  assert.ok(!ids.includes("old-00001"));
  assert.equal(ids.length, 130);
});

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

test("the maximum retry interval keeps a spread without exceeding one hour", () => {
  const delays = [0, 0.25, 0.5, 0.75, 1].map((value) =>
    retryDelay(99, () => value),
  );
  assert.deepEqual(delays, [2700000, 2925000, 3150000, 3375000, 3600000]);
  assert.ok(delays[0] > retryDelay(8, () => 1));
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

test("request context identifies reconciliation while the adapter runs", async () => {
  const observed = [];
  const queue = createActionQueue({
    saved: [
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
    ],
    adapters: { buy: { reconcile: async () => ({ status: "completed" }) } },
    persist: () => true,
    now: () => 1000,
    runInContext: async (job, reconcile, run) => {
      observed.push({ id: job.id, reconcile });
      return run();
    },
  });
  await queue.tick();
  assert.deepEqual(observed, [{ id: "old-uncertain", reconcile: true }]);
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

for (const failure of ["before dispatch", "after dispatch"]) {
  test(`storage failure ${failure} recovers without replaying a dispatched action`, async () => {
    let durable = [
      {
        id: "action-storage",
        type: "buy",
        args: { id: 1 },
        priority: 0,
        createdAt: 0,
        status: "queued",
        attempts: 0,
        nextAt: 0,
      },
    ];
    let writes = 0;
    let dispatches = 0;
    let reconciliations = 0;
    const adapters = {
      buy: {
        execute: async () => {
          dispatches++;
          return { status: "completed" };
        },
        reconcile: async () => {
          reconciliations++;
          return { status: "completed" };
        },
      },
    };
    const first = createActionQueue({
      saved: durable,
      adapters,
      now: () => 1000,
      random: () => 0,
      persist: (entries) => {
        writes++;
        if (failure === "before dispatch" || writes > 1) return false;
        durable = structuredClone(entries);
        return true;
      },
    });
    await assert.rejects(first.tick(), /action_queue_storage_unavailable/);
    assert.equal(dispatches, failure === "before dispatch" ? 0 : 1);
    assert.equal(
      durable[0].status,
      failure === "before dispatch" ? "queued" : "running",
    );

    const restored = createActionQueue({
      saved: durable,
      adapters,
      now: () => 2000,
      persist: (entries) => {
        durable = structuredClone(entries);
        return true;
      },
    });
    await restored.tick();
    assert.equal(dispatches, 1);
    assert.equal(reconciliations, failure === "before dispatch" ? 0 : 1);
    assert.equal(durable[0].status, "completed");
  });
}

test("dismiss hides only terminal records and preserves the durable receipt", async () => {
  const h = setup();
  h.queue.add({ id: "action-finished", type: "buy", args: { id: 1 } });
  h.queue.add({ id: "action-pending", type: "buy", args: { id: 2 } });
  await h.queue.tick();
  assert.equal(h.queue.dismiss("action-pending"), false);
  assert.equal(h.queue.dismiss("action-finished"), true);
  assert.equal(h.stored()[0].status, "completed");
  assert.equal(h.stored()[0].dismissed, true);
  assert.equal(
    h.queue.add({ id: "action-finished", type: "buy", args: { id: 1 } }).status,
    "completed",
  );
});

test("dependent work waits for confirmed success without blocking independent work", async () => {
  const h = setup();
  const executed = [];
  h.execute(async (job) => {
    executed.push(job.id);
    return { status: "completed" };
  });
  h.queue.add({
    id: "dependency-01",
    type: "buy",
    args: { id: 1 },
    priority: 1,
  });
  h.queue.add({
    id: "dependent-01",
    type: "buy",
    args: { id: 2 },
    priority: 60,
    dependsOn: ["dependency-01"],
  });
  h.queue.add({
    id: "independent-01",
    type: "buy",
    args: { id: 3 },
    priority: 30,
  });
  assert.equal(h.queue.snapshot()[1].blockedBy, "dependency");
  await h.queue.tick();
  await h.queue.tick();
  await h.queue.tick();
  assert.deepEqual(executed, [
    "independent-01",
    "dependency-01",
    "dependent-01",
  ]);
});

test("failed or cancelled dependencies never authorize dependent dispatch after restart", async () => {
  for (const status of ["failed", "cancelled", "reconciling"]) {
    let calls = 0;
    const saved = [
      {
        id: "dependency-01",
        type: "buy",
        args: { id: 1 },
        status,
        priority: 0,
        createdAt: 0,
        attempts: 0,
        nextAt: Number.MAX_SAFE_INTEGER,
      },
      {
        id: "dependent-01",
        type: "buy",
        args: { id: 2 },
        status: "queued",
        priority: 60,
        createdAt: 1,
        attempts: 0,
        nextAt: 0,
        dependsOn: ["dependency-01"],
      },
    ];
    const queue = createActionQueue({
      saved,
      persist: () => true,
      now: () => 1000,
      adapters: {
        buy: {
          execute: async () => {
            calls++;
            return { status: "completed" };
          },
        },
      },
    });
    assert.equal(queue.hasDue(), status !== "reconciling");
    await queue.tick();
    assert.equal(calls, 0);
    if (status === "reconciling") {
      assert.equal(queue.snapshot()[1].blockedBy, "dependency");
    } else {
      assert.equal(queue.snapshot()[1].status, "failed");
      assert.equal(queue.snapshot()[1].reason, "dependency_failed");
    }
  }
});

test("failed prerequisites propagate through a chain without contacting the game", async () => {
  const h = setup();
  h.execute(async () => ({ status: "failed", reason: "denied" }));
  h.queue.add({ id: "dependency-01", type: "buy", args: { id: 1 } });
  h.queue.add({
    id: "dependent-01",
    type: "buy",
    args: { id: 2 },
    dependsOn: ["dependency-01"],
  });
  h.queue.add({
    id: "dependent-02",
    type: "buy",
    args: { id: 3 },
    dependsOn: ["dependent-01"],
  });
  await h.queue.tick();
  await h.queue.tick();
  await h.queue.tick();
  assert.deepEqual(h.calls, ["execute"]);
  assert.deepEqual(
    h.stored().map((entry) => entry.status),
    ["failed", "failed", "failed"],
  );
  assert.deepEqual(
    h
      .stored()
      .slice(1)
      .map((entry) => entry.reason),
    ["dependency_failed", "dependency_failed"],
  );
});

test("dependency failure is settled during an outage only while storage is available", async () => {
  let available = false;
  const saved = [
    {
      id: "dependency-01",
      type: "buy",
      args: {},
      status: "failed",
      priority: 0,
      createdAt: 0,
    },
    {
      id: "dependent-01",
      type: "buy",
      args: {},
      status: "queued",
      priority: 0,
      createdAt: 1,
      dependsOn: ["dependency-01"],
    },
  ];
  const queue = createActionQueue({
    saved,
    adapters: {},
    persist: () => true,
    ready: () => false,
    canSettle: () => available,
  });
  assert.equal(queue.hasDue(), false);
  available = true;
  assert.equal(queue.hasDue(), true);
  await queue.tick();
  assert.equal(queue.snapshot()[1].reason, "dependency_failed");
});

test("rejects missing, duplicate and self dependencies", () => {
  const h = setup();
  for (const dependsOn of [["missing-01"], ["dependent-01"]])
    assert.throws(
      () =>
        h.queue.add({
          id: "dependent-01",
          type: "buy",
          args: { id: 1 },
          dependsOn,
        }),
      /invalid_action_queue_dependency/,
    );
  h.queue.add({ id: "dependency-01", type: "buy", args: { id: 1 } });
  assert.throws(
    () =>
      h.queue.add({
        id: "dependent-01",
        type: "buy",
        args: { id: 2 },
        dependsOn: ["dependency-01", "dependency-01"],
      }),
    /invalid_action_queue_dependency/,
  );
});

test("history pruning retains a completed prerequisite while it is still referenced", () => {
  const saved = Array.from({ length: 130 }, (_, i) => ({
    id: `done-${String(i).padStart(4, "0")}`,
    type: "buy",
    args: { id: i },
    status: "completed",
    priority: 0,
    createdAt: i,
    attempts: 0,
    nextAt: null,
  }));
  saved.push({
    id: "dependent-01",
    type: "buy",
    args: { id: 200 },
    status: "queued",
    priority: 0,
    createdAt: 200,
    attempts: 0,
    nextAt: 0,
    dependsOn: ["done-0000"],
  });
  const queue = createActionQueue({
    saved,
    persist: () => true,
    adapters: { buy: { validate: (args) => args } },
  });
  queue.add({ id: "another-01", type: "buy", args: { id: 201 } });
  assert.ok(queue.snapshot().some((entry) => entry.id === "done-0000"));
  assert.equal(
    queue.snapshot().find((entry) => entry.id === "dependent-01").eligible,
    true,
  );
});

test("history pruning retains an old intention that completed recently", () => {
  const saved = Array.from({ length: 129 }, (_, index) => ({
    id: `done-${String(index).padStart(4, "0")}`,
    type: "buy",
    args: { id: index },
    status: "completed",
    priority: 0,
    createdAt: index + 1,
    finishedAt: index === 0 ? 1000 : index + 1,
    attempts: 0,
    nextAt: null,
  }));
  const queue = createActionQueue({
    saved,
    persist: () => true,
    adapters: { buy: { validate: (args) => args } },
  });
  queue.add({ id: "another-01", type: "buy", args: { id: 200 } });
  assert.ok(queue.snapshot().some((entry) => entry.id === "done-0000"));
  assert.ok(!queue.snapshot().some((entry) => entry.id === "done-0001"));
});

test("completion time is persisted after confirmed execution", async () => {
  const h = setup();
  h.queue.add({ id: "action-finished", type: "buy", args: { id: 1 } });
  h.advance(9000);
  await h.queue.tick();
  assert.equal(h.stored()[0].finishedAt, 10000);
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
