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
