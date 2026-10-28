import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createBattleSeries } from "../scripts/automation/battle-series.mjs";
import { canStartAutoSeries } from "../src/features/bosses/BossBattle/boss-battle-auto.js";
import { inventoryGame } from "./helpers/inventory-game.mjs";
import { actionQueueCards } from "../src/features/action-queue/action-queue-view.js";

test("a ready farm defers the next fight and a waiting farm releases it", async () => {
  let priority = true;
  let starts = 0;
  let timerId = 0;
  const timers = new Map();
  const state = { boss: { id: 7 }, battle: null, canStart: true };
  const series = createBattleSeries({
    controller: {
      getSnapshot: () => state,
      subscribe: () => () => {},
      start: async ({ allowed }) => {
        if (allowed()) starts++;
      },
      startNextBattle: async () => {},
      attack: async () => {},
    },
    goal: {
      getSnapshot: () => ({ status: "active" }),
      canStart: () => true,
      subscribe: () => () => {},
    },
    priorityActive: () => priority,
    now: () => 1000,
    schedule: (callback) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  try {
    assert.equal(series.start(), true);
    let [id, callback] = timers.entries().next().value;
    timers.delete(id);
    await callback();
    assert.equal(starts, 0);
    assert.equal(series.getSnapshot().phase, "yielding");
    priority = false;
    [id, callback] = timers.entries().next().value;
    timers.delete(id);
    await callback();
    assert.equal(starts, 1);
  } finally {
    series.dispose();
  }
});

test("auto start receipts survive actor replacement and reload", () => {
  const state = { boss: { id: 7 }, battle: null, canStart: true };
  const options = {
    controller: {
      getSnapshot: () => state,
      subscribe: () => () => {},
      attack: async () => {},
    },
    goal: {
      getSnapshot: () => ({ status: "active" }),
      canStart: () => true,
      subscribe: () => () => {},
    },
    schedule: () => 1,
    cancel: () => {},
    now: () => 1000,
  };
  const series = createBattleSeries(options);
  try {
    assert.equal(series.start({ queueId: "auto-old" }), true);
    series.stop();
    assert.equal(series.start({ queueId: "auto-new" }), true);
    const saved = series.exportState();
    assert.deepEqual(saved.startReceipts, ["auto-old", "auto-new"]);
    const restored = createBattleSeries({
      ...options,
      savedStartReceipts: saved.startReceipts,
    });
    try {
      assert.deepEqual(
        restored.getSnapshot().startReceipts,
        saved.startReceipts,
      );
    } finally {
      restored.dispose();
    }
  } finally {
    series.dispose();
  }
});

const token = "Bearer series.payload.sig";
const startPath = "/api/bosses/7/battles";
const bossPath = "/api/bosses/7";
const battlePath = (id) => `/api/bosses/battles/${id}`;

function makeBattle(id, status, now, extra = {}) {
  return {
    battleId: id,
    bossId: 7,
    status,
    serverTimeUtc: new Date(now).toISOString(),
    cooldownUntilUtc: new Date(now).toISOString(),
    expiresAtUtc: new Date(now + 120_000).toISOString(),
    retryAfterMilliseconds: 0,
    playerHealth: 80,
    playerMaxHealth: 100,
    bossHealth: status === "active" ? 40 : 0,
    bossMaxHealth: 100,
    myDamage: 60,
    participantCount: 1,
    participants: [{ playerId: 101, nickname: "Player" }],
    actions: [],
    reward: { drops: [] },
    ...extra,
  };
}

function setup({
  initial = null,
  startFails = false,
  startReplyLost = false,
  terminalStatus = "won",
  invitationOutage = false,
  inviteAvailable = false,
  battleTtl = 120000,
  holdInvite = false,
  holdAttack = false,
  attackReplyLost = false,
  inventory = null,
  work = false,
  workEnergy = 10,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "automation-series-"));
  const store = createAutomationStateStore({ directory });
  const calls = [];
  const timers = [];
  let now = 1_000_000;
  let current = initial;
  let starts = 0;
  let workCycles = 0;
  let bossReads = 0;
  let rateLimitBoss = false;
  let holdNextPreflight = false;
  let finishPreflight;
  let finishInvite;
  let finishAttack;
  const fetcher = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    calls.push({ method, path: url.pathname });
    if (work && url.pathname === "/api/works/open")
      return Response.json({
        workId: 7,
        title: "Work",
        completedCycles: workCycles,
        tasks: [
          {
            id: 1,
            title: "Task",
            required: 1,
            progress: 0,
            energyCost: 1,
            canPerform: workEnergy > 0,
          },
        ],
        energy: {
          current: workEnergy,
          max: 10,
          regenIntervalSeconds: 120,
          secondsToNext: 100,
        },
      });
    if (work && url.pathname === "/api/works/tasks/perform") {
      workCycles++;
      return Response.json({
        workId: 7,
        title: "Work",
        completedCycles: workCycles,
        tasks: [
          {
            id: 1,
            title: "Task",
            required: 1,
            progress: 0,
            energyCost: 1,
            canPerform: true,
          },
        ],
        energy: {
          current: 9,
          max: 10,
          regenIntervalSeconds: 120,
          secondsToNext: 100,
        },
      });
    }
    if (
      inventory &&
      ["/api/clothing/by-category/1", "/api/weapons/buy"].includes(url.pathname)
    )
      return inventory.fetcher(input, init);
    if (url.pathname === "/api/me")
      return Response.json({
        playerId: 101,
        nickname: "Player",
        ...(work
          ? {
              energy: {
                current: workEnergy,
                max: 10,
                regenIntervalSeconds: 120,
                secondsToNext: 100,
              },
              wallet: { dollar: 100 },
            }
          : {}),
      });
    if (url.pathname === "/api/me/bag")
      return Response.json({ activityItems: [], consumables: [] });
    if (url.pathname === "/api/bosses/invitations")
      return invitationOutage
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({ items: [] });
    if (url.pathname === "/api/combat")
      return Response.json({ activeBattle: null });
    if (url.pathname === "/api/bosses/8" && method === "GET")
      return Response.json({
        id: 8,
        damageMax: 10,
        activeBattle: null,
        state: { canStartFight: true },
      });
    if (url.pathname === bossPath && method === "GET") {
      bossReads++;
      if (rateLimitBoss)
        return Response.json(
          { error: "rate limited" },
          { status: 429, headers: { "Retry-After": "120" } },
        );
      const response = () =>
        Response.json({
          id: 7,
          damageMax: 10,
          activeBattle:
            current?.status === "active" || bossReads === 1 ? current : null,
          state: { canStartFight: current?.status !== "active" },
        });
      if (holdNextPreflight && current?.status !== "active") {
        holdNextPreflight = false;
        return new Promise((resolve) => {
          finishPreflight = () => resolve(response());
        });
      }
      return response();
    }
    if (url.pathname === startPath && method === "POST") {
      if (startFails)
        return Response.json({ error: "start_failed" }, { status: 503 });
      starts++;
      current = makeBattle(`battle-${starts}`, "active", now, {
        expiresAtUtc: new Date(now + battleTtl).toISOString(),
        ...(inviteAvailable ? { maxParticipants: 10 } : {}),
      });
      if (startReplyLost) throw new TypeError("reply lost");
      return Response.json({ battle: current });
    }
    if (url.pathname.endsWith("/invitations/bulk") && method === "POST") {
      if (holdInvite)
        return new Promise((resolve) => {
          finishInvite = () => resolve(Response.json({ invitedCount: 1 }));
        });
      return Response.json({ invitedCount: 1 });
    }
    const id = url.pathname.match(/^\/api\/bosses\/battles\/([^/]+)$/)?.[1];
    if (id && method === "GET")
      return Response.json(current || makeBattle(id, "active", now));
    const attackId = url.pathname.match(
      /^\/api\/bosses\/battles\/([^/]+)\/attack$/,
    )?.[1];
    if (attackId && method === "POST") {
      if (holdAttack)
        await new Promise((resolve) => {
          finishAttack = resolve;
        });
      const rewardDrops =
        attackId === "battle-2"
          ? [
              {
                type: "activity_item",
                entityId: 55,
                name: "Business item",
                amount: 1,
                granted: true,
              },
            ]
          : [];
      current = makeBattle(attackId, terminalStatus, now, {
        playerHealth: terminalStatus === "lost" ? 0 : 80,
        bossHealth: terminalStatus === "lost" ? 40 : 0,
        reward: { drops: rewardDrops },
        ...(attackReplyLost ? { myDamage: 65 } : {}),
      });
      if (attackReplyLost) throw new TypeError("attack reply lost");
      return Response.json({ battle: current });
    }
    throw new Error(`Unexpected fake game route: ${method} ${url.pathname}`);
  };
  const service = createAutomationService({
    store,
    getBoss: (id) => ({
      numericId: id,
      name: "Boss",
      possibleDrops: [
        { type: "activity_item", entityId: 55, name: "Business item" },
      ],
    }),
    ...(work
      ? {
          getBusinessCatalogue: () => ({
            businesses: [],
            businessUpgrades: [],
            bosses: [],
            works: [{ workId: 7 }],
          }),
        }
      : {}),
    fetcher,
    now: () => now,
    random: () => 0,
    schedule: (callback, delay) => {
      const timer = { callback, delay, at: now + delay, canceled: false };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      if (timer) timer.canceled = true;
    },
  });
  async function flush() {
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 10; i++) await Promise.resolve();
  }
  async function settleAttack(entry) {
    for (
      let i = 0;
      i < 20 && service.snapshot(entry).battle.pending === "attack";
      i++
    )
      await flush();
  }
  async function advance(ms, entry = null) {
    await flush();
    if (entry) await settleAttack(entry);
    now += ms;
    for (let pass = 0; pass < 10; pass++) {
      const due = timers.filter((t) => !t.canceled && t.at <= now);
      if (!due.length) break;
      for (const timer of due) {
        timer.canceled = true;
        timer.callback();
      }
      await flush();
      if (entry) await settleAttack(entry);
    }
  }
  async function openAndConfigure(
    kind = "battles",
    targetCount = 2,
    extra = {},
  ) {
    const entry = await service.identify(token);
    let snap = service.snapshot(entry);
    await service.command(entry, {
      id: "openboss01",
      command: "open",
      expectedVersion: snap.version,
      args: { bossId: 7 },
    });
    await flush();
    snap = service.snapshot(entry);
    await service.command(entry, {
      id: "goalconf01",
      command: "goal.configure",
      expectedVersion: snap.version,
      args: {
        bossId: 7,
        kind,
        targetCount,
        itemKey: "activity_item:55",
        ...extra,
      },
    });
    return entry;
  }
  async function command(entry, id, name) {
    return service.command(entry, {
      id,
      command: name,
      expectedVersion: service.snapshot(entry).version,
    });
  }
  return {
    directory,
    store,
    service,
    fetcher,
    calls,
    timers,
    flush,
    advance,
    settleAttack,
    command,
    openAndConfigure,
    get starts() {
      return starts;
    },
    rateLimitBoss() {
      rateLimitBoss = true;
    },
    holdPreflight() {
      holdNextPreflight = true;
    },
    releasePreflight() {
      finishPreflight?.();
    },
    releaseInvite() {
      finishInvite?.();
    },
    releaseAttack() {
      finishAttack?.();
    },
    close() {
      service.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function withSetup(options, run) {
  const ctx = setup(options);
  try {
    await run(ctx);
  } finally {
    ctx.close();
  }
}

for (const mode of ["auto", "raid"])
  test(`direct ${mode} start does not enable an actor when preflight is rate limited`, async () => {
    await withSetup({}, async (ctx) => {
      const entry = await ctx.openAndConfigure();
      ctx.rateLimitBoss();
      const before = ctx.calls.length;
      await assert.rejects(
        ctx.service.command(entry, {
          id: `rate-limited-${mode}`,
          command: `${mode}.start`,
          expectedVersion: ctx.service.snapshot(entry).version,
          args:
            mode === "raid"
              ? { settings: { bossId: 7, kind: "battles", targetCount: 2 } }
              : {},
        }),
        /game_unavailable/,
      );
      await ctx.advance(30_000, entry);
      const snap = ctx.service.snapshot(entry);
      assert.equal(snap.auto.enabled, false);
      assert.equal(snap.raid.enabled, false);
      assert.equal(ctx.starts, 0);
      assert.equal(
        ctx.calls.slice(before).filter((call) => call.path === bossPath).length,
        1,
      );
    });
  });

for (const mode of ["auto", "raid"])
  test(`queued ${mode} start reads a newly selected boss once`, async () => {
    await withSetup({}, async (ctx) => {
      const entry = await ctx.service.identify(token);
      await ctx.service.command(entry, {
        id: "open-original-boss",
        command: "open",
        expectedVersion: ctx.service.snapshot(entry).version,
        args: { bossId: 7 },
      });
      await ctx.service.boot();
      await ctx.service.command(entry, {
        id: `new-boss-${mode}`,
        command: "queue.enqueue",
        expectedVersion: ctx.service.snapshot(entry).version,
        args: {
          type: `${mode}.start`,
          action: { settings: { bossId: 8, kind: "battles", targetCount: 1 } },
        },
      });
      const end = Date.now() + 4000;
      while (
        Date.now() < end &&
        ctx.service.snapshot(entry).queuedActions[0].status !== "completed"
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(
        ctx.service.snapshot(entry).queuedActions[0].status,
        "completed",
      );
      assert.equal(
        ctx.calls.filter((call) => call.path === "/api/bosses/8").length,
        1,
      );
    });
  });

test("goal-bound series wins two battles and does not start a third", async () => {
  await withSetup({}, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "autostart01", "auto.start");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.advance(0, entry);
    await ctx.advance(2000, entry);
    assert.equal(ctx.service.snapshot(entry).battle.battle.id, "battle-1");
    assert.equal(ctx.service.snapshot(entry).battle.battle.status, "won");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.advance(1000, entry);
    assert.equal(ctx.starts, 2);
    await ctx.advance(2000, entry);
    assert.equal(ctx.service.snapshot(entry).goal.status, "completed");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    assert.equal(ctx.starts, 2);
  });
});

test("restoring autobattle respects the durable shared queue cooldown", async () => {
  const ctx = setup();
  let restored;
  try {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "auto-before-shared-cooldown", "auto.start");
    assert.equal(ctx.store.read("101").auto.enabled, true);
    ctx.service.close();
    const clock = 1_000_000;
    ctx.store.acquireLease("cooldown-test", clock, 1000);
    ctx.store.setQueueCooldown(clock + 120000, 1, "cooldown-test", clock);
    ctx.store.releaseLease("cooldown-test");
    const before = ctx.calls.length;
    restored = createAutomationService({
      store: ctx.store,
      fetcher: ctx.fetcher,
      getBoss: (id) => ({ numericId: id, name: "Boss", possibleDrops: [] }),
      now: () => clock,
      schedule: () => ({ unref() {} }),
      cancel: () => {},
    });
    await restored.boot();
    assert.deepEqual(ctx.calls.slice(before), []);
  } finally {
    restored?.close();
    ctx.close();
  }
});

test("a ready work goal runs before the next automatic boss fight", async () => {
  await withSetup({ work: true }, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "autostart01", "auto.start");
    await ctx.service.command(entry, {
      id: "work-before-boss",
      command: "work.start",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: {
        workId: 7,
        targetCycles: 1,
        expectedCompletedCycles: 0,
        mode: "wait",
        maxActions: 10,
        durationHours: null,
        maxBoosters: 0,
        maxDollar: 0,
        allowPurchase: false,
      },
    });
    await ctx.advance(0, entry);
    assert.equal(ctx.starts, 0);
    assert.ok(
      ctx.calls.some((call) => call.path === "/api/works/tasks/perform"),
      JSON.stringify({
        run: ctx.service.snapshot(entry).workFarm.run,
        calls: ctx.calls,
      }),
    );
    await ctx.advance(2000, entry);
    await ctx.advance(1000, entry);
    assert.equal(ctx.service.snapshot(entry).workFarm.run.status, "completed");
    assert.equal(ctx.starts, 1);
    const workIndex = ctx.calls.findIndex(
      (call) => call.path === "/api/works/tasks/perform",
    );
    const bossIndex = ctx.calls.findIndex(
      (call) => call.path === startPath && call.method === "POST",
    );
    assert.ok(workIndex < bossIndex);
  });
});

test("an energy-waiting work goal does not stall automatic fights", async () => {
  await withSetup({ work: true, workEnergy: 0 }, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "autostart01", "auto.start");
    await ctx.service.command(entry, {
      id: "work-energy-wait",
      command: "work.start",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: {
        workId: 7,
        targetCycles: 1,
        expectedCompletedCycles: 0,
        mode: "wait",
        maxActions: 10,
        durationHours: null,
        maxBoosters: 0,
        maxDollar: 0,
        allowPurchase: false,
      },
    });
    await ctx.advance(0, entry);
    assert.equal(ctx.service.snapshot(entry).workFarm.run.phase, "waiting");
    assert.equal(ctx.starts, 0);
    await ctx.advance(1000, entry);
    assert.equal(ctx.starts, 1);
  });
});

test("automatic single battle stops when there is no goal", async () => {
  await withSetup({}, async (ctx) => {
    const entry = await ctx.service.identify(token);
    let snap = ctx.service.snapshot(entry);
    await ctx.service.command(entry, {
      id: "openboss02",
      command: "open",
      expectedVersion: snap.version,
      args: { bossId: 7 },
    });
    await ctx.flush();
    await ctx.command(entry, "manualstart02", "start");
    await ctx.command(entry, "autostart02", "auto.start");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.settleAttack(entry);
    await ctx.advance(10_000, entry);
    assert.equal(ctx.service.snapshot(entry).battle.battle.status, "won");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    assert.equal(ctx.starts, 1);
  });
});

test("business item goal continues after a win with no item and completes on next reward", async () => {
  await withSetup({}, async (ctx) => {
    const entry = await ctx.openAndConfigure("business_items", 1);
    await ctx.command(entry, "autostart03", "auto.start");
    await ctx.settleAttack(entry);
    await ctx.advance(0, entry);
    await ctx.advance(2000, entry);
    assert.equal(ctx.service.snapshot(entry).goal.status, "active");
    await ctx.advance(1000, entry);
    assert.equal(ctx.starts, 2);
    await ctx.advance(10_000, entry);
    assert.equal(ctx.service.snapshot(entry).goal.status, "completed");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
  });
});

test("max attempts exhausts after a loss without starting another battle", async () => {
  await withSetup(
    {
      initial: makeBattle("battle-1", "active", 1_000_000),
      terminalStatus: "lost",
    },
    async (ctx) => {
      const entry = await ctx.openAndConfigure("business_items", 1, {
        maxAttempts: 1,
      });
      await ctx.command(entry, "autostart04", "auto.start");
      assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
      await ctx.advance(10_000, entry);
      assert.equal(ctx.service.snapshot(entry).goal.status, "exhausted");
      assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
      assert.equal(ctx.starts, 0);
    },
  );
});

test("auto.stop cancels the queued next battle", async () => {
  await withSetup(
    { initial: makeBattle("battle-1", "won", 1_000_000) },
    async (ctx) => {
      const entry = await ctx.openAndConfigure("battles", 2);
      await ctx.command(entry, "autostart05", "auto.start");
      assert.equal(ctx.service.snapshot(entry).auto.phase, "between_battles");
      await ctx.command(entry, "autostop05", "auto.stop");
      await ctx.advance(1000);
      assert.equal(ctx.starts, 0);
      assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    },
  );
});

test("raid.stop keeps invitations and auto attacks until the current fight ends", async () => {
  await withSetup({ inviteAvailable: true }, async (ctx) => {
    const entry = await ctx.openAndConfigure("battles", 3);
    assert.equal(entry.raidWorker.start(7), true);
    await entry.raidWorker.tick();
    assert.equal(ctx.service.snapshot(entry).battle.battle.status, "active");
    await ctx.command(entry, "raidstopfinish01", "raid.stop");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    assert.equal(ctx.store.read("101").raid.stopAfterBattle, true);
    await ctx.advance(10000, entry);
    await ctx.advance(10000, entry);
    await entry.raidWorker.tick();
    await ctx.advance(10000, entry);
    assert.equal(
      ctx.calls.filter(
        (call) => call.path.endsWith("/attack") && call.method === "POST",
      ).length,
      1,
    );
    assert.equal(
      ctx.calls.filter(
        (call) =>
          call.path.endsWith("/invitations/bulk") && call.method === "POST",
      ).length,
      1,
    );
    assert.equal(ctx.starts, 1);
    assert.equal(ctx.service.snapshot(entry).raid.enabled, false);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
  });
});

test("a stopped raid continues its current fight after the original time limit", async () => {
  await withSetup({ battleTtl: 7200000 }, async (ctx) => {
    const entry = await ctx.openAndConfigure("time", null, {
      durationHours: 1,
    });
    assert.equal(entry.raidWorker.start(7), true);
    await entry.raidWorker.tick();
    await ctx.command(entry, "raidstopdeadline", "raid.stop");
    await ctx.advance(3600001, entry);
    assert.equal(
      ctx.calls.filter(
        (call) => call.path.endsWith("/attack") && call.method === "POST",
      ).length,
      1,
    );
    assert.equal(ctx.starts, 1);
  });
});

test("raid.stop lets an already submitted invitation finish and then attacks", async () => {
  await withSetup({ inviteAvailable: true, holdInvite: true }, async (ctx) => {
    const entry = await ctx.openAndConfigure("battles", 3);
    assert.equal(entry.raidWorker.start(7), true);
    await entry.raidWorker.tick();
    await ctx.advance(2000, entry);
    assert.equal(ctx.service.snapshot(entry).battle.pending, "invite");
    await ctx.command(entry, "stop-invitation", "raid.stop");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    ctx.releaseInvite();
    await ctx.flush();
    await ctx.advance(5000, entry);
    assert.equal(
      ctx.calls.filter(
        (call) =>
          call.path.endsWith("/invitations/bulk") && call.method === "POST",
      ).length,
      1,
    );
    assert.equal(
      ctx.calls.filter(
        (call) => call.path.endsWith("/attack") && call.method === "POST",
      ).length,
      1,
    );
  });
});

test("stop during next battle preflight prevents its start POST", async () => {
  await withSetup(
    { initial: makeBattle("battle-1", "won", 1_000_000) },
    async (ctx) => {
      const entry = await ctx.openAndConfigure("battles", 2);
      await ctx.command(entry, "autostart06", "auto.start");
      ctx.holdPreflight();
      await ctx.advance(1000);
      assert.ok(
        ctx.calls.some(
          (call) => call.method === "GET" && call.path === bossPath,
        ),
      );
      await ctx.command(entry, "autostop06", "auto.stop");
      ctx.releasePreflight();
      await ctx.flush();
      assert.equal(ctx.starts, 0);
    },
  );
});

test("a farm queued during fight preflight prevents the start without losing either goal", async () => {
  await withSetup(
    { work: true, initial: makeBattle("battle-1", "won", 1_000_000) },
    async (ctx) => {
      const entry = await ctx.openAndConfigure("battles", 2);
      await ctx.command(entry, "autostart-work", "auto.start");
      ctx.holdPreflight();
      await ctx.advance(1000);
      await ctx.service.command(entry, {
        id: "work-during-preflight",
        command: "work.start",
        expectedVersion: ctx.service.snapshot(entry).version,
        args: {
          workId: 7,
          targetCycles: 1,
          expectedCompletedCycles: 0,
          mode: "wait",
          maxActions: 10,
          durationHours: null,
          maxBoosters: 0,
          maxDollar: 0,
          allowPurchase: false,
        },
      });
      ctx.releasePreflight();
      await ctx.flush();
      assert.equal(ctx.starts, 0);
      assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
      await ctx.advance(3000, entry);
      await ctx.advance(3000, entry);
      assert.equal(
        ctx.service.snapshot(entry).workFarm.run.status,
        "completed",
      );
      assert.equal(ctx.starts, 1);
    },
  );
});

test("unknown start result preserves waiting intent without retry", async () => {
  await withSetup({ startFails: true }, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "autostart07", "auto.start");
    await ctx.advance(0);
    await ctx.advance(5000);
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path === startPath,
      ).length,
      1,
    );
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
  });
});

test("enabled series restored at terminal checkpoint resumes once after preflight", async () => {
  await withSetup(
    { initial: makeBattle("battle-1", "won", 1_000_000) },
    async (ctx) => {
      const entry = await ctx.openAndConfigure("battles", 2);
      await ctx.command(entry, "autostart08", "auto.start");
      const saved = ctx.store.read("101");
      assert.equal(saved.auto.enabled, true);
      ctx.service.close();
      const resumed = createAutomationService({
        store: ctx.store,
        getBoss: (id) => ({
          numericId: id,
          name: "Boss",
          reference: { possibleDrops: [] },
        }),
        fetcher: async (...args) => {
          const [url, init] = args;
          const path = new URL(url).pathname;
          ctx.calls.push({ method: init?.method || "GET", path });
          if (path === "/api/me")
            return Response.json({ playerId: 101, nickname: "Player" });
          if (path === "/api/combat")
            return Response.json({ activeBattle: null });
          if (path === bossPath)
            return Response.json({
              id: 7,
              damageMax: 10,
              activeBattle: null,
              state: { canStartFight: true },
            });
          if (path === startPath && init.method === "POST") {
            ctx.restoredStarts = (ctx.restoredStarts || 0) + 1;
            return Response.json({
              battle: makeBattle("battle-2", "active", 1_000_000),
            });
          }
          if (path === battlePath("battle-1"))
            return Response.json(makeBattle("battle-1", "won", 1_000_000));
          if (path === battlePath("battle-2"))
            return Response.json(makeBattle("battle-2", "active", 1_000_000));
          throw new Error(`Unexpected fake route: ${path}`);
        },
        now: () => 1_000_000,
        random: () => 0,
        schedule: (callback, delay) => {
          const timer = { callback, at: 1_000_000 + delay, canceled: false };
          ctx.timers.push(timer);
          return timer;
        },
        cancel: (timer) => {
          if (timer) timer.canceled = true;
        },
      });
      try {
        await resumed.boot();
        await ctx.flush();
        const timer = ctx.timers.find((item) => !item.canceled);
        timer?.callback();
        await ctx.flush();
        assert.equal(ctx.restoredStarts, 1);
        assert.equal(
          ctx.calls.filter(
            (call) => call.method === "POST" && call.path === startPath,
          ).length,
          1,
        );
      } finally {
        resumed.close();
      }
    },
  );
});

test("expired time goal cancels queued next battle", async () => {
  await withSetup(
    { initial: makeBattle("battle-1", "won", 1_000_000) },
    async (ctx) => {
      const entry = await ctx.openAndConfigure("time", 1, { durationHours: 1 });
      await ctx.command(entry, "autostart09", "auto.start");
      await ctx.advance(3_600_000);
      assert.equal(ctx.service.snapshot(entry).goal.status, "completed");
      await ctx.advance(1000);
      assert.equal(ctx.starts, 0);
      assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    },
  );
});

test("expired quantitative goal cancels queued next battle", async () => {
  await withSetup(
    { initial: makeBattle("battle-1", "won", 1_000_000) },
    async (ctx) => {
      const entry = await ctx.openAndConfigure("battles", 5, {
        durationHours: 1,
      });
      await ctx.command(entry, "autostart10", "auto.start");
      await ctx.advance(3_600_000);
      assert.equal(ctx.service.snapshot(entry).goal.status, "expired");
      await ctx.advance(1000);
      assert.equal(ctx.starts, 0);
      assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    },
  );
});

test("server series preserves enabled intent across a manual battle refresh", async () => {
  await withSetup(
    {
      initial: makeBattle("existing", "active", 1_000_000, {
        retryAfterMilliseconds: 30000,
      }),
    },
    async (f) => {
      const entry = await f.openAndConfigure();
      await f.command(entry, "start-refresh-case", "auto.start");
      await f.flush();
      assert.equal(f.service.snapshot(entry).auto.enabled, true);
      const postsBefore = f.calls.filter(
        (call) => call.method === "POST",
      ).length;
      await f.command(entry, "refresh-active-case", "refresh");
      await f.flush();
      assert.equal(f.service.snapshot(entry).auto.enabled, true);
      assert.equal(
        f.calls.filter((call) => call.method === "POST").length,
        postsBefore,
      );
      await f.command(entry, "stop-refresh-case", "auto.stop");
      assert.equal(f.service.snapshot(entry).auto.enabled, false);
    },
  );
});

test("invitation series attacks its active joined battle but never starts a solo battle after it", () => {
  let now = 10_000;
  let state = {
    boss: { id: 7 },
    battle: {
      id: "invited-battle",
      status: "active",
      readyAt: now + 1000,
      expiresAt: now + 60_000,
      playerHealth: 80,
      playerMaxHealth: 100,
      bossHealth: 40,
      bossMaxHealth: 100,
      cooldownKnown: true,
    },
    invitationOnly: true,
    pending: null,
    needsRefresh: false,
    error: null,
    medicineOpen: false,
    purchase: null,
    purchaseUncertain: false,
  };
  const controllerListeners = new Set();
  const goalListeners = new Set();
  const timers = new Map();
  let timerId = 0;
  let soloStarts = 0;
  const controller = {
    getSnapshot: () => state,
    subscribe(listener) {
      controllerListeners.add(listener);
      return () => controllerListeners.delete(listener);
    },
    start: async () => {
      soloStarts++;
    },
    startNextBattle: async () => {
      soloStarts++;
    },
    attack: async () => {},
  };
  const goal = {
    getSnapshot: () => ({ status: "active" }),
    canStart: () => true,
    subscribe(listener) {
      goalListeners.add(listener);
      return () => goalListeners.delete(listener);
    },
  };
  const series = createBattleSeries({
    controller,
    goal,
    now: () => now,
    schedule(callback, delay) {
      const id = ++timerId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    random: () => 0,
  });
  assert.equal(canStartAutoSeries(state, { status: "active" }, now), true);
  assert.equal(series.start(), true);
  assert.equal(timers.size, 1);

  state = {
    ...state,
    battle: { ...state.battle, status: "won", playerHealth: 80, bossHealth: 0 },
  };
  for (const listener of controllerListeners) listener();
  for (const listener of goalListeners) listener();
  assert.equal(canStartAutoSeries(state, { status: "active" }, now), false);
  assert.equal(series.getSnapshot().enabled, false);
  assert.equal(timers.size, 0);
  assert.equal(soloStarts, 0);
  series.dispose();
});

for (const { joined, outage } of [
  { joined: false, outage: false },
  { joined: true, outage: false },
  { joined: false, outage: true },
])
  test(`adaptive raid reaches its goal without invitations, previous joined ${joined}, outage ${outage}`, async () => {
    await withSetup(
      {
        invitationOutage: outage,
        ...(joined
          ? { initial: makeBattle("joined-finished", "won", 1_000_000) }
          : {}),
      },
      async (ctx) => {
        const entry = await ctx.openAndConfigure();
        if (joined)
          entry.controller.restoreState({
            ...entry.controller.getSnapshot(),
            invitationOnly: true,
          });
        await ctx.service.command(entry, {
          id: "adaptive-raid-start",
          command: "raid.start",
          expectedVersion: ctx.service.snapshot(entry).version,
          args: {
            settings: {
              bossId: 7,
              kind: "battles",
              countWins: true,
              targetCount: 2,
              durationHours: 1,
            },
          },
        });
        await entry.raidWorker.tick();
        assert.equal(ctx.starts, 1);
        await ctx.advance(2000, entry);
        assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
        assert.equal(ctx.service.snapshot(entry).raid.enabled, true);
        await entry.raidWorker.tick();
        assert.equal(ctx.starts, 2);
        await ctx.advance(2000, entry);
        await entry.raidWorker.tick();
        assert.equal(ctx.service.snapshot(entry).goal.status, "completed");
        assert.equal(ctx.service.snapshot(entry).raid.enabled, false);
        assert.equal(ctx.starts, 2);
        assert.ok(
          ctx.calls.filter((c) => c.path === "/api/bosses/invitations")
            .length >= 2,
        );
      },
    );
  });

for (const phase of ["attacking", "waiting"])
  test(`restoring an ended single-fight ${phase} checkpoint yields to invitation selection`, () => {
    let scheduled = 0;
    const state = {
      boss: { id: 7 },
      battle: { id: "ended", status: "won" },
      canStart: true,
      pending: null,
    };
    const series = createBattleSeries({
      controller: {
        getSnapshot: () => state,
        subscribe: () => () => {},
        start: () => {
          throw new Error("must not start");
        },
        attack: async () => {},
      },
      goal: {
        getSnapshot: () => ({ status: "active" }),
        canStart: () => true,
        subscribe: () => () => {},
      },
      schedule: () => {
        scheduled++;
        return 1;
      },
      cancel: () => {},
    });
    series.start({
      checkpoint: { singleBattle: true, singleBattleId: "ended", phase },
    });
    assert.equal(series.getSnapshot().enabled, false);
    assert.equal(scheduled, 0);
    series.dispose();
  });

test("pausing a boss series persists its goal, prevents starts and resumes at a safe boundary", async () => {
  await withSetup({}, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "autostart-pause-1", "auto.start");
    await ctx.command(entry, "autopause-0001", "auto.pause");
    let state = ctx.service.snapshot(entry);
    assert.equal(state.auto.userPaused, true);
    assert.equal(state.auto.enabled, false);
    assert.equal(state.goal.status, "active");
    assert.ok(ctx.store.read("101").pausedAuto);
    const originalGoal = structuredClone(state.goal);
    await assert.rejects(
      ctx.command(entry, "auto-replace-paused", "auto.start"),
      /automation_paused_resume_or_stop/,
    );
    await assert.rejects(
      ctx.command(entry, "raid-replace-auto", "raid.start"),
      /raid_start_unavailable/,
    );
    assert.deepEqual(ctx.service.snapshot(entry).goal, originalGoal);
    await ctx.advance(5000, entry);
    assert.equal(ctx.starts, 0);
    await ctx.service.boot();
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    await ctx.command(entry, "autoresume-001", "auto.resume");
    assert.equal(ctx.service.snapshot(entry).auto.resumeRequested, true);
    const end = Date.now() + 3000;
    while (Date.now() < end && !ctx.service.snapshot(entry).auto.enabled)
      await new Promise((resolve) => setTimeout(resolve, 25));
    state = ctx.service.snapshot(entry);
    assert.equal(state.auto.enabled, true);
    assert.equal(state.auto.userPaused, false);
    await ctx.advance(0, entry);
    assert.equal(ctx.starts, 1);
    await ctx.command(entry, "autostop-pause", "auto.stop");
  });
});

test("paused autobattle remains paused after worker restart", async () => {
  const ctx = setup();
  let restored;
  try {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "autostart-rest", "auto.start");
    await ctx.command(entry, "autopause-rest", "auto.pause");
    ctx.service.close();
    const timers = [];
    restored = createAutomationService({
      store: ctx.store,
      fetcher: ctx.fetcher,
      getBoss: (id) => ({ numericId: id, name: "Boss", possibleDrops: [] }),
      now: () => 1_000_000,
      random: () => 0,
      schedule: (callback) => {
        timers.push(callback);
        return callback;
      },
      cancel: () => {},
    });
    await restored.boot();
    const after = await restored.identify(token);
    assert.equal(restored.snapshot(after).auto.userPaused, true);
    assert.equal(restored.snapshot(after).auto.enabled, false);
    assert.equal(ctx.starts, 0);
    assert.equal(restored.snapshot(after).goal.status, "active");
    assert.equal(timers.length, 0);
  } finally {
    restored?.close();
    ctx.close();
  }
});

test("paused queued autobattle retains its identity and history after restart and pruning", async () => {
  const ctx = setup();
  let restored;
  try {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "clear-before-queued-auto", "goal.stop");
    await ctx.service.boot();
    await ctx.service.command(entry, {
      id: "paused-queued-auto",
      command: "queue.enqueue",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: {
        type: "auto.start",
        action: {
          settings: {
            bossId: 7,
            kind: "battles",
            targetCount: 2,
            maxAttempts: 2,
          },
        },
      },
    });
    const end = Date.now() + 4000;
    while (Date.now() < end && !ctx.service.snapshot(entry).auto.enabled)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).auto.queueId,
      "paused-queued-auto",
    );
    await ctx.command(entry, "pause-queued-auto", "auto.pause");
    ctx.service.close();
    const saved = ctx.store.read("101");
    for (let i = 0; i < 130; i++)
      saved.queuedActions.push({
        id: `older-completed-${i}`,
        type: "friend.favorite",
        args: { playerId: i + 1, enabled: false },
        status: "completed",
        priority: 30,
        createdAt: 1_001_000 + i,
        finishedAt: 1_001_000 + i,
      });
    ctx.store.write("101", saved);
    restored = createAutomationService({
      store: ctx.store,
      fetcher: ctx.fetcher,
      getBoss: (id) => ({ numericId: id, name: "Boss", possibleDrops: [] }),
      now: () => 1_010_000,
      random: () => 0,
      schedule: () => ({ unref() {} }),
      cancel: () => {},
    });
    await restored.boot();
    const after = await restored.identify(token);
    const view = restored.snapshot(after);
    assert.equal(view.auto.userPaused, true);
    assert.equal(view.auto.queueId, "paused-queued-auto");
    assert.ok(
      !actionQueueCards(view).some((card) => card.id === "paused-queued-auto"),
    );
    await restored.command(after, {
      id: "trigger-history-prune",
      command: "queue.enqueue",
      expectedVersion: view.version,
      args: {
        type: "friend.favorite",
        action: { playerId: 999, enabled: false },
      },
    });
    assert.ok(
      ctx.store
        .read("101")
        .queuedActions.some((job) => job.id === "paused-queued-auto"),
    );
  } finally {
    restored?.close();
    ctx.close();
  }
});

test("queued purchase uses a safe gap in an active autobattle and the battle continues", async () => {
  const inventory = inventoryGame();
  const initial = makeBattle("active-1", "active", 1_000_000, {
    cooldownUntilUtc: new Date(1_010_000).toISOString(),
  });
  await withSetup({ initial, inventory }, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.service.boot();
    await ctx.command(entry, "auto-shop-start", "auto.start");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.service.command(entry, {
      id: "queue-buy-boss",
      command: "queue.enqueue",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: {
        type: "inventory",
        action: {
          type: "weapon",
          id: 1,
          action: "buy",
          price: { amount: 100, currency: "gold" },
        },
      },
    });
    const end = Date.now() + 3000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].status,
      "completed",
    );
    assert.equal(inventory.mutations().length, 1);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.advance(11000, entry);
    assert.ok(
      ctx.calls.some(
        (call) => call.path.endsWith("/attack") && call.method === "POST",
      ),
    );
  });
});

test("queued purchase waits for a submitted boss attack before using its resources", async () => {
  const inventory = inventoryGame();
  const initial = makeBattle("active-1", "active", 1_000_000);
  await withSetup({ initial, inventory, holdAttack: true }, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.service.boot();
    await ctx.command(entry, "auto-held-start", "auto.start");
    await ctx.advance(3000, entry);
    assert.equal(ctx.service.snapshot(entry).battle.pending, "attack");
    await ctx.service.command(entry, {
      id: "queue-held-buy",
      command: "queue.enqueue",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: {
        type: "inventory",
        action: {
          type: "weapon",
          id: 1,
          action: "buy",
          price: { amount: 100, currency: "gold" },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(inventory.mutations().length, 0);
    assert.equal(ctx.service.snapshot(entry).queuedActions[0].status, "queued");
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].blockedBy,
      "action",
    );
    ctx.releaseAttack();
    await ctx.flush();
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].status,
      "completed",
    );
    assert.equal(inventory.mutations().length, 1);
  });
});

test("pausing during a submitted strike never repeats it and preserves the goal", async () => {
  const initial = makeBattle("active-1", "active", 1_000_000);
  await withSetup({ initial, holdAttack: true }, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.service.boot();
    await ctx.command(entry, "auto-inflight-start", "auto.start");
    await ctx.advance(3000, entry);
    assert.equal(ctx.service.snapshot(entry).battle.pending, "attack");
    await ctx.command(entry, "auto-inflight-pause", "auto.pause");
    assert.equal(ctx.service.snapshot(entry).auto.userPaused, true);
    ctx.releaseAttack();
    await ctx.flush();
    await ctx.advance(30000, entry);
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/attack"),
      ).length,
      1,
    );
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    assert.equal(ctx.service.snapshot(entry).goal.status, "active");
    await ctx.command(entry, "auto-inflight-resume", "auto.resume");
    const end = Date.now() + 3000;
    while (Date.now() < end && !ctx.service.snapshot(entry).auto.enabled)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    assert.equal(
      ctx.calls.filter(
        (call) => call.method === "POST" && call.path.endsWith("/attack"),
      ).length,
      1,
    );
  });
});

test("a paused raid retains its battle and goal and can safely resume or stop", async () => {
  await withSetup({ inviteAvailable: true }, async (ctx) => {
    const entry = await ctx.openAndConfigure("battles", 3);
    assert.equal(entry.raidWorker.start(7), true);
    await entry.raidWorker.tick();
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.command(entry, "raid-pause-0001", "raid.pause");
    assert.equal(ctx.service.snapshot(entry).raid.userPaused, true);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    assert.equal(ctx.service.snapshot(entry).goal.status, "active");
    const originalGoal = structuredClone(ctx.service.snapshot(entry).goal);
    await assert.rejects(
      ctx.command(entry, "raid-replace-paused", "raid.start"),
      /raid_start_unavailable/,
    );
    assert.deepEqual(ctx.service.snapshot(entry).goal, originalGoal);
    await ctx.advance(30000, entry);
    assert.equal(
      ctx.calls.filter(
        (call) => call.path.endsWith("/attack") && call.method === "POST",
      ).length,
      0,
    );
    await ctx.command(entry, "raid-resume-001", "raid.resume");
    await entry.raidWorker.tick();
    assert.equal(ctx.service.snapshot(entry).raid.enabled, true);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.command(entry, "raid-pause-0002", "raid.pause");
    await ctx.command(entry, "raid-stop-paused", "raid.stop");
    assert.equal(ctx.service.snapshot(entry).raid.userPaused, false);
    assert.equal(ctx.service.snapshot(entry).goal.status, "stopped");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
  });
});

test("raid pause marker prevents a pre-pause auto checkpoint from restarting after a crash", async () => {
  const ctx = setup({ inviteAvailable: true });
  let restored;
  try {
    const entry = await ctx.openAndConfigure("battles", 3);
    entry.raidWorker.start(7);
    await entry.raidWorker.tick();
    const oldAuto = structuredClone(ctx.store.read("101").auto);
    assert.equal(oldAuto.enabled, true);
    await ctx.command(entry, "raid-crash-pause", "raid.pause");
    const paused = ctx.store.read("101");
    paused.auto = oldAuto;
    ctx.store.write("101", paused);
    ctx.service.close();
    restored = createAutomationService({
      store: ctx.store,
      fetcher: ctx.fetcher,
      getBoss: (id) => ({ numericId: id, name: "Boss" }),
      now: () => 1_000_000,
      schedule: () => ({}),
      cancel: () => {},
    });
    await restored.boot();
    const after = await restored.identify(token);
    assert.equal(restored.snapshot(after).raid.userPaused, true);
    assert.equal(restored.snapshot(after).auto.enabled, false);
    assert.equal(
      ctx.calls.filter(
        (call) => call.path.endsWith("/attack") && call.method === "POST",
      ).length,
      0,
    );
  } finally {
    restored?.close();
    ctx.close();
  }
});

test("queued manual boss start writes a checkpoint and starts one fight", async () => {
  await withSetup({}, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.service.boot();
    await ctx.service.command(entry, {
      id: "manual-queue-start",
      command: "queue.enqueue",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: { type: "battle.start", action: { bossId: 7 } },
    });
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].status,
      "completed",
    );
    assert.equal(ctx.starts, 1);
    assert.ok(
      ctx.store
        .read("101")
        .manualBattle.receipts.includes("manual-queue-start"),
    );
    assert.equal(ctx.store.read("101").manualBattle.pending, null);
  });
});

test("queued manual start with a lost reply reconciles after server restart", async () => {
  const ctx = setup({ startReplyLost: true });
  let restored;
  try {
    const entry = await ctx.openAndConfigure();
    await ctx.service.boot();
    await ctx.service.command(entry, {
      id: "manual-start-lost",
      command: "queue.enqueue",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: { type: "battle.start", action: { bossId: 7 } },
    });
    let end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "reconciling"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].status,
      "reconciling",
    );
    assert.equal(
      ctx.store.read("101").manualBattle.pending.id,
      "manual-start-lost",
    );
    assert.equal(ctx.starts, 1);
    ctx.service.close();
    restored = createAutomationService({
      store: ctx.store,
      fetcher: ctx.fetcher,
      getBoss: (id) => ({ numericId: id, name: "Boss", possibleDrops: [] }),
      now: () => 1_100_000,
      random: () => 0,
    });
    await restored.boot();
    const after = await restored.identify(token);
    end = Date.now() + 4000;
    while (
      Date.now() < end &&
      restored.snapshot(after).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(restored.snapshot(after).queuedActions[0].status, "completed");
    assert.equal(ctx.starts, 1);
    assert.equal(ctx.store.read("101").manualBattle.pending, null);
  } finally {
    restored?.close();
    ctx.close();
  }
});

test("queued manual attack executes against the selected battle once", async () => {
  const initial = makeBattle("active-1", "active", 1_000_000);
  await withSetup({ initial }, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.service.boot();
    await ctx.service.command(entry, {
      id: "manual-queue-attack",
      command: "queue.enqueue",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: {
        type: "battle.attack",
        action: { bossId: 7, battleId: "active-1" },
      },
    });
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].status,
      "completed",
    );
    assert.equal(
      ctx.calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path === "/api/bosses/battles/active-1/attack",
      ).length,
      1,
    );
    assert.ok(
      ctx.store
        .read("101")
        .manualBattle.receipts.includes("manual-queue-attack"),
    );
  });
});

test("lost manual attack response is reconciled on server restart without replay", async () => {
  const initial = makeBattle("active-1", "active", 1_000_000);
  const ctx = setup({ initial, attackReplyLost: true });
  let restored;
  try {
    const entry = await ctx.openAndConfigure();
    await ctx.service.boot();
    await ctx.service.command(entry, {
      id: "manual-attack-lost",
      command: "queue.enqueue",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: {
        type: "battle.attack",
        action: { bossId: 7, battleId: "active-1" },
      },
    });
    let end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "reconciling"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].status,
      "reconciling",
    );
    assert.equal(ctx.store.read("101").manualBattle.pending.kind, "attack");
    ctx.service.close();
    restored = createAutomationService({
      store: ctx.store,
      fetcher: ctx.fetcher,
      getBoss: (id) => ({ numericId: id, name: "Boss", possibleDrops: [] }),
      now: () => 1_100_000,
      random: () => 0,
    });
    await restored.boot();
    const after = await restored.identify(token);
    end = Date.now() + 4000;
    while (
      Date.now() < end &&
      restored.snapshot(after).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(restored.snapshot(after).queuedActions[0].status, "completed");
    assert.equal(
      ctx.calls.filter(
        (call) =>
          call.method === "POST" &&
          call.path === "/api/bosses/battles/active-1/attack",
      ).length,
      1,
    );
  } finally {
    restored?.close();
    ctx.close();
  }
});

for (const mode of ["auto", "raid"])
  test(`queued ${mode} transfers its saved goal to one server actor`, async () => {
    await withSetup({}, async (ctx) => {
      const entry = await ctx.openAndConfigure();
      await ctx.command(entry, `clear-goal-${mode}`, "goal.stop");
      await ctx.service.boot();
      const settings = {
        bossId: 7,
        kind: "battles",
        targetCount: 2,
        countWins: false,
        durationHours: null,
        maxAttempts: 2,
      };
      await ctx.service.command(entry, {
        id: `queue-series-${mode}`,
        command: "queue.enqueue",
        expectedVersion: ctx.service.snapshot(entry).version,
        args: { type: `${mode}.start`, action: { settings } },
      });
      const end = Date.now() + 4000;
      while (
        Date.now() < end &&
        ctx.service.snapshot(entry).queuedActions[0].status !== "completed"
      )
        await new Promise((resolve) => setTimeout(resolve, 25));
      const state = ctx.service.snapshot(entry);
      assert.equal(state.queuedActions[0].status, "completed");
      assert.equal(state[mode].enabled, true);
      assert.equal(state[mode].queueId, `queue-series-${mode}`);
      assert.equal(state.goal.status, "active");
      assert.equal(ctx.store.read("101").pendingAutomation, null);
    });
  });

test("raid intent waits behind an active autobattle without stopping it", async () => {
  await withSetup({}, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "start-auto-before-raid", "auto.start");
    await ctx.service.boot();
    const settings = {
      bossId: 7,
      kind: "battles",
      targetCount: 3,
      countWins: false,
      durationHours: null,
      maxAttempts: 3,
    };
    await ctx.service.command(entry, {
      id: "raid-waiting-auto",
      command: "queue.enqueue",
      expectedVersion: ctx.service.snapshot(entry).version,
      args: { type: "raid.start", action: { settings } },
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(ctx.service.snapshot(entry).queuedActions[0].status, "queued");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    assert.equal(ctx.service.snapshot(entry).raid.enabled, false);
    await ctx.command(entry, "stop-auto-before-raid", "auto.stop");
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      ctx.service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(
      ctx.service.snapshot(entry).queuedActions[0].status,
      "completed",
    );
    assert.equal(ctx.service.snapshot(entry).raid.enabled, true);
    assert.equal(ctx.service.snapshot(entry).raid.queueId, "raid-waiting-auto");
  });
});
