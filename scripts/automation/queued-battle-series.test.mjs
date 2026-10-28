import test from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedBattleSeriesAdapter } from "./queued-battle-series.mjs";

for (const mode of ["auto", "raid"])
  for (const stage of ["open", "refresh"])
    test(`${mode} honors Retry-After during ${stage} without starting`, async () => {
      let reads = 0;
      let starts = 0;
      let snapshot = { boss: stage === "open" ? null : { id: 7 } };
      const entry = {
        controller: {
          getSnapshot: () => snapshot,
          open: async () => {
            snapshot = {
              boss: { id: 7 },
              needsRefresh: true,
              error: "rate limited",
              errorRetryAfterMs: 120_000,
            };
          },
        },
        auto: { getSnapshot: () => ({}), start: () => starts++ },
        raidWorker: { getSnapshot: () => ({}), start: () => starts++ },
      };
      const adapter = queuedBattleSeriesAdapter({
        entry,
        mode,
        getBoss: async () => ({ numericId: 7 }),
        refresh: async () => {
          reads++;
          snapshot = {
            ...snapshot,
            error: "rate limited",
            errorRetryAfterMs: 120_000,
          };
          return false;
        },
      });
      const queue = createActionQueue({
        adapters: { [`${mode}.start`]: adapter },
        persist: () => true,
        now: () => 1000,
        random: () => 0,
      });
      queue.add({
        id: "series-retry-1",
        type: `${mode}.start`,
        args: { settings: { bossId: 7, kind: "battles", targetCount: 1 } },
      });
      await queue.tick();
      assert.equal(queue.snapshot()[0].nextAt, 121_000);
      assert.equal(reads, stage === "open" ? 0 : 1);
      assert.equal(starts, 0);
    });

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

for (const mode of ["auto", "raid"])
  test(`${mode} does not restart an older intent after its actor was replaced`, async () => {
    const actor = {
      getSnapshot: () => ({
        queueId: "new-series",
        startReceipts: ["old-series"],
      }),
    };
    const entry = { auto: actor, raidWorker: actor };
    const adapter = queuedBattleSeriesAdapter({ entry, mode });
    assert.deepEqual(await adapter.reconcile({ id: "old-series" }), {
      status: "completed",
    });
    assert.deepEqual(await adapter.reconcile({ id: "unknown-series" }), {
      status: "uncertain",
      reason: "Проверяем результат.",
    });
    actor.getSnapshot = () => ({ enabled: true, queueId: null });
    assert.deepEqual(await adapter.reconcile({ id: "unknown-series" }), {
      status: "uncertain",
      reason: "Проверяем результат.",
    });
  });
