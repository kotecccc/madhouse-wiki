import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { inventoryGame } from "./helpers/inventory-game.mjs";

test("queued floor start waits for resources and stop cancels it without touching other work", async () => {
  const directory = mkdtempSync(join(tmpdir(), "floor-queue-service-"));
  const store = createAutomationStateStore({ directory });
  const service = createAutomationService({
    store,
    identifyPlayer: async () => ({ playerId: 101 }),
    fetcher: async () => {
      throw new Error("offline");
    },
    getBoss: () => null,
  });
  try {
    const entry = await service.identify("Bearer test.payload.sig");
    entry.floorActions.hasOtherWork = () => true;
    await service.command(entry, {
      id: "floor-queue-01",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "floor.start", action: {} },
    });
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].status, "queued");
    await service.command(entry, {
      id: "floor-stop-01",
      command: "floor.stop",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    assert.equal(service.snapshot(entry).queuedActions[0].status, "cancelled");
    assert.equal(service.snapshot(entry).floorRunner.status, "stopped");
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a recovered queue receipt reconciles while its floor runner is active", async () => {
  const directory = mkdtempSync(join(tmpdir(), "floor-queue-recovery-"));
  const store = createAutomationStateStore({ directory });
  const makeService = () =>
    createAutomationService({
      store,
      identifyPlayer: async () => ({ playerId: 101 }),
      fetcher: async () => {
        throw new Error("offline");
      },
      getBoss: () => null,
    });
  let service = makeService();
  try {
    let entry = await service.identify("Bearer test.payload.sig");
    await service.command(entry, {
      id: "floor-queue-01",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "floor.start", action: {} },
    });
    entry.floorRunner.start({ queueId: "floor-queue-01" });
    service.close();
    const saved = store.read("101");
    saved.queuedActions[0].status = "running";
    store.write("101", saved);
    service = makeService();
    entry = await service.identify("Bearer test.payload.sig");
    assert.equal(entry.actionQueue.hasDue(), true);
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(service.snapshot(entry).floorRunner.queueId, "floor-queue-01");
    assert.equal(service.snapshot(entry).floorRunner.status, "running");
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a short purchase can run while floor automation is planning", async () => {
  const directory = mkdtempSync(join(tmpdir(), "floor-queue-priority-"));
  const store = createAutomationStateStore({ directory });
  const game = inventoryGame();
  const service = createAutomationService({
    store,
    identifyPlayer: async () => ({ playerId: 101 }),
    fetcher: game.fetcher,
    getBoss: () => null,
  });
  try {
    const entry = await service.identify("Bearer test.payload.sig");
    entry.floorRunner.start();
    await service.command(entry, {
      id: "floor-purchase-1",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
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
    assert.equal(entry.actionQueue.hasDue(), true);
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(game.mutations().length, 1);
    assert.equal(service.snapshot(entry).floorRunner.status, "running");
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("floor mode owns a persisted work goal and stops it without a browser", async () => {
  const directory = mkdtempSync(join(tmpdir(), "floor-service-"));
  const store = createAutomationStateStore({ directory });
  const timers = [];
  const catalogue = {
    floors: [{ id: "a", code: "A" }],
    departments: [
      {
        id: "a1",
        code: "A1",
        floorId: "a",
        work: { id: "work:7", apiId: "7" },
      },
      { id: "a2", code: "A2", floorId: "a" },
    ],
    works: [{ workId: 7 }],
    bosses: [],
    businesses: [],
    businessUpgrades: [],
  };
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({ playerId: 101, nickname: "Test" });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/floors")
      return Response.json([{ code: "A", isAvailable: true }]);
    if (path === "/api/floors/A/info")
      return Response.json({
        departments: [
          { blockCode: "A1", unlocked: true },
          {
            blockCode: "A2",
            unlocked: false,
            requirements: [
              { type: "work_completions", workId: 7, current: 4, required: 5 },
            ],
          },
        ],
      });
    return Response.json([]);
  };
  const makeService = () =>
    createAutomationService({
      store,
      fetcher,
      getBoss: () => null,
      getBusinessCatalogue: () => catalogue,
      schedule: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      cancel: (timer) => {
        timer.cancelled = true;
      },
    });
  let service = makeService();
  try {
    await service.boot();
    let entry = await service.identify("Bearer test.payload.sig");
    const command = (name, id) =>
      service.command(entry, {
        id,
        command: name,
        expectedVersion: service.snapshot(entry).version,
        args: {},
      });
    await command("floor.start", "floor-start-1");
    await new Promise((resolve) => setTimeout(resolve, 2300));
    assert.equal(
      service.snapshot(entry).floorRunner.phase,
      "executing",
      JSON.stringify(service.snapshot(entry).floorRunner),
    );
    assert.equal(service.snapshot(entry).workFarm.run.workId, 7);
    assert.equal(store.read("101").floorRunner.target.apiId, 7);
    const interrupted = store.read("101");
    interrupted.floorRunner.phase = "launching";
    await assert.rejects(
      command("work.start", "other-work-1"),
      /floor_automation_controls_resources/,
    );
    await assert.rejects(
      command("character.start", "character-start-conflict"),
      /character_upgrade_quote_changed/,
    );
    service.close();
    service = makeService();
    await service.boot();
    entry = await service.identify("Bearer test.payload.sig");
    assert.equal(service.snapshot(entry).floorRunner.status, "running");
    assert.equal(service.snapshot(entry).workFarm.run.status, "running");
    await command("floor.stop", "floor-stop-1");
    assert.equal(service.snapshot(entry).floorRunner.status, "stopped");
    assert.equal(service.snapshot(entry).workFarm.run.status, "stopped");
    service.close();
    store.write("101", interrupted);
    service = makeService();
    await service.boot();
    entry = await service.identify("Bearer test.payload.sig");
    assert.equal(service.snapshot(entry).floorRunner.status, "paused");
    assert.equal(service.snapshot(entry).workFarm.run.status, "stopped");
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("floor raid waits for an invitation and stops without starting its own fight", async () => {
  const directory = mkdtempSync(join(tmpdir(), "floor-boss-service-"));
  const store = createAutomationStateStore({ directory });
  const calls = [];
  const timers = [];
  const catalogue = {
    floors: [{ id: "a", code: "A" }],
    departments: [
      { id: "a1", code: "A1", floorId: "a" },
      { id: "a2", code: "A2", floorId: "a" },
    ],
    works: [],
    bosses: [{ id: "boss-7", apiId: "7", numericId: 7 }],
    businesses: [],
    businessUpgrades: [],
  };
  let battle = null;
  let clockOffset = 0;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname,
      method = init.method || "GET";
    calls.push({ path, method });
    if (path === "/api/me")
      return Response.json({ playerId: 101, nickname: "Player" });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/floors")
      return Response.json([{ code: "A", isAvailable: true }]);
    if (path === "/api/floors/A/info")
      return Response.json({
        departments: [
          { blockCode: "A1", unlocked: true },
          {
            blockCode: "A2",
            unlocked: false,
            requirements: [
              { type: "boss_kills", bossId: 7, current: 0, required: 1 },
            ],
          },
        ],
      });
    if (path === "/api/me/bag")
      return Response.json({ combatItems: [], activityItems: [] });
    if (path === "/api/bosses/7" && method === "GET")
      return Response.json({
        id: 7,
        damageMax: 10,
        activeBattle: battle,
        state: { canStartFight: true },
      });
    if (path === "/api/bosses/7/battles" && method === "POST") {
      const now = Date.now();
      battle = {
        battleId: "fight-1",
        bossId: 7,
        status: "active",
        playerHealth: 80,
        playerMaxHealth: 100,
        bossHealth: 50,
        bossMaxHealth: 50,
        myDamage: 0,
        participantCount: 1,
        participants: [{ playerId: 101 }],
        actions: [],
        serverTimeUtc: new Date(now).toISOString(),
        cooldownUntilUtc: new Date(now).toISOString(),
        expiresAtUtc: new Date(now + 120000).toISOString(),
      };
      return Response.json({ battle });
    }
    if (path === "/api/bosses/battles/fight-1") return Response.json(battle);
    if (path === "/api/bosses/battles/fight-1/attack" && method === "POST") {
      battle = {
        ...battle,
        status: "won",
        bossHealth: 0,
        reward: { drops: [] },
      };
      return Response.json({ battle });
    }
    return Response.json([]);
  };
  const service = createAutomationService({
    store,
    fetcher,
    now: () => Date.now() + clockOffset,
    getBoss: (id) => ({ numericId: id, name: "Boss" }),
    getBusinessCatalogue: () => catalogue,
    random: () => 0,
    schedule: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
  });
  try {
    await service.boot();
    const entry = await service.identify("Bearer test.payload.sig");
    await service.command(entry, {
      id: "floor-boss-start",
      command: "floor.start",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    await new Promise((resolve) => setTimeout(resolve, 3500));
    const snapshot = service.snapshot(entry);
    assert.equal(
      snapshot.floorRunner.phase,
      "executing",
      JSON.stringify(snapshot.floorRunner),
    );
    assert.equal(snapshot.goal.boss.id, 7);
    assert.equal(snapshot.raid.enabled, true);
    assert.equal(
      calls.some(
        ({ path, method }) =>
          path === "/api/bosses/7/battles" && method === "POST",
      ),
      false,
    );
    await service.command(entry, {
      id: "floor-stop-boss",
      command: "floor.stop",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    assert.equal(service.snapshot(entry).floorRunner.status, "stopped");
    assert.equal(service.snapshot(entry).raid.enabled, false);
    assert.equal(service.snapshot(entry).auto.enabled, false);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
