import test from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedBattleSeriesAdapter } from "./queued-battle-series.mjs";

for (const mode of ["auto", "raid"])
  test(`restart recognizes the already started ${mode} actor`, async () => {
    let starts = 0,
      saves = 0;
    const entry = {
      pendingAutomation: { id: "queued-series-1", createdGoal: true },
      auto: {
        getSnapshot: () => ({ queueId: "queued-series-1" }),
        start: () => {
          starts++;
        },
      },
      raidWorker: {
        getSnapshot: () => ({ queueId: "queued-series-1" }),
        start: () => {
          starts++;
        },
      },
      goal: {
        stop: () => {
          throw new Error("must preserve the running goal");
        },
      },
    };
    const adapter = queuedBattleSeriesAdapter({
      entry,
      mode,
      save: () => {
        saves++;
      },
    });
    const queue = createActionQueue({
      saved: [
        {
          id: "queued-series-1",
          type: `${mode}.start`,
          args: { settings: { bossId: 7 } },
          status: "running",
          priority: 15,
          createdAt: 0,
          attempts: 0,
        },
      ],
      adapters: { [`${mode}.start`]: adapter },
      now: () => 1000,
      persist: () => true,
    });
    await queue.tick();
    assert.equal(queue.snapshot()[0].status, "completed");
    assert.equal(entry.pendingAutomation, null);
    assert.equal(starts, 0);
    assert.equal(saves, 1);
  });

test("restart before actor start releases only the queue-created goal", async () => {
  let stopped = 0;
  const entry = {
    pendingAutomation: { id: "queued-series-1", createdGoal: true },
    auto: { getSnapshot: () => ({ enabled: false }) },
    goal: {
      stop: () => {
        stopped++;
      },
    },
  };
  const adapter = queuedBattleSeriesAdapter({
    entry,
    mode: "auto",
    save: () => {},
  });
  const queue = createActionQueue({
    saved: [
      {
        id: "queued-series-1",
        type: "auto.start",
        args: { settings: { bossId: 7 } },
        status: "running",
        priority: 15,
        createdAt: 0,
        attempts: 0,
      },
    ],
    adapters: { "auto.start": adapter },
    now: () => 1000,
    persist: () => true,
  });
  await queue.tick();
  assert.equal(queue.snapshot()[0].status, "waiting");
  assert.equal(entry.pendingAutomation, null);
  assert.equal(stopped, 1);
});
