import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  characterBattleUncertain,
  createAutomationService,
} from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { characterUpgradeQuote } from "../src/lib/character-stat-upgrades.js";

test("an unresolved assistant operation blocks stat spending even after battle reads recover", () => {
  assert.equal(
    characterBattleUncertain(
      { battle: { status: "active" } },
      { uncertain: false },
    ),
    false,
  );
  assert.equal(
    characterBattleUncertain(
      { battle: { status: "active" } },
      { uncertain: true },
    ),
    true,
  );
});

test("completed daily limits survive restart and skip passive reads until reset", async () => {
  const directory = mkdtempSync(join(tmpdir(), "character-daily-snapshot-"));
  const store = createAutomationStateStore({ directory });
  let clock = Date.parse("2026-10-28T12:00:00Z");
  let reads = 0;
  const stat = { dailyLimit: 2, dailyUsed: 2, dailyRemaining: 0 };
  const profile = {
    playerId: 101,
    wallet: { gold: 100, pills: 100 },
    characterStats: {},
    characterStatsUpgrade: {
      resetAtUtc: "2026-10-29T00:00:00Z",
      madness: stat,
      aggression: stat,
      rage: stat,
    },
  };
  const options = {
    store,
    now: () => clock,
    identifyPlayer: async () => ({ playerId: 101 }),
    getBoss: () => null,
    fetcher: async (url) => {
      if (new URL(url).pathname === "/api/me") {
        reads++;
        return Response.json(profile);
      }
      return Response.json({ items: [] });
    },
  };
  let service = createAutomationService(options);
  try {
    let entry = await service.identify("Bearer a.b.c");
    const refresh = (id, args = {}) =>
      service.command(entry, {
        id,
        command: "character.refresh",
        expectedVersion: service.snapshot(entry).version,
        args,
      });
    await refresh("daily-initial", { ifComplete: true });
    assert.equal(reads, 1);
    service.close();
    service = createAutomationService(options);
    entry = await service.identify("Bearer a.b.c");
    await refresh("daily-cached", { ifComplete: true });
    assert.equal(reads, 1);
    await refresh("daily-manual");
    assert.equal(reads, 2);
    entry.characterUpgrade.pending = { stat: "madness", resetAt: "unknown" };
    await refresh("daily-uncertain", { ifComplete: true });
    assert.equal(reads, 3);
    assert.ok(entry.characterUpgrade.pending);
    entry.characterUpgrade.pending = null;
    clock = Date.parse(profile.characterStatsUpgrade.resetAtUtc);
    await refresh("daily-reset", { ifComplete: true });
    assert.equal(reads, 4);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("character action is account scoped, checkpointed, and never replayed after a lost reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "character-upgrade-"));
  const store = createAutomationStateStore({ directory });
  const profile = {
    playerId: 101,
    wallet: { gold: 10000, pills: 10000, dollar: 1234 },
    characterStats: { madness: { base: 20, total: 30 } },
    characterStatsUpgrade: {
      resetAtUtc: "2099-01-01T00:00:00Z",
      madness: {
        currency: "gold",
        costPerPoint: 500,
        nextCost: 500,
        maxCost: 5000,
        dailyLimit: 18,
        dailyUsed: 0,
        dailyRemaining: 18,
      },
    },
  };
  let posts = 0;
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me") return Response.json(profile);
    if (path === "/api/character-stats/upgrade") {
      posts++;
      throw new Error("lost response");
    }
    return Response.json({ items: [] });
  };
  const options = {
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 101 }),
    getBoss: () => null,
    schedule: (fn) => setTimeout(fn, 0),
    cancel: clearTimeout,
  };
  let service = createAutomationService(options);
  try {
    let entry = await service.identify("Bearer a.b.c");
    let snapshot = await service.command(entry, {
      id: "refresh-1",
      command: "character.refresh",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    assert.equal(snapshot.characterUpgrade.profile.wallet.dollar, 1234);
    const quote = characterUpgradeQuote(
      snapshot.characterUpgrade.profile,
      "madness",
      1,
    );
    snapshot = await service.command(entry, {
      id: "upgrade-1",
      command: "character.upgrade",
      expectedVersion: Math.max(0, snapshot.version - 1),
      args: { stat: "madness", expected: quote },
    });
    assert.equal(snapshot.characterUpgrade.run.status, "running");
    for (
      let i = 0;
      i < 100 && !service.snapshot(entry).characterUpgrade.pending;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(service.snapshot(entry).characterUpgrade.pending);
    assert.equal(posts, 1);
    service.close();
    service = createAutomationService(options);
    entry = await service.identify("Bearer a.b.c");
    assert.ok(service.snapshot(entry).characterUpgrade.pending);
    await assert.rejects(
      service.command(entry, {
        id: "upgrade-2",
        command: "character.upgrade",
        expectedVersion: service.snapshot(entry).version,
        args: { stat: "madness", expected: quote },
      }),
      /character_batch_running/,
    );
    assert.equal(entry.actionQueue.snapshot().length, 0);
    assert.equal(posts, 1);
    profile.characterStats.madness.base = 21;
    profile.wallet.gold -= 500;
    profile.characterStatsUpgrade.madness.dailyUsed = 1;
    profile.characterStatsUpgrade.madness.dailyRemaining = 17;
    for (
      let i = 0;
      i < 100 && service.snapshot(entry).characterUpgrade.pending;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    const reconciled = await service.command(entry, {
      id: "refresh-2",
      command: "character.refresh",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    assert.equal(reconciled.characterUpgrade.pending, null);
    assert.equal(reconciled.characterUpgrade.run.completed, 1);
    assert.equal(posts, 1);
    profile.playerId = 202;
    await assert.rejects(
      service.command(entry, {
        id: "refresh-3",
        command: "character.refresh",
        expectedVersion: service.snapshot(entry).version,
        args: {},
      }),
      /character_profile_unavailable/,
    );
    assert.equal(posts, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("server executes MAX as one bounded multi-point request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "character-batch-"));
  const store = createAutomationStateStore({ directory });
  const profile = {
    playerId: 101,
    wallet: { gold: 10000, pills: 0 },
    characterStats: { madness: { base: 20, total: 30 } },
    characterStatsUpgrade: {
      resetAtUtc: "2099-01-01T00:00:00Z",
      madness: {
        currency: "gold",
        costPerPoint: 500,
        nextCost: 500,
        maxCost: 1000,
        dailyLimit: 3,
        dailyUsed: 0,
        dailyRemaining: 3,
      },
    },
  };
  const posts = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/me") return Response.json(profile);
    if (path === "/api/character-stats/upgrade") {
      const body = JSON.parse(init.body);
      posts.push(body);
      profile.wallet.gold -= 2500;
      profile.characterStats.madness.base += body.amount;
      profile.characterStatsUpgrade.madness.dailyUsed += body.amount;
      profile.characterStatsUpgrade.madness.dailyRemaining -= body.amount;
      profile.characterStatsUpgrade.madness.nextCost = 1000;
      profile.characterStatsUpgrade.madness.costPerPoint = 1000;
      return Response.json({
        success: true,
        balance: profile.wallet,
        characterStats: profile.characterStats,
        characterStatsUpgrade: profile.characterStatsUpgrade,
      });
    }
    return Response.json({ items: [] });
  };
  const service = createAutomationService({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 101 }),
    getBoss: () => null,
    schedule: (fn) => setTimeout(fn, 1),
    cancel: clearTimeout,
  });
  try {
    const entry = await service.identify("Bearer a.b.c");
    assert.equal(
      entry.controller.syncExternalBattle(
        { numericId: 7, name: "Boss" },
        { battleId: "battle-1", bossId: 7, status: "active" },
        entry.controller.getSnapshot(),
      ),
      true,
    );
    const initial = await service.command(entry, {
      id: "refresh-1",
      command: "character.refresh",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    const quote = characterUpgradeQuote(
      initial.characterUpgrade.profile,
      "madness",
      3,
    );
    await service.command(entry, {
      id: "batch-start",
      command: "character.start",
      expectedVersion: initial.version,
      args: { stat: "madness", amount: 3, expected: quote },
    });
    let current;
    for (let i = 0; i < 100; i++) {
      current = service.snapshot(entry).characterUpgrade;
      if (current.run.status !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(current.run.status, "completed");
    assert.equal(current.run.completed, 3);
    assert.equal(current.run.spent, 2500);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].amount, 3);
    assert.equal(posts[0].stat, "madness");
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("batch with a lost game response pauses across a server restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "character-batch-lost-"));
  const store = createAutomationStateStore({ directory });
  const profile = {
    playerId: 101,
    wallet: { gold: 10000, pills: 0 },
    characterStats: { madness: { base: 20, total: 30 } },
    characterStatsUpgrade: {
      resetAtUtc: "2099-01-01T00:00:00Z",
      madness: {
        currency: "gold",
        costPerPoint: 500,
        nextCost: 500,
        maxCost: 1000,
        dailyLimit: 3,
        dailyUsed: 0,
        dailyRemaining: 3,
      },
    },
  };
  let posts = 0;
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me") return Response.json(profile);
    if (path === "/api/character-stats/upgrade") {
      posts++;
      throw new Error("lost response");
    }
    return Response.json({ items: [] });
  };
  const options = {
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 101 }),
    getBoss: () => null,
  };
  let service = createAutomationService(options);
  try {
    let entry = await service.identify("Bearer a.b.c");
    const initial = await service.command(entry, {
      id: "refresh-1",
      command: "character.refresh",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    const quote = characterUpgradeQuote(
      initial.characterUpgrade.profile,
      "madness",
      3,
    );
    await service.command(entry, {
      id: "batch-start",
      command: "character.start",
      expectedVersion: initial.version,
      args: { stat: "madness", amount: 3, expected: quote },
    });
    for (
      let i = 0;
      i < 100 &&
      service.snapshot(entry).characterUpgrade.run.phase !== "reconciling";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      service.snapshot(entry).characterUpgrade.run.phase,
      "reconciling",
    );
    assert.ok(service.snapshot(entry).characterUpgrade.pending);
    assert.equal(posts, 1);
    service.close();
    service = createAutomationService(options);
    entry = await service.identify("Bearer a.b.c");
    assert.equal(
      service.snapshot(entry).characterUpgrade.run.phase,
      "reconciling",
    );
    assert.ok(service.snapshot(entry).characterUpgrade.pending);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(posts, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("start all validates shared currency totals and durably starts a multi-stat run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "character-all-"));
  const store = createAutomationStateStore({ directory });
  const config = {
    currency: "gold",
    costPerPoint: 100,
    nextCost: 100,
    maxCost: 100,
    dailyLimit: 2,
    dailyUsed: 0,
    dailyRemaining: 2,
  };
  const profile = {
    playerId: 101,
    wallet: { gold: 400, pills: 0 },
    characterStats: { madness: { base: 1 }, aggression: { base: 1 } },
    characterStatsUpgrade: {
      resetAtUtc: "2099-01-01T00:00:00Z",
      madness: { ...config },
      aggression: { ...config },
    },
  };
  const service = createAutomationService({
    store,
    fetcher: async (url) =>
      new URL(url).pathname === "/api/me"
        ? Response.json(profile)
        : Response.json({ items: [] }),
    identifyPlayer: async () => ({ playerId: 101 }),
    getBoss: () => null,
    schedule: () => ({}),
    cancel: () => {},
  });
  try {
    const entry = await service.identify("Bearer a.b.c");
    const quotes = ["madness", "aggression"].map((stat) =>
      characterUpgradeQuote(profile, stat, 2),
    );
    profile.wallet.gold = 399;
    await service.command(entry, {
      id: "all-refresh-1",
      command: "character.refresh",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    await assert.rejects(
      service.command(entry, {
        id: "all-test-1",
        command: "character.startAll",
        expectedVersion: service.snapshot(entry).version,
        args: { quotes },
      }),
      /character_upgrade_insufficient_funds/,
    );
    profile.wallet.gold = 400;
    await service.command(entry, {
      id: "all-refresh-2",
      command: "character.refresh",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    const snapshot = await service.command(entry, {
      id: "all-test-2",
      command: "character.startAll",
      expectedVersion: service.snapshot(entry).version,
      args: { quotes },
    });
    assert.equal(snapshot.characterUpgrade.run.status, "running");
    assert.equal(snapshot.characterUpgrade.run.target, 4);
    assert.deepEqual(
      snapshot.characterUpgrade.run.items.map((item) => item.budget),
      [200, 200],
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queued character intent survives restart without releasing a busy account lock", async () => {
  const directory = mkdtempSync(join(tmpdir(), "character-priority-restart-"));
  const store = createAutomationStateStore({ directory });
  const profile = {
    playerId: 101,
    wallet: { gold: 100, pills: 0 },
    characterStats: { madness: { base: 5, total: 5 } },
    characterStatsUpgrade: {
      resetAtUtc: "2099-01-01T00:00:00Z",
      madness: {
        currency: "gold",
        costPerPoint: 10,
        nextCost: 10,
        maxCost: 10,
        dailyLimit: 2,
        dailyUsed: 0,
        dailyRemaining: 2,
      },
    },
  };
  let posts = 0;
  const options = {
    store,
    identifyPlayer: async () => ({ playerId: 101 }),
    getBoss: () => null,
    schedule: (fn) => setTimeout(fn, 2),
    cancel: clearTimeout,
    fetcher: async (url) => {
      if (new URL(url).pathname === "/api/me") return Response.json(profile);
      if (new URL(url).pathname === "/api/character-stats/upgrade") {
        posts++;
        profile.wallet.gold -= 10;
        profile.characterStats.madness.base++;
        profile.characterStats.madness.total++;
        profile.characterStatsUpgrade.madness.dailyUsed++;
        profile.characterStatsUpgrade.madness.dailyRemaining--;
        return Response.json({
          success: true,
          balance: profile.wallet,
          characterStats: profile.characterStats,
          characterStatsUpgrade: profile.characterStatsUpgrade,
        });
      }
      return Response.json({ items: [] });
    },
  };
  let service = createAutomationService(options);
  try {
    let entry = await service.identify("Bearer priority-restart.payload.sig");
    const initial = await service.command(entry, {
      id: "priority-refresh",
      command: "character.refresh",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    const expected = characterUpgradeQuote(
      initial.characterUpgrade.profile,
      "madness",
      1,
    );
    entry.busy = true;
    const busyRefresh = await service.command(entry, {
      id: "priority-busy-refresh",
      command: "character.refresh",
      expectedVersion: initial.version,
      args: {},
    });
    assert.equal(busyRefresh.characterUpgrade.profile.wallet.gold, 100);
    assert.equal(entry.busy, true);
    const queued = await service.command(entry, {
      id: "priority-queued",
      command: "character.upgrade",
      expectedVersion: initial.version,
      args: { stat: "madness", expected },
    });
    assert.equal(entry.busy, true);
    assert.equal(queued.characterUpgrade.run.status, "running");
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(posts, 0);
    assert.equal(store.read("101").characterUpgrade.run.status, "running");
    service.close();
    service = createAutomationService(options);
    entry = await service.identify("Bearer priority-restart.payload.sig");
    for (
      let i = 0;
      i < 100 &&
      service.snapshot(entry).characterUpgrade.run.status === "running";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      service.snapshot(entry).characterUpgrade.run.status,
      "completed",
    );
    assert.equal(posts, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
