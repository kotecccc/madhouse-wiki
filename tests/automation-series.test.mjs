import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createBattleSeries } from "../scripts/automation/battle-series.mjs";
import { canStartAutoSeries } from "../src/features/bosses/BossBattle/boss-battle-auto.js";

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
  terminalStatus = "won",
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "automation-series-"));
  const store = createAutomationStateStore({ directory });
  const calls = [];
  const timers = [];
  let now = 1_000_000;
  let current = initial;
  let starts = 0;
  let bossReads = 0;
  let holdNextPreflight = false;
  let finishPreflight;
  const fetcher = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    calls.push({ method, path: url.pathname });
    if (url.pathname === "/api/me")
      return Response.json({ playerId: 101, nickname: "Player" });
    if (url.pathname === "/api/combat")
      return Response.json({ activeBattle: null });
    if (url.pathname === bossPath && method === "GET") {
      bossReads++;
      const response = () =>
        Response.json({
          id: 7,
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
      current = makeBattle(`battle-${starts}`, "active", now);
      return Response.json({ battle: current });
    }
    const id = url.pathname.match(/^\/api\/bosses\/battles\/([^/]+)$/)?.[1];
    if (id && method === "GET")
      return Response.json(current || makeBattle(id, "active", now));
    const attackId = url.pathname.match(
      /^\/api\/bosses\/battles\/([^/]+)\/attack$/,
    )?.[1];
    if (attackId && method === "POST") {
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
      });
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
    holdPreflight() {
      holdNextPreflight = true;
    },
    releasePreflight() {
      finishPreflight?.();
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

test("goal-bound series wins two battles and does not start a third", async () => {
  await withSetup({}, async (ctx) => {
    const entry = await ctx.openAndConfigure();
    await ctx.command(entry, "autostart01", "auto.start");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.advance(0, entry);
    assert.equal(ctx.service.snapshot(entry).battle.battle.id, "battle-1");
    assert.equal(ctx.service.snapshot(entry).battle.battle.status, "won");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.advance(1000, entry);
    assert.equal(ctx.starts, 2);
    assert.equal(ctx.service.snapshot(entry).goal.status, "completed");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    assert.equal(ctx.starts, 2);
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

test("failed start POST stops automatic execution without retry", async () => {
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
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
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
