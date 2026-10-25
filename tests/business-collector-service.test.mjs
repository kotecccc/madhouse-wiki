import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

const businessId = "business:7";
const materials = [55, 56];
const catalogue = {
  businesses: [{ id: businessId, apiId: "7", title: "Workshop", maxLevel: 2 }],
  businessUpgrades: [
    {
      businessId,
      items: materials.map((entityId) => ({
        entityId,
        name: `Item ${entityId}`,
        levels: [1, 1],
      })),
    },
  ],
  bosses: materials.map((entityId, index) => ({
    numericId: 17 + index,
    name: `Boss ${17 + index}`,
    possibleDrops: [
      { type: "activity_item", entityId, name: `Item ${entityId}` },
    ],
  })),
};

for (const [cap, restart] of [
  [1, false],
  [5, false],
  [5, true],
])
  test(`server business collection switches bosses and obeys global cap ${cap}, restart ${restart}`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "business-collector-service-"),
    );
    const store = createAutomationStateStore({ directory });
    const timers = [],
      calls = [],
      stock = new Map();
    let current = null,
      starts = 0;
    let now = 1_000_000;
    const battle = (id, bossId, status) => ({
      battleId: id,
      bossId,
      status,
      playerHealth: 80,
      playerMaxHealth: 100,
      bossHealth: status === "active" ? 1 : 0,
      bossMaxHealth: 1,
      myDamage: 1,
      participantCount: 1,
      participants: [],
      actions: [],
      serverTimeUtc: new Date(now).toISOString(),
      cooldownUntilUtc: new Date(now).toISOString(),
      expiresAtUtc: new Date(now + 120000).toISOString(),
      retryAfterMilliseconds: 0,
      reward: {
        drops:
          status === "won"
            ? [
                {
                  type: "activity_item",
                  entityId: bossId === 17 ? 55 : 56,
                  amount: 1,
                  granted: true,
                },
              ]
            : [],
      },
    });
    const fetcher = async (url, init = {}) => {
      const path = new URL(url).pathname,
        method = init.method || "GET";
      calls.push({ path, method });
      if (path === "/api/me")
        return Response.json({ playerId: 101, nickname: "Player" });
      if (path === "/api/combat") return Response.json({ activeBattle: null });
      if (path === "/api/me/bag")
        return Response.json({
          activityItems: [...stock].map(([itemId, quantity]) => ({
            itemId,
            quantity,
          })),
        });
      if (path === "/api/businesses/7")
        return Response.json({
          id: 7,
          level: 1,
          maxLevel: 2,
          nextUpgradePrice: 100,
          nextUpgradeCurrency: "gold",
        });
      const bossId = Number(path.match(/^\/api\/bosses\/(\d+)/)?.[1]);
      if (bossId && method === "GET")
        return Response.json({
          id: bossId,
          damageMax: 10,
          activeBattle:
            current?.bossId === bossId && current.status === "active"
              ? current
              : null,
          state: { canStartFight: true },
        });
      if (bossId && method === "POST") {
        current = battle(`battle-${++starts}`, bossId, "active");
        return Response.json({ battle: current });
      }
      if (path.endsWith("/attack")) {
        const itemId = current.bossId === 17 ? 55 : 56;
        stock.set(itemId, (stock.get(itemId) || 0) + 1);
        current = battle(current.battleId, current.bossId, "won");
        return Response.json({ battle: current });
      }
      if (path.startsWith("/api/bosses/battles/"))
        return Response.json(current);
      throw new Error(`Unexpected fake route ${method} ${path}`);
    };
    const createService = () =>
      createAutomationService({
        store,
        fetcher,
        getBoss: (id) => catalogue.bosses.find((boss) => boss.numericId === id),
        getBusinessCatalogue: () => catalogue,
        now: () => now,
        schedule: (callback, delay) => {
          const timer = { callback, delay };
          timers.push(timer);
          return timer;
        },
        cancel: (timer) => {
          timer.canceled = true;
        },
        random: () => 0,
      });
    let service = createService();
    try {
      let entry = await service.identify("Bearer collector.payload.sig");
      let id = 0;
      const command = (name, args) =>
        service.command(entry, {
          id: `businesscmd${++id}`,
          command: name,
          expectedVersion: service.snapshot(entry).version,
          args,
        });
      await command("business.select", { businessId });
      await command("business.save", {
        businessId,
        targetLevel: 2,
        maxAttempts: cap,
        durationHours: 1,
      });
      await command("business.refresh", { businessId });
      const plan = service.snapshot(entry).businessAssistant.plans[0];
      await command("business.run.start", {
        businessId,
        expectedPlan: plan.config,
        expectedMissing: plan.materials.map((item) => ({
          itemId: item.entityId,
          amount: item.missingAmount,
        })),
      });
      if (restart) {
        for (let i = 0; i < 2; i++) {
          const timer = timers.find((timer) => !timer.canceled && !timer.done);
          assert.ok(timer);
          timer.done = true;
          now += timer.delay;
          timer.callback();
          await new Promise((resolve) => setImmediate(resolve));
        }
        assert.equal(starts, 1);
        service.close();
        service = createService();
        await service.boot();
        entry = await service.identify("Bearer collector.payload.sig");
      }
      for (let i = 0; i < 30; i++) {
        const timer = timers.find((timer) => !timer.canceled && !timer.done);
        if (timer) {
          timer.done = true;
          now += timer.delay;
          timer.callback();
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
      const snap = service.snapshot(entry),
        run = snap.businessAssistant.run;
      assert.equal(
        run.status,
        cap === 1 ? "limited" : "completed",
        JSON.stringify(run),
      );
      assert.equal(run.battlesStarted, cap === 1 ? 1 : 2);
      assert.equal(run.battlesCompleted, run.battlesStarted);
      assert.equal(snap.auto.enabled, false);
      assert.deepEqual(
        calls
          .filter(
            (call) => call.method === "POST" && !call.path.endsWith("/attack"),
          )
          .map((call) => call.path),
        cap === 1
          ? ["/api/bosses/17/battles"]
          : ["/api/bosses/17/battles", "/api/bosses/18/battles"],
      );
      assert.equal(
        calls.filter((call) => call.path === "/api/me/bag").length,
        cap === 1 ? 3 : 4,
      );
    } finally {
      service.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
