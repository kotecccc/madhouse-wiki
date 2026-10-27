import { test } from "node:test";
import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { characterUpgradeQuote } from "../src/lib/character-stat-upgrades.js";

test("character action is account scoped, checkpointed, and never replayed after a lost reply", async () => {
  const directory = mkdtempSync(join(tmpdir(), "character-upgrade-"));
  const store = createAutomationStateStore({ directory });
  const profile = {
    playerId: 101,
    wallet: { gold: 10000, pills: 10000 },
    characterStats: { madness: { base: 20, total: 30 } },
    characterStatsUpgrade: {
      resetAtUtc: "2026-10-27T21:00:00Z",
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
    schedule: () => ({}),
    cancel: () => {},
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
    const quote = characterUpgradeQuote(
      snapshot.characterUpgrade.profile,
      "madness",
      1,
    );
    snapshot = await service.command(entry, {
      id: "upgrade-1",
      command: "character.upgrade",
      expectedVersion: snapshot.version,
      args: { stat: "madness", expected: quote },
    });
    assert.ok(snapshot.characterUpgrade.pending);
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
      /character_upgrade_uncertain/,
    );
    assert.equal(posts, 1);
    profile.characterStats.madness.base = 21;
    profile.wallet.gold -= 500;
    profile.characterStatsUpgrade.madness.dailyUsed = 1;
    profile.characterStatsUpgrade.madness.dailyRemaining = 17;
    const reconciled = await service.command(entry, {
      id: "refresh-2",
      command: "character.refresh",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    assert.equal(reconciled.characterUpgrade.pending, null);
    assert.match(reconciled.characterUpgrade.notice, /показывает повышение/);
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

test("server executes a batch point by point with fresh prices and a spending limit", async () => {
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
      profile.wallet.gold -= profile.characterStatsUpgrade.madness.nextCost;
      profile.characterStats.madness.base++;
      profile.characterStatsUpgrade.madness.dailyUsed++;
      profile.characterStatsUpgrade.madness.dailyRemaining--;
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
    assert.equal(posts.length, 3);
    assert.ok(posts.every((p) => p.amount === 1 && p.stat === "madness"));
    assert.equal(new Set(posts.map((p) => p.operationId)).size, 3);
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
      service.snapshot(entry).characterUpgrade.run.status === "running";
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(
      service.snapshot(entry).characterUpgrade.run.status,
      "uncertain",
    );
    assert.ok(service.snapshot(entry).characterUpgrade.pending);
    assert.equal(posts, 1);
    service.close();
    service = createAutomationService(options);
    entry = await service.identify("Bearer a.b.c");
    assert.equal(
      service.snapshot(entry).characterUpgrade.run.status,
      "uncertain",
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
