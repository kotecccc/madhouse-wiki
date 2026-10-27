import test from "node:test";
import assert from "node:assert/strict";
import { createFloorRunner } from "../scripts/automation/floor-runner.mjs";

function setup(overrides = {}) {
  let time = 0;
  const writes = [];
  let launches = 0;
  let outcome = "running";
  const runner = createFloorRunner({
    now: () => time,
    plan: async () => ({ status: "ready", kind: "work", apiId: 1 }),
    launch: async () => {
      launches++;
    },
    observe: async () => outcome,
    stopOwned: () => {},
    persist: (value) => writes.push(structuredClone(value)),
    ...overrides,
  });
  return {
    runner,
    writes,
    launches: () => launches,
    setOutcome: (value) => {
      outcome = value;
    },
    advance: () => {
      time += 15000;
    },
  };
}
test("floor planning yields to a queued character upgrade and resumes", async () => {
  let priority = false;
  let first = true;
  const h = setup({
    priorityActive: () => priority,
    plan: async () => {
      if (first) priority = true;
      first = false;
      return { status: "ready", kind: "work", apiId: 1 };
    },
  });
  h.runner.start();
  await h.runner.tick();
  assert.equal(h.launches(), 0);
  assert.equal(h.runner.getSnapshot().phase, "planning");
  priority = false;
  await h.runner.tick();
  assert.equal(h.launches(), 1);
});
test("persists launch intent and observes worker before planning the next goal", async () => {
  let planned = 0;
  const h = setup({
    plan: async () => ({
      status: "ready",
      kind: "work",
      apiId: ++planned,
      current: 0,
      required: 1,
    }),
  });
  h.runner.start();
  await h.runner.tick();
  assert.equal(h.writes.at(-2).phase, "launching");
  assert.equal(h.runner.getSnapshot().phase, "executing");
  h.advance();
  await h.runner.tick();
  assert.equal(h.launches(), 1);
  h.setOutcome("completed");
  h.advance();
  await h.runner.tick();
  assert.equal(h.launches(), 2);
});
test("does not relaunch a completed goal while the game's progress is stale", async () => {
  const h = setup({
    plan: async () => ({
      status: "ready",
      kind: "boss",
      apiId: 4,
      current: 1,
      required: 2,
    }),
  });
  h.runner.start();
  await h.runner.tick();
  h.setOutcome("completed");
  h.advance();
  await h.runner.tick();
  assert.equal(h.launches(), 1);
  assert.match(h.runner.getSnapshot().reason, /подтверждения прогресса/);
});
test("a work batch stopped at its action limit waits for confirmed progress before replanning", async () => {
  let current = 1;
  const h = setup({
    plan: async () => ({
      status: "ready",
      kind: "work",
      apiId: 1,
      current,
      required: 20,
    }),
  });
  h.runner.start();
  await h.runner.tick();
  h.setOutcome("partial");
  h.advance();
  await h.runner.tick();
  assert.equal(h.launches(), 1);
  current = 3;
  for (let i = 0; i < 4; i++) h.advance();
  await h.runner.tick();
  assert.equal(h.launches(), 2);
});
test("stop and restart preserve an unresolved launch and reject a new start", async () => {
  const h = setup({
    saved: {
      status: "paused",
      phase: "launching",
      target: { kind: "work", apiId: 1 },
    },
  });
  h.runner.stop();
  assert.equal(h.runner.getSnapshot().status, "stopped");
  assert.equal(h.runner.getSnapshot().phase, "launching");
  assert.match(h.runner.getSnapshot().reason, /не подтверждён/u);
  assert.throws(() => h.runner.start(), /floor_run_active/u);
  const restarted = setup({ saved: h.writes.at(-1) });
  assert.throws(() => restarted.runner.start(), /floor_run_active/u);
  assert.equal(restarted.launches(), 0);
});

test("stop during a pending launch does not erase its uncertain checkpoint", async () => {
  let release;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const h = setup({
    launch: async () => {
      signalStarted();
      await pending;
    },
  });
  h.runner.start();
  const tick = h.runner.tick();
  await started;
  h.runner.stop();
  release();
  await tick;
  assert.equal(h.runner.getSnapshot().phase, "launching");
  assert.throws(() => h.runner.start(), /floor_run_active/u);
});

test("never repeats a launch with an unknown outcome", async () => {
  let calls = 0;
  const h = setup({
    launch: async () => {
      calls++;
      throw new Error("lost reply");
    },
  });
  h.runner.start();
  await h.runner.tick();
  await h.runner.tick();
  assert.equal(calls, 1);
  assert.equal(h.runner.getSnapshot().status, "paused");
  const restored = setup({
    saved: { status: "running", phase: "launching", target: { kind: "work" } },
  });
  await restored.runner.tick();
  assert.equal(restored.launches(), 0);
  assert.equal(restored.runner.getSnapshot().status, "paused");
});

test("does not launch when durable intent cannot be saved", async () => {
  let writes = 0;
  const h = setup({ persist: () => ++writes !== 2 });
  h.runner.start();
  await h.runner.tick();
  assert.equal(h.launches(), 0);
  assert.equal(h.runner.getSnapshot().status, "paused");
});

test("a game outage keeps the goal active and retries only the read", async () => {
  let reads = 0;
  const h = setup({
    plan: async () => {
      reads++;
      if (reads === 1) throw new Error("game unavailable");
      return {
        status: "ready",
        kind: "boss",
        apiId: 4,
        current: 0,
        required: 1,
      };
    },
  });
  h.runner.start();
  await h.runner.tick();
  assert.equal(h.runner.getSnapshot().status, "running");
  assert.equal(h.launches(), 0);
  for (let i = 0; i < 4; i++) h.advance();
  await h.runner.tick();
  assert.equal(reads, 2);
  assert.equal(h.launches(), 1);
});
