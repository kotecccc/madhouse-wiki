import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";

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

test("floor stop leaves the current boss fight running to completion", async () => {
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
      true,
      JSON.stringify({ calls, raid: snapshot.raid, battle: snapshot.battle }),
    );
    await service.command(entry, {
      id: "floor-stop-boss",
      command: "floor.stop",
      expectedVersion: service.snapshot(entry).version,
      args: {},
    });
    assert.equal(service.snapshot(entry).floorRunner.status, "stopped");
    assert.equal(service.snapshot(entry).raid.stopAfterBattle, true);
    assert.equal(service.snapshot(entry).auto.enabled, true);
    for (
      let i = 0;
      i < 10 && !calls.some(({ path }) => path.endsWith("/attack"));
      i++
    ) {
      const timer = timers.find((item) => !item.cancelled);
      if (!timer) break;
      timer.cancelled = true;
      clockOffset += timer.delay + 1;
      await timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(
      calls.some(
        ({ path, method }) => path.endsWith("/attack") && method === "POST",
      ),
      true,
      JSON.stringify({
        calls,
        snapshot: service.snapshot(entry),
        timers: timers.map(({ delay, cancelled }) => ({ delay, cancelled })),
      }),
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
