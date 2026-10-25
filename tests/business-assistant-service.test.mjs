import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

const tokenA = "Bearer businessA.payload.sig";
const tokenB = "Bearer businessB.payload.sig";
const businessId = "business:7";
const catalogue = {
  businesses: [
    { id: businessId, apiId: "7", title: "Мастерская", maxLevel: 5 },
  ],
  businessUpgrades: [
    {
      id: "business-upgrade:7",
      businessId,
      items: [{ entityId: 55, name: "Шестерня", levels: [2, 3, 4, 5, 6] }],
    },
  ],
  bosses: [
    {
      id: "boss:17",
      numericId: 17,
      name: "Сборщик",
      possibleDrops: [
        { type: "activity_item", entityId: 55, name: "Шестерня" },
      ],
      dropItems: [{ entityId: 55, name: "Шестерня" }],
    },
    {
      id: "boss:18",
      numericId: 18,
      name: "Смотритель",
      possibleDrops: [],
      dropItems: [],
    },
  ],
};

function createGame() {
  const calls = [];
  let quantity = 2;
  let foreignBattle = false;
  const fetcher = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = init.method || "GET";
    const authorization =
      init.headers?.Authorization || init.headers?.authorization || "";
    calls.push({ method, path: url.pathname, authorization });
    if (url.pathname === "/api/me")
      return Response.json({
        playerId: authorization === tokenB ? 202 : 101,
        nickname: authorization === tokenB ? "Bee" : "Alice",
      });
    if (url.pathname === "/api/combat")
      return Response.json({ activeBattle: null });
    if (url.pathname === "/api/me/bag")
      return Response.json({
        activityItems: [{ itemId: 55, quantity }],
      });
    if (url.pathname === "/api/businesses/7")
      return Response.json({
        id: 7,
        level: 1,
        maxLevel: 5,
        nextUpgradePrice: 100,
        nextUpgradeCurrency: "gold",
        requiredItems: [{ itemId: 55, requiredAmount: 3, playerAmount: 2 }],
      });
    if (url.pathname === "/api/bosses/17")
      return Response.json({
        id: 17,
        activeBattle: null,
        state: { canStartFight: true },
      });
    if (url.pathname === "/api/bosses/18")
      return Response.json({
        id: 18,
        activeBattle: foreignBattle
          ? {
              battleId: "foreign-battle",
              bossId: 18,
              status: "active",
              serverTimeUtc: new Date(1_000_000).toISOString(),
              cooldownUntilUtc: new Date(1_000_000).toISOString(),
              expiresAtUtc: new Date(1_120_000).toISOString(),
              retryAfterMilliseconds: 0,
              playerHealth: 80,
              playerMaxHealth: 100,
              bossHealth: 40,
              bossMaxHealth: 100,
              myDamage: 60,
              participantCount: 1,
              participants: [{ playerId: 101, nickname: "Alice" }],
              actions: [],
            }
          : null,
        state: { canStartFight: !foreignBattle },
      });
    return Response.json({ error: "unexpected_fake_route" }, { status: 404 });
  };
  return {
    calls,
    fetcher,
    setQuantity(value) {
      quantity = value;
    },
    setForeignBattle(value) {
      foreignBattle = value;
    },
  };
}

const command = (id, name, version, args = {}) => ({
  id,
  command: name,
  expectedVersion: version,
  args,
});

async function waitForController(entry) {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (!entry.controller.getSnapshot().pending) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

test("business assistant persists private plans, refreshes fresh stock, and creates guarded goals", async () => {
  const directory = mkdtempSync(join(tmpdir(), "business-assistant-service-"));
  const game = createGame();
  const bossById = new Map(
    catalogue.bosses.map((boss) => [boss.numericId, boss]),
  );
  const createService = (store) =>
    createAutomationService({
      store,
      getBoss: async (id) => bossById.get(id) ?? null,
      getBusinessCatalogue: () => catalogue,
      fetcher: game.fetcher,
      now: () => 1_000_000,
      random: () => 0,
    });
  let store = createAutomationStateStore({ directory });
  let service = createService(store);
  try {
    let entry = await service.identify(tokenA);
    const callsAfterIdentify = game.calls.length;
    let snap = service.snapshot(entry);
    snap = await service.command(
      entry,
      command("business-select-a", "business.select", snap.version, {
        businessId,
      }),
    );
    snap = await service.command(
      entry,
      command("business-save-a", "business.save", snap.version, {
        businessId,
        targetLevel: 3,
        currentLevelOverride: null,
        maxAttempts: 2,
      }),
    );
    assert.equal(game.calls.length, callsAfterIdentify);

    snap = await service.command(
      entry,
      command("business-refresh-a", "business.refresh", snap.version, {
        businessId,
      }),
    );
    let plan = snap.businessAssistant.plans[0];
    assert.equal(plan.currentLevel, 1);
    assert.equal(plan.targetLevel, 3);
    assert.equal(plan.materials[0].requiredAmount, 7);
    assert.equal(plan.materials[0].missingAmount, 5);
    assert.equal(plan.cost.total, null);
    assert.equal(plan.cost.nextAmount, 100);

    const beforeSingleLevelSave = game.calls.length;
    snap = await service.command(
      entry,
      command("business-save-b", "business.save", snap.version, {
        businessId,
        targetLevel: 2,
        currentLevelOverride: null,
        maxAttempts: null,
      }),
    );
    assert.equal(game.calls.length, beforeSingleLevelSave);
    assert.equal(snap.businessAssistant.plans[0].cost.total, 100);
    snap = await service.command(
      entry,
      command("business-save-c", "business.save", snap.version, {
        businessId,
        targetLevel: 3,
        currentLevelOverride: null,
        maxAttempts: 2,
      }),
    );

    service.close();
    store.close();
    store = createAutomationStateStore({ directory });
    service = createService(store);
    entry = await service.identify(tokenA);
    snap = service.snapshot(entry);
    plan = snap.businessAssistant.plans[0];
    assert.equal(plan.targetLevel, 3);
    assert.equal(plan.materials[0].missingAmount, 5);

    snap = await service.command(
      entry,
      command("business-manual-plan", "business.save", snap.version, {
        businessId,
        targetLevel: 3,
        currentLevelOverride: 0,
        maxAttempts: 2,
      }),
    );
    await assert.rejects(
      service.command(
        entry,
        command("business-manual-goal", "business.goal", snap.version, {
          businessId,
          itemId: 55,
          bossId: 17,
          expectedMissing: 7,
          replaceExisting: false,
        }),
      ),
      (error) => error.status === 409,
    );
    snap = service.snapshot(entry);
    assert.equal(snap.goal, null);
    assert.match(snap.businessAssistant.notice, /Ручной текущий уровень/);
    snap = await service.command(
      entry,
      command("business-actual-plan", "business.save", snap.version, {
        businessId,
        targetLevel: 3,
        currentLevelOverride: null,
        maxAttempts: 2,
      }),
    );
    const beforeGoal = game.calls.length;
    snap = await service.command(
      entry,
      command("business-goal-a", "business.goal", snap.version, {
        businessId,
        itemId: 55,
        bossId: 17,
        expectedMissing: 5,
        replaceExisting: false,
      }),
    );
    assert.equal(snap.goal.kind, "business_items");
    assert.equal(snap.goal.targetCount, 5);
    assert.equal(snap.goal.items[0].key, "activity_item:55");
    assert.equal(snap.auto.enabled, false);
    assert.ok(game.calls.length > beforeGoal);
    assert.equal(
      game.calls.some(({ method }) => method === "POST"),
      false,
    );

    const initialGoalVersion = snap.version;
    await assert.rejects(
      service.command(
        entry,
        command("business-goal-b", "business.goal", initialGoalVersion, {
          businessId,
          itemId: 55,
          bossId: 17,
          expectedMissing: 6,
          replaceExisting: false,
        }),
      ),
      (error) => error.status === 409,
    );
    snap = service.snapshot(entry);
    assert.equal(snap.goal.targetCount, 5);
    assert.match(snap.businessAssistant.notice, /активная цель/);

    game.setQuantity(3);
    await assert.rejects(
      service.command(
        entry,
        command("business-goal-c", "business.goal", snap.version, {
          businessId,
          itemId: 55,
          bossId: 17,
          expectedMissing: 5,
          replaceExisting: true,
        }),
      ),
      (error) => error.status === 409,
    );
    snap = service.snapshot(entry);
    assert.equal(snap.businessAssistant.plans[0].materials[0].missingAmount, 4);
    assert.match(snap.businessAssistant.notice, /изменились/);
    assert.equal(snap.goal.targetCount, 5);

    game.setQuantity(2);
    snap = await service.command(
      entry,
      command("business-goal-d", "business.goal", snap.version, {
        businessId,
        itemId: 55,
        bossId: 17,
        expectedMissing: 5,
        replaceExisting: true,
      }),
    );
    assert.equal(snap.goal.targetCount, 5);
    assert.equal(snap.auto.enabled, false);

    const secondEntry = await service.identify(tokenB);
    const secondSnapshot = service.snapshot(secondEntry);
    assert.equal(secondSnapshot.businessAssistant.plans.length, 0);
    assert.notEqual(secondEntry.playerId, entry.playerId);

    game.setForeignBattle(true);
    snap = await service.command(
      entry,
      command("open-other-boss", "open", snap.version, { bossId: 18 }),
    );
    await waitForController(entry);
    snap = service.snapshot(entry);
    assert.equal(snap.battle.boss.id, 18);
    assert.equal(snap.battle.battle?.status, "active");
    await assert.rejects(
      service.command(
        entry,
        command("business-goal-e", "business.goal", snap.version, {
          businessId,
          itemId: 55,
          bossId: 17,
          expectedMissing: 5,
          replaceExisting: true,
        }),
      ),
      (error) => error.status === 409,
    );
    assert.match(
      service.snapshot(entry).businessAssistant.notice,
      /активный бой/,
    );
  } finally {
    service?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
