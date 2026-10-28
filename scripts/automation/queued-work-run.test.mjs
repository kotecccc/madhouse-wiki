import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { createWorkFarm } from "./work-farm.mjs";
import { queuedWorkRunAdapter } from "./queued-work-run.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationStateStore } from "./state-store.mjs";
import { createAutomationService } from "./service.mjs";

const args = {
  workId: 7,
  targetCycles: 12,
  expectedCompletedCycles: 10,
  mode: "wait",
  maxActions: 30000,
  durationHours: null,
  maxBoosters: 0,
  maxDollar: 0,
  allowPurchase: false,
};

test("queued work validates and retains the collection objective", () => {
  const adapter = queuedWorkRunAdapter({ entry: {} });
  assert.equal(
    adapter.validate({ ...args, collectStash: true }).collectStash,
    true,
  );
  assert.throws(
    () => adapter.validate({ ...args, collectStash: "yes" }),
    /invalid_work_run/,
  );
});

test("a queued work run records its receipt and never restarts after replacement", async () => {
  let state;
  const entry = { storageFailed: false };
  entry.workFarm = createWorkFarm({
    saved: {},
    onChange: () => {},
    schedule: () => 1,
    cancel: () => {},
  });
  const makeQueue = (saved = []) =>
    createActionQueue({
      saved,
      adapters: { "work.start": queuedWorkRunAdapter({ entry }) },
      persist: (items) => {
        state = items;
      },
    });
  let queue = makeQueue();
  queue.add({ id: "work-queue-01", type: "work.start", args });
  await queue.tick();
  assert.equal(entry.workFarm.getSnapshot().run.queueId, "work-queue-01");
  assert.equal(state[0].status, "completed");
  entry.workFarm.stop();
  entry.workFarm.start({ ...args, workId: 8 });
  const recovered = [{ ...state[0], status: "running" }];
  queue = makeQueue(recovered);
  await queue.tick();
  assert.equal(state[0].status, "completed");
  assert.equal(entry.workFarm.getSnapshot().run.workId, 8);
  entry.workFarm.dispose();
});

test("queued work rejects oversized or unbounded user limits", () => {
  const adapter = queuedWorkRunAdapter({ entry: {} });
  assert.throws(
    () => adapter.validate({ ...args, targetCycles: 1011 }),
    /invalid_work_run/,
  );
  assert.throws(
    () => adapter.validate({ ...args, maxDollar: -1 }),
    /invalid_work_run/,
  );
  const normalized = adapter.validate({
    ...args,
    mode: "energy",
    allowPurchase: true,
    maxDollar: 100,
  });
  assert.equal(normalized.allowPurchase, false);
  assert.equal(normalized.maxDollar, 0);
});

test("service waits for the existing farm before starting the next one", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-work-run-"));
  const store = createAutomationStateStore({ directory });
  const service = createAutomationService({
    store,
    identifyPlayer: async () => ({ playerId: 17 }),
    fetcher: async () => {
      throw new Error("offline");
    },
    getBoss: () => null,
    schedule: () => 1,
    cancel: () => {},
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    entry.workFarm.start({ ...args, workId: 8 });
    await service.command(entry, {
      id: "work-queue-01",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "work.start", action: args },
    });
    assert.equal(entry.actionQueue.hasDue(), false);
    entry.workFarm.stop();
    assert.equal(entry.actionQueue.hasDue(), true);
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(service.snapshot(entry).workFarm.run.workId, 7);
    assert.equal(service.snapshot(entry).workFarm.run.queueId, "work-queue-01");
    await assert.rejects(
      service.command(entry, {
        id: "dependent-floor-01",
        command: "queue.enqueue",
        expectedVersion: service.snapshot(entry).version,
        args: { type: "floor.start", action: {}, dependsOn: ["work-queue-01"] },
      }),
      /invalid_action_queue_dependency/,
    );
    await service.command(entry, {
      id: "dismiss-work-01",
      command: "queue.dismiss",
      expectedVersion: service.snapshot(entry).version,
      args: { id: "work-queue-01" },
    });
    assert.equal(service.snapshot(entry).queuedActions[0].dismissed, true);
    assert.equal(service.snapshot(entry).workFarm.run.status, "running");
    await service.command(entry, {
      id: "cancel-work-01",
      command: "queue.cancel",
      expectedVersion: service.snapshot(entry).version,
      args: { id: "work-queue-01" },
    });
    assert.equal(service.snapshot(entry).workFarm.run.status, "stopped");
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
