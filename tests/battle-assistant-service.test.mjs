import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { characterUpgradeQuote } from "../src/lib/character-stat-upgrades.js";

const token = "Bearer battle-assistant-service.payload.sig";
const start = 1_000_000;
const settings = {
  enabled: true,
  autoBuy: true,
  items: {
    heal_10: { enabled: true, limit: 3, currency: "gold" },
    heal_full: { enabled: true, limit: 2, currency: "pills" },
  },
  budgets: { gold: 100, dollar: 0, pills: 20 },
};

function createHarness({
  id = "battle-1",
  health = 40,
  medicineQuantity = 0,
  wallet = { gold: 100, dollar: 100, pills: 100 },
  readyAt = start,
  quotaFresh = true,
  totalDamage = 100,
  dropDamageRequired = 100,
  unknownPurchase = false,
  inviteResult = { invitedCount: 2 },
  nowStart = start,
  damageMax = 50,
  bossHits = [],
  healthLoss = 0,
  winOnAttack = false,
  omitHits = false,
  unknownAttack = false,
  attackApplied = true,
  bagUnavailable = false,
  characterTest = false,
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "battle-assistant-service-"));
  let now = nowStart;
  let hp = health;
  let currentDamageMax = damageMax;
  let battleStatus = "active";
  let quantity = medicineQuantity;
  let balance = { ...wallet };
  let currentId = id;
  let currentReadyAt = readyAt;
  let currentQuotaFresh = quotaFresh;
  let currentDamage = totalDamage;
  let purchaseUncertain = unknownPurchase;
  let runInvites = inviteResult;
  let holdNextBattleRead = false;
  let releaseBattleRead;
  let holdNextBossRead = false;
  let releaseBossRead;
  let bagFailure = bagUnavailable;
  let holdAttack = false;
  let releaseAttack;
  const charStats = { madness: { base: 20, total: 20 } };
  const charUpgrade = {
    resetAtUtc: "2099-01-01T00:00:00Z",
    madness: {
      currency: "gold",
      costPerPoint: 10,
      nextCost: 10,
      maxCost: 10,
      dailyLimit: 3,
      dailyUsed: 0,
      dailyRemaining: 3,
    },
  };
  const calls = [];
  const timers = [];
  let openSequence = 0;
  let service;
  const store = createAutomationStateStore({ directory });
  const rawBattle = () => ({
    battleId: currentId,
    bossId: 7,
    status: battleStatus,
    serverTimeUtc: new Date(now).toISOString(),
    cooldownUntilUtc: new Date(currentReadyAt).toISOString(),
    expiresAtUtc: new Date(now + 300_000).toISOString(),
    retryAfterMilliseconds: Math.max(0, currentReadyAt - now),
    playerHealth: hp,
    playerMaxHealth: 100,
    bossHealth: battleStatus === "won" ? 0 : 900,
    bossMaxHealth: 1000,
    myDamage: currentDamage,
    dropDamageRequired: currentQuotaFresh ? dropDamageRequired : undefined,
    maxParticipants: 10,
    participantCount: 1,
    participants: [{ playerId: 101, nickname: "Player" }],
    actions: [],
    reward: { drops: [] },
  });
  const medicines = () => ({
    combatItems: [
      {
        type: "heal_10",
        quantity,
        maxPurchaseQuantity: 20,
        prices: [
          { currency: "gold", amount: 5 },
          { currency: "dollar", amount: 7 },
        ],
      },
      {
        type: "heal_full",
        quantity: 0,
        maxPurchaseQuantity: 20,
        prices: [{ currency: "pills", amount: 3 }],
      },
    ],
  });
  const fetcher = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : null;
    const path = url.pathname;
    calls.push({ method, path, body });
    if (method === "POST") {
      const record = store.read("101");
      if (path === "/api/character-stats/upgrade") {
        assert.ok(record?.characterUpgrade?.pending);
      } else if (path.endsWith("/attack")) {
        assert.equal(record?.battle?.pending, "attack");
        assert.equal(record?.assistant?.pending?.kind, "attack");
      } else
        assert.ok(
          record?.assistant?.pending,
          `reservation missing before ${path}`,
        );
    }
    if (path === "/api/me" && method === "GET")
      return Response.json({
        playerId: 101,
        nickname: "Player",
        wallet: balance,
        ...(characterTest
          ? { characterStats: charStats, characterStatsUpgrade: charUpgrade }
          : {}),
      });
    if (path === "/api/character-stats/upgrade" && characterTest) {
      balance.gold -= 10;
      charStats.madness.base++;
      charStats.madness.total++;
      charUpgrade.madness.dailyUsed++;
      charUpgrade.madness.dailyRemaining--;
      return Response.json({
        success: true,
        balance,
        characterStats: charStats,
        characterStatsUpgrade: charUpgrade,
      });
    }
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/bosses/7" && method === "GET") {
      const response = () =>
        Response.json({
          id: 7,
          damageMax: currentDamageMax,
          activeBattle: rawBattle(),
          state: { canStartFight: false },
        });
      if (holdNextBossRead) {
        holdNextBossRead = false;
        return new Promise((resolve) => {
          releaseBossRead = () => resolve(response());
        });
      }
      return response();
    }
    if (path === `/api/bosses/battles/${currentId}` && method === "GET") {
      const response = () => Response.json(rawBattle());
      if (holdNextBattleRead) {
        holdNextBattleRead = false;
        return new Promise((resolve) => {
          releaseBattleRead = () => resolve(response());
        });
      }
      return response();
    }
    if (path === "/api/me/bag" && method === "GET")
      return bagFailure
        ? Response.json({}, { status: 503 })
        : Response.json(medicines());
    if (
      path === `/api/bosses/battles/${currentId}/items/use` &&
      method === "POST"
    ) {
      if (quantity < 1)
        return Response.json({ error: "empty" }, { status: 409 });
      quantity--;
      hp = Math.min(100, hp + 10);
      currentReadyAt = now;
      return Response.json({
        battle: rawBattle(),
        isDuplicate: false,
        itemResult: { type: body.type, quantity, healthRestored: 10 },
      });
    }
    if (path === "/api/me/bag/combat-items/buy" && method === "POST") {
      if (purchaseUncertain) throw new Error("simulated purchase timeout");
      quantity += body.quantity;
      const price = medicines()
        .combatItems.find((item) => item.type === body.type)
        .prices.find((item) => item.currency === body.currency).amount;
      balance[body.currency] -= body.quantity * price;
      return Response.json({ ok: true });
    }
    if (
      path === `/api/bosses/battles/${currentId}/attack` &&
      method === "POST"
    ) {
      if (holdAttack) {
        holdAttack = false;
        await new Promise((resolve) => {
          releaseAttack = resolve;
        });
      }
      if (attackApplied) currentDamage += 50;
      if (unknownAttack) throw new Error("simulated lost attack reply");
      currentReadyAt = now + 60_000;
      hp = Math.max(0, hp - healthLoss);
      if (winOnAttack) battleStatus = "won";
      return Response.json({
        battle: rawBattle(),
        ...(omitHits
          ? {}
          : {
              hits: bossHits.map((damage) => ({
                actor: "boss",
                damage,
                critical: false,
                targetHealth: hp,
              })),
            }),
      });
    }
    if (
      path === `/api/bosses/battles/${currentId}/invitations/bulk` &&
      method === "POST"
    )
      return runInvites instanceof Response
        ? runInvites.clone()
        : Response.json(runInvites);
    return Response.json(
      { error: `unexpected ${method} ${path}` },
      { status: 404 },
    );
  };
  const makeService = () =>
    createAutomationService({
      store,
      getBoss: (bossId) => ({ numericId: bossId, name: "Boss" }),

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
  service = makeService();

  async function flush() {
    for (let i = 0; i < 35; i++) await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    for (let i = 0; i < 20; i++) await Promise.resolve();
  }
  async function advance(ms) {
    now += ms;
    for (let pass = 0; pass < 12; pass++) {
      const due = timers.filter((timer) => !timer.canceled && timer.at <= now);
      if (!due.length) break;
      due.forEach((timer) => {
        timer.canceled = true;
        timer.callback();
      });
      await flush();
    }
  }
  async function open() {
    const entry = await service.identify(token);
    const snapshot = service.snapshot(entry);
    await service.command(entry, {
      id: `openboss${String(++openSequence).padStart(4, "0")}`,
      command: "open",
      expectedVersion: snapshot.version,
      args: { bossId: 7 },
    });
    await flush();
    return entry;
  }
  async function command(entry, id, name, args = {}) {
    return service.command(entry, {
      id,
      command: name,
      expectedVersion: service.snapshot(entry).version,
      args,
    });
  }
  return {
    directory,
    store,
    get service() {
      return service;
    },
    calls,
    timers,
    open,
    command,
    flush,
    advance,
    makeService,
    stopService() {
      service.close();
    },
    restart() {
      service.close();
      service = makeService();
    },
    cleanup() {
      service.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
    setQuantity(value) {
      quantity = value;
    },
    setBagUnavailable(value) {
      bagFailure = value;
    },
    holdAttack() {
      holdAttack = true;
    },
    releaseAttack() {
      releaseAttack?.();
    },
    holdBossRead() {
      holdNextBossRead = true;
    },
    releaseBossRead() {
      releaseBossRead?.();
    },
    setDamageMax(value) {
      currentDamageMax = value;
    },
    setPurchaseUncertain(value) {
      purchaseUncertain = value;
    },
    setQuota(value) {
      currentQuotaFresh = value;
    },
    setInviteResult(value) {
      runInvites = value;
    },
    holdBattleRead() {
      holdNextBattleRead = true;
    },
    releaseBattleRead() {
      releaseBattleRead?.();
    },
    get now() {
      return now;
    },
  };
}

test("service automation proceeds from danger through stock, buy, heal and attack", async () => {
  const ctx = createHarness({ health: 45 });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "healconfig01", "healing.configure", { settings });
    await ctx.command(entry, "autostart01", "auto.start");
    await ctx.flush();
    await ctx.advance(3000);
    await ctx.advance(3000);
    await ctx.advance(3000);
    await ctx.advance(3000);
    const mutations = ctx.calls
      .filter(({ method }) => method === "POST")
      .map(({ path }) => path);
    assert.deepEqual(mutations, [
      "/api/me/bag/combat-items/buy",
      "/api/bosses/battles/battle-1/items/use",
      "/api/bosses/battles/battle-1/invitations/bulk",
      "/api/bosses/battles/battle-1/attack",
    ]);
    const snapshot = ctx.service.snapshot(entry);
    assert.equal(snapshot.battle.healing.used.heal_10, 1);
    assert.ok(
      snapshot.battle.battle.localEvents.some((event) => event.kind === "heal"),
    );
    assert.ok(
      snapshot.battle.battle.localEvents.some(
        (event) => event.kind === "invite",
      ),
    );
    assert.equal(snapshot.battle.healing.spent.gold, 5);
    assert.equal(snapshot.battle.needsRefresh, false);
    assert.equal(snapshot.auto.enabled, true);
  } finally {
    ctx.cleanup();
  }
});

test("service restart preserves an unknown purchase reservation and never repeats it", async () => {
  const ctx = createHarness({ unknownPurchase: true });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "healconfig02", "healing.configure", { settings });
    await ctx.command(entry, "autostart02", "auto.start");
    await ctx.flush();
    await ctx.advance(3000);
    await ctx.advance(3000);
    const before = ctx.calls.filter(
      ({ path }) => path === "/api/me/bag/combat-items/buy",
    ).length;
    assert.equal(before, 1);
    assert.equal(ctx.store.read("101").assistant.pending.kind, "buy");
    ctx.restart();
    const restartedEntry = await ctx.service.identify(token);
    const pending = ctx.service.snapshot(restartedEntry).battle.healing;
    assert.equal(pending.uncertain, true);
    await ctx.command(restartedEntry, "autostart03", "auto.start");
    await ctx.advance(120_000);
    assert.equal(
      ctx.calls.filter(({ path }) => path === "/api/me/bag/combat-items/buy")
        .length,
      before,
    );
  } finally {
    ctx.cleanup();
  }
});

test("automatic purchase with an insufficient wallet sends no purchase POST", async () => {
  const ctx = createHarness({
    health: 45,
    wallet: { gold: 0, dollar: 0, pills: 0 },
  });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "healconfig06", "healing.configure", { settings });
    await ctx.command(entry, "autostart06", "auto.start");
    await ctx.flush();
    await ctx.advance(3000);
    await ctx.advance(3000);
    assert.equal(
      ctx.calls.some(
        ({ method, path }) =>
          method === "POST" && path === "/api/me/bag/combat-items/buy",
      ),
      false,
    );
    assert.equal(ctx.store.read("101").assistant.pending, null);
  } finally {
    ctx.cleanup();
  }
});

test("service invitations use a verified quota during a long attack cooldown", async () => {
  const ctx = createHarness({
    health: 80,
    readyAt: start + 90_000,
    totalDamage: 100,
  });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "healconfig03", "healing.configure", { settings });
    await ctx.command(entry, "autostart03", "auto.start");
    await ctx.flush();
    await ctx.advance(40_000);
    assert.ok(
      ctx.calls.some(
        ({ method, path }) =>
          method === "GET" && path === "/api/bosses/battles/battle-1",
      ),
      JSON.stringify(ctx.calls),
    );
    assert.ok(
      ctx.calls.some(
        ({ method, path }) =>
          method === "POST" && path.endsWith("/invitations/bulk"),
      ),
      JSON.stringify({
        calls: ctx.calls,
        timers: ctx.timers.map(({ at, delay, canceled }) => ({
          at,
          delay,
          canceled,
        })),
        auto: ctx.service.snapshot(entry).auto,
        battle: ctx.service.snapshot(entry).battle,
      }),
    );
    assert.equal(
      ctx.calls.some(
        ({ method, path }) => method === "POST" && path.endsWith("/attack"),
      ),
      false,
    );
    assert.ok(
      ctx.store.read("101").assistant.battles["battle-1"].inviteAt > ctx.now,
    );
  } finally {
    ctx.cleanup();
  }
});

test("missing API damageMax preserves waiting intent without an attack", async () => {
  const ctx = createHarness({ health: 45, damageMax: null });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "healconfig04", "healing.configure", { settings });
    await ctx.command(entry, "autostart04", "auto.start");
    await ctx.advance(120_000);
    assert.equal(
      ctx.calls.some(({ method }) => method === "POST"),
      false,
    );
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
  } finally {
    ctx.cleanup();
  }
});

test("stopping during a held quota refresh prevents the invitation POST", async () => {
  const ctx = createHarness({ health: 80, readyAt: start + 90_000 });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "healconfig05", "healing.configure", { settings });
    await ctx.command(entry, "autostart05", "auto.start");
    await ctx.flush();
    ctx.holdBattleRead();
    await ctx.advance(40_000);
    await ctx.flush();
    assert.ok(
      ctx.calls.some(
        ({ method, path }) =>
          method === "GET" && path === "/api/bosses/battles/battle-1",
      ),
    );
    await ctx.command(entry, "autostop05", "auto.stop");
    ctx.releaseBattleRead();
    await ctx.flush();
    assert.equal(
      ctx.calls.some(
        ({ method, path }) =>
          method === "POST" && path.endsWith("/invitations/bulk"),
      ),
      false,
    );
  } finally {
    ctx.cleanup();
  }
});

test("explicit reconciliation counts the reserved purchase and clears uncertainty without replay", async () => {
  const ctx = createHarness({ unknownPurchase: true });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "reconcile-config", "healing.configure", {
      settings,
    });
    await ctx.command(entry, "reconcile-start", "auto.start");
    await ctx.advance(3000);
    await ctx.advance(3000);
    assert.equal(ctx.store.read("101").assistant.pending.kind, "buy");
    const postCount = ctx.calls.filter((call) => call.method === "POST").length;
    await ctx.command(entry, "reconcile-read", "refresh");
    await ctx.command(entry, "reconcile-ack", "healing.ack");
    const state = ctx.service.snapshot(entry);
    assert.equal(state.battle.healing.uncertain, false);
    assert.equal(state.battle.purchaseUncertain, false);
    assert.equal(state.battle.healing.spent.pills, 3);
    assert.equal(state.auto.enabled, true);
    assert.equal(
      ctx.calls.filter((call) => call.method === "POST").length,
      postCount,
    );
  } finally {
    ctx.cleanup();
  }
});

for (const status of [403, 429])
  test(`invitation HTTP ${status} does not invalidate safe attacks`, async () => {
    const ctx = createHarness({
      health: 80,
      readyAt: start + 90000,
      inviteResult: Response.json({ retryAfterSeconds: 60 }, { status }),
    });
    try {
      const entry = await ctx.open();
      await ctx.command(entry, `invite-reject-${status}`, "auto.start");
      await ctx.advance(40000);
      const state = ctx.service.snapshot(entry);
      assert.equal(state.auto.enabled, true);
      assert.equal(state.battle.needsRefresh, false);
      assert.equal(state.battle.healing.uncertain, false);
      const saved = ctx.store.read("101").assistant.battles["battle-1"];
      if (status === 403) assert.equal(saved.inviteBlocked, true);
      else assert.equal(saved.inviteAt, ctx.now + 60000);
    } finally {
      ctx.cleanup();
    }
  });

test("a missing quota permits the first invitation and defers repeats without polling tightly", async () => {
  const ctx = createHarness({
    health: 80,
    readyAt: start + 90000,
    quotaFresh: false,
  });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "quota-unknown-start", "auto.start");
    await ctx.advance(40000);
    const reads = ctx.calls.length;
    await ctx.advance(2000);
    assert.equal(ctx.calls.length, reads);
    assert.equal(
      ctx.calls.filter(
        (call) =>
          call.method === "POST" && call.path.endsWith("/invitations/bulk"),
      ).length,
      1,
    );
    assert.ok(
      ctx.store.read("101").assistant.battles["battle-1"].inviteAt > ctx.now,
    );
  } finally {
    ctx.cleanup();
  }
});

test("actual damage equal to API damageMax keeps auto enabled while HP is sufficient", async () => {
  const ctx = createHarness({ health: 80, bossHits: [50] });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "equal-damage-start", "auto.start");
    await ctx.advance(3000);
    const state = ctx.service.snapshot(entry);
    assert.equal(state.auto.enabled, true);
  } finally {
    ctx.cleanup();
  }
});

test("auto startup refreshes damageMax from the API instead of a catalogue value or old snapshot", async () => {
  const ctx = createHarness({ health: 80, damageMax: 50 });
  try {
    const entry = await ctx.open();
    assert.equal(ctx.service.snapshot(entry).battle.damageLimit.value, 50);
    ctx.setDamageMax(90);
    await ctx.command(entry, "changed-damage-start", "auto.start");
    await ctx.advance(3000);
    const state = ctx.service.snapshot(entry);
    assert.equal(state.battle.damageLimit.value, 90);
    assert.equal(state.auto.enabled, true);
    assert.equal(
      ctx.calls.some((c) => c.method === "POST"),
      false,
    );
  } finally {
    ctx.cleanup();
  }
});

for (const damageMax of [undefined, -1, 1.5, "50"])
  test(`invalid API damageMax ${String(damageMax)} never starts an attack`, async () => {
    const ctx = createHarness({
      health: 80,
      damageMax: damageMax === undefined ? null : damageMax,
    });
    try {
      const entry = await ctx.open();
      await ctx.command(entry, "bad-max-start", "auto.start");
      await ctx.advance(3000);
      assert.equal(
        ctx.calls.some((c) => c.method === "POST"),
        false,
      );
      assert.equal(ctx.service.snapshot(entry).battle.damageLimit, null);
    } finally {
      ctx.cleanup();
    }
  });

test("waiting for treatment keeps the mode enabled and continues when API data permits", async () => {
  const ctx = createHarness({ health: 80, damageMax: 90 });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "wait-treatment-start", "auto.start");
    await ctx.advance(3000);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    assert.equal(
      ctx.calls.some((c) => c.method === "POST"),
      false,
    );
    ctx.setDamageMax(50);
    await ctx.advance(30000);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    assert.equal(
      ctx.calls.filter((c) => c.path.endsWith("/attack") && c.method === "POST")
        .length,
      1,
    );
  } finally {
    ctx.cleanup();
  }
});

test("inventory recovery heals and resumes without toggling the run or resetting counters", async () => {
  const ctx = createHarness({
    health: 45,
    bagUnavailable: true,
    medicineQuantity: 1,
  });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "read-failure-config", "healing.configure", {
      settings,
    });
    await ctx.command(entry, "read-failure-start", "auto.start");
    await ctx.advance(3000);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    assert.equal(ctx.service.snapshot(entry).auto.phase, "waiting");
    ctx.setBagUnavailable(false);
    await ctx.advance(30000);
    await ctx.advance(3000);
    await ctx.advance(3000);
    const state = ctx.service.snapshot(entry);
    assert.equal(state.auto.enabled, true);
    assert.equal(state.battle.healing.used.heal_10, 1);
    assert.equal(state.battle.needsRefresh, false);
    assert.equal(
      ctx.calls.filter((c) => c.path.endsWith("/attack") && c.method === "POST")
        .length,
      1,
    );
  } finally {
    ctx.cleanup();
  }
});

test("an uncertain strike waits durably and never replays after server restart", async () => {
  const ctx = createHarness({
    health: 80,
    unknownAttack: true,
    attackApplied: false,
  });
  try {
    const entry = await ctx.open();
    await ctx.command(entry, "unknown-strike-start", "auto.start");
    await ctx.advance(3000);
    assert.equal(ctx.store.read("101").assistant.pending.kind, "attack");
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.advance(60000);
    ctx.restart();
    await ctx.service.boot();
    const restored = await ctx.service.identify(token);
    await ctx.advance(60000);
    assert.equal(ctx.service.snapshot(restored).auto.enabled, true);
    assert.equal(
      ctx.calls.filter((c) => c.path.endsWith("/attack") && c.method === "POST")
        .length,
      1,
    );
  } finally {
    ctx.cleanup();
  }
});

test("explicit stop during API damageMax preflight cancels the pending start intent", async () => {
  const ctx = createHarness({ health: 80 });
  try {
    const entry = await ctx.open();
    ctx.holdBossRead();
    const pending = ctx.command(entry, "held-max-start", "auto.start");
    await ctx.flush();
    await ctx.command(entry, "held-max-stop", "auto.stop");
    ctx.releaseBossRead();
    await pending;
    await ctx.advance(60000);
    assert.equal(ctx.service.snapshot(entry).auto.enabled, false);
    assert.equal(
      ctx.calls.some((c) => c.method === "POST"),
      false,
    );
  } finally {
    ctx.cleanup();
  }
});

test("character priority waits for the in-flight strike and auto battle resumes afterwards", async () => {
  const ctx = createHarness({
    health: 100,
    wallet: { gold: 1000, dollar: 100, pills: 100 },
    characterTest: true,
  });
  try {
    const entry = await ctx.open();
    const initial = await ctx.command(
      entry,
      "character-read-1",
      "character.refresh",
    );
    const quote = characterUpgradeQuote(
      initial.characterUpgrade.profile,
      "madness",
      1,
    );
    ctx.holdAttack();
    await ctx.command(entry, "priority-auto-start", "auto.start");
    await ctx.advance(5000);
    assert.ok(
      ctx.calls.some((c) => c.path.endsWith("/attack") && c.method === "POST"),
    );
    assert.equal(entry.controller.getSnapshot().pending, "attack");
    const queued = await ctx.command(
      entry,
      "priority-character",
      "character.upgrade",
      { stat: "madness", expected: quote },
    );
    assert.equal(queued.characterUpgrade.run.status, "running");
    await ctx.advance(2000);
    assert.equal(
      ctx.calls.filter((c) => c.path === "/api/character-stats/upgrade").length,
      0,
    );
    ctx.releaseAttack();
    await ctx.flush();
    await ctx.advance(1000);
    await ctx.flush();
    assert.equal(
      ctx.calls.filter((c) => c.path === "/api/character-stats/upgrade").length,
      1,
    );
    assert.equal(
      ctx.service.snapshot(entry).characterUpgrade.run.status,
      "completed",
    );
    assert.equal(ctx.service.snapshot(entry).auto.enabled, true);
    await ctx.advance(65000);
    assert.ok(
      ctx.calls.filter((c) => c.path.endsWith("/attack") && c.method === "POST")
        .length >= 2,
    );
  } finally {
    ctx.releaseAttack();
    ctx.cleanup();
  }
});
