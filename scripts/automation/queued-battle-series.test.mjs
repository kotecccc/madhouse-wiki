import test from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedBattleSeriesAdapter } from "./queued-battle-series.mjs";
import { defaultHealingSettings } from "./battle-assistant.mjs";

test("raid queue deduplicates a boss without silently discarding different settings", () => {
  const entry = { raidWorker: { getSnapshot: () => ({}) } };
  const adapter = queuedBattleSeriesAdapter({ entry, mode: "raid" });
  const queue = createActionQueue({
    adapters: { "raid.start": adapter },
    persist: () => true,
  });
  const args = (bossId, targetCount) => ({
    settings: { bossId, kind: "battles", targetCount },
  });
  const first = queue.add({
    id: "raid-job-one",
    type: "raid.start",
    args: args(7, 1),
  });
  const duplicate = queue.add({
    id: "raid-job-two",
    type: "raid.start",
    args: args(7, 1),
  });
  assert.throws(
    () =>
      queue.add({
        id: "raid-job-different",
        type: "raid.start",
        args: args(7, 5),
      }),
    /action_queue_duplicate_conflict/,
  );
  queue.add({ id: "raid-job-three", type: "raid.start", args: args(8, 5) });
  assert.equal(duplicate.id, first.id);
  assert.deepEqual(
    queue.snapshot().map((job) => job.args.settings.bossId),
    [7, 8],
  );
});

test("queued healing belongs to the selected boss and waits for the other battle", async () => {
  let current = { boss: { id: 8 }, battle: { id: "old", status: "active" } };
  let savedHealing = null;
  let starts = 0;
  const actor = {
    getSnapshot: () => ({}),
    start: () => {
      starts++;
      return true;
    },
  };
  const entry = {
    controller: {
      getSnapshot: () => current,
      open: async () => {
        current = { boss: { id: 7 }, battle: null };
      },
    },
    goal: { getSnapshot: () => null },
    assistant: {
      projection: () => ({ uncertain: false }),
      configure: (settings) => {
        savedHealing = settings;
      },
    },
    auto: actor,
  };
  const adapter = queuedBattleSeriesAdapter({
    entry,
    mode: "auto",
    getBoss: () => ({ numericId: 7 }),
    refresh: async () => true,
    configure: () => {},
    save: () => {},
  });
  const healingSettings = defaultHealingSettings();
  healingSettings.items.heal_10 = { enabled: true, limit: 5, currency: "gold" };
  healingSettings.enabled = true;
  let stored = [];
  let time = 1000;
  const makeQueue = (saved = []) =>
    createActionQueue({
      saved,
      adapters: { "auto.start": adapter },
      persist: (entries) => {
        stored = entries;
      },
      now: () => time,
      random: () => 0,
    });
  const queue = makeQueue();
  queue.add({
    id: "queued-heal-1",
    type: "auto.start",
    args: {
      settings: { bossId: 7, kind: "battles", targetCount: 1 },
      healingSettings,
    },
  });
  await queue.tick();
  assert.equal(stored[0].status, "waiting");
  assert.deepEqual(stored[0].args.healingSettings, healingSettings);
  assert.equal(savedHealing, null);
  assert.equal(starts, 0);
  current.battle = { id: "old", status: "won" };
  time = stored[0].nextAt;
  const restored = makeQueue(stored);
  await restored.tick();
  assert.equal(restored.snapshot()[0].status, "completed");
  assert.deepEqual(savedHealing, healingSettings);
  assert.equal(starts, 1);
});

for (const mode of ["auto", "raid"])
  test(`${mode} validates live boss progression before starting the queued goal`, async () => {
    let remaining = 3;
    let starts = 0;
    const actor = {
      getSnapshot: () => ({}),
      start: () => {
        starts++;
        return true;
      },
    };
    const entry = {
      controller: { getSnapshot: () => ({ boss: { id: 7 }, battle: null }) },
      floorActions: {
        plan: async ({ bossId }) => ({
          status: "ready",
          kind: "boss",
          apiId: bossId,
          required: 10,
          current: 10 - remaining,
        }),
      },
      goal: { getSnapshot: () => null },
      assistant: { begin: () => true },
      auto: actor,
      raidWorker: actor,
    };
    const adapter = queuedBattleSeriesAdapter({
      entry,
      mode,
      refresh: async () => true,
      configure: () => {},
      save: () => {},
    });
    const args = adapter.validate({
      progressionTarget: true,
      settings: { bossId: 7, kind: "battles", targetCount: 3, countWins: true },
    });
    const job = { id: "target-goal", args };
    remaining = 2;
    assert.deepEqual(await adapter.execute(job, { canDispatch: () => true }), {
      status: "failed",
      reason: "progression_target_changed",
    });
    assert.equal(starts, 0);
    remaining = 3;
    assert.deepEqual(await adapter.execute(job, { canDispatch: () => true }), {
      status: "completed",
    });
    assert.equal(starts, 1);
  });

test("a queued single battle starts only the exact still-active fight", async () => {
  let battle = { id: "fight-1", status: "active" };
  let started = null;
  const entry = {
    controller: { getSnapshot: () => ({ boss: { id: 7 }, battle }) },
    auto: {
      getSnapshot: () => ({}),
      start: (options) => {
        started = options;
        return true;
      },
    },
    goal: { getSnapshot: () => null },
  };
  const adapter = queuedBattleSeriesAdapter({
    entry,
    mode: "auto",
    refresh: async () => true,
    configure: () => {},
    save: () => {},
  });
  const args = adapter.validate({
    singleBattleId: "fight-1",
    settings: { bossId: 7, kind: "battles", targetCount: 1 },
  });
  const job = { id: "job-1", args };
  battle = { id: "different", status: "active" };
  assert.deepEqual(await adapter.execute(job, { canDispatch: () => true }), {
    status: "failed",
    reason: "battle_no_longer_active",
  });
  assert.equal(started, null);
  battle = { id: "fight-1", status: "active" };
  assert.deepEqual(await adapter.execute(job, { canDispatch: () => true }), {
    status: "completed",
  });
  assert.deepEqual(started, { queueId: "job-1", singleBattle: true });
});

for (const mode of ["auto", "raid"])
  for (const stage of ["open", "refresh"])
    for (const [status, reason] of [
      [401, "game_session_required"],
      [400, "game_request_rejected"],
    ])
      test(`${mode} rejects permanent ${status} during ${stage} before starting`, async () => {
        let starts = 0;
        let snapshot = { boss: stage === "open" ? null : { id: 7 } };
        const entry = {
          controller: {
            getSnapshot: () => snapshot,
            open: async () => {
              snapshot = {
                boss: { id: 7 },
                needsRefresh: true,
                error: "rejected",
                errorStatus: status,
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
            snapshot = { ...snapshot, error: "rejected", errorStatus: status };
            return false;
          },
        });
        const result = await adapter.execute(
          { id: "series-permanent", args: { settings: { bossId: 7 } } },
          { canDispatch: () => true },
        );
        assert.deepEqual(result, { status: "failed", reason });
        assert.equal(starts, 0);
      });

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
