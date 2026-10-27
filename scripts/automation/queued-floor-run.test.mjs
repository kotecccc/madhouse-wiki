import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { createFloorRunner } from "./floor-runner.mjs";
import { queuedFloorRunAdapter } from "./queued-floor-run.mjs";

function harness() {
  let time = 0;
  let busy = true;
  let floorSaved;
  let queueSaved;
  const floorRunner = createFloorRunner({
    persist: (record) => {
      floorSaved = structuredClone(record);
    },
    stopOwned: () => {},
    now: () => time,
  });
  const entry = { floorRunner, floorActions: { hasOtherWork: () => busy } };
  const makeQueue = (saved = []) =>
    createActionQueue({
      saved,
      adapters: { "floor.start": queuedFloorRunAdapter({ entry }) },
      persist: (records) => {
        queueSaved = records;
      },
      now: () => time,
      random: () => 0,
    });
  return {
    entry,
    makeQueue,
    floorSaved: () => floorSaved,
    queueSaved: () => queueSaved,
    free: () => {
      busy = false;
    },
    advance: (duration) => {
      time += duration;
    },
  };
}

test("floor start waits for another worker and saves its queue identity", async () => {
  const h = harness();
  const queue = h.makeQueue();
  queue.add({ id: "floor-queue-01", type: "floor.start", args: {} });
  await queue.tick();
  assert.equal(h.queueSaved()[0].status, "waiting");
  assert.equal(h.entry.floorRunner.getSnapshot().status, "stopped");
  h.free();
  h.advance(10000);
  await queue.tick();
  assert.equal(h.queueSaved()[0].status, "completed");
  assert.equal(h.floorSaved().queueId, "floor-queue-01");
  assert.equal(h.floorSaved().status, "running");
});

test("restart reconciles a started floor without starting it twice", async () => {
  const h = harness();
  h.free();
  h.entry.floorRunner.start({ queueId: "floor-queue-01" });
  h.entry.floorRunner.stop();
  h.entry.floorRunner.start({ queueId: "floor-queue-02" });
  const saved = [
    {
      id: "floor-queue-01",
      type: "floor.start",
      args: {},
      status: "running",
      priority: 1,
      createdAt: 0,
      attempts: 0,
    },
  ];
  const queue = h.makeQueue(saved);
  await queue.tick();
  assert.equal(h.queueSaved()[0].status, "completed");
  assert.equal(h.entry.floorRunner.getSnapshot().queueId, "floor-queue-02");
});

test("cancelled floor intent does not start after resources become free", async () => {
  const h = harness();
  const queue = h.makeQueue();
  queue.add({ id: "floor-queue-01", type: "floor.start", args: {} });
  await queue.tick();
  queue.stop("floor-queue-01");
  h.free();
  h.advance(10000);
  await queue.tick();
  assert.equal(h.queueSaved()[0].status, "cancelled");
  assert.equal(h.entry.floorRunner.getSnapshot().status, "stopped");
});
