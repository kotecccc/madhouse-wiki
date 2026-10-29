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

for (const [cap, restart, autoUpgrade, viaFloor] of [
  [1, false],
  [5, false],
  [5, true],
  [5, true, true],
  [5, false, true, true],
])
  test(`server business collection switches bosses and obeys global cap ${cap}, restart ${restart}, upgrade ${Boolean(autoUpgrade)}, floor ${Boolean(viaFloor)}`, async () => {
    const directory = mkdtempSync(
      join(tmpdir(), "business-collector-service-"),
    );
    const store = createAutomationStateStore({ directory });
    const timers = [],
      calls = [],
      stock = new Map();
    let current = null,
      starts = 0,
      level = 1;
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
      if (method === "GET" && path === "/api/clothing/by-category/1")
        return Response.json({ success: true, items: [] });
      if (path === "/api/me")
        return Response.json({
          playerId: 101,
          nickname: "Player",
          wallet: { gold: 1000 },
        });
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
                {
                  type: "business_level",
                  businessId: 7,
                  current: 1,
                  required: 2,
                },
              ],
            },
          ],
        });
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
          level,
          maxLevel: 2,
          canUpgrade: true,
          nextUpgradePrice: 100,
          nextUpgradeCurrency: "gold",
          requiredItems: materials.map((itemId) => ({
            itemId,
            requiredAmount: 1,
            playerAmount: stock.get(itemId) || 0,
          })),
        });
      if (path === "/api/businesses/7/upgrade" && method === "POST") {
        level++;
        return Response.json({ success: true });
      }
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
        getBusinessCatalogue: () => ({
          ...catalogue,
          floors: [{ id: "a", code: "A" }],
          departments: [
            { id: "a1", floorId: "a", code: "A1" },
            { id: "a2", floorId: "a", code: "A2" },
          ],
        }),
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
      if (viaFloor) {
        await command("floor.start", {});
        await entry.floorRunner.tick();
        assert.equal(service.snapshot(entry).floorRunner.phase, "executing");
      } else {
        await command("business.select", { businessId });
        await command("business.save", {
          businessId,
          targetLevel: 2,
          maxAttempts: cap,
          durationHours: 1,
          autoUpgrade: Boolean(autoUpgrade),
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
      }
      if (cap === 5 && !restart && !autoUpgrade && !viaFloor) {
        await command("business.run.pause", {});
        assert.equal(
          service.snapshot(entry).businessAssistant.run.status,
          "paused",
        );
        await command("business.run.resume", {});
        entry.collector.tick();
        assert.equal(
          service.snapshot(entry).businessAssistant.run.status,
          "running",
        );
      }
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
        if (!autoUpgrade) {
          await command("business.run.pause", {});
          assert.equal(
            service.snapshot(entry).businessAssistant.run.status,
            "paused",
          );
        }
        service.close();
        service = createService();
        await service.boot();
        entry = await service.identify("Bearer collector.payload.sig");
        if (!autoUpgrade) {
          assert.equal(
            service.snapshot(entry).businessAssistant.run.status,
            "paused",
          );
          assert.equal(service.snapshot(entry).auto.enabled, false);
          await command("business.run.resume", {});
          entry.collector.tick();
          assert.equal(
            service.snapshot(entry).businessAssistant.run.status,
            "running",
          );
        }
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
      assert.equal(level, autoUpgrade ? 2 : 1);
      assert.equal(
        calls.filter((call) => call.path === "/api/businesses/7/upgrade")
          .length,
        autoUpgrade ? 1 : 0,
      );
      assert.equal(snap.auto.enabled, false);
      assert.deepEqual(
        calls
          .filter(
            (call) =>
              call.method === "POST" &&
              !call.path.endsWith("/attack") &&
              !call.path.endsWith("/upgrade"),
          )
          .map((call) => call.path),
        cap === 1
          ? ["/api/bosses/17/battles"]
          : ["/api/bosses/17/battles", "/api/bosses/18/battles"],
      );
      assert.equal(
        calls.filter((call) => call.path === "/api/me/bag").length,
        cap === 1 ? 3 : autoUpgrade || restart ? 5 : 4,
      );
    } finally {
      service.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

for (const stop of [false, true])
  test(`upgrade survives a lost response and restart without a second charge; stop: ${stop}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "business-upgrade-service-"));
    const store = createAutomationStateStore({ directory });
    const timers = [];
    let now = 1_000_000,
      level = 1,
      posts = 0,
      offline = false;
    const fetcher = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/me")
        return Response.json({ playerId: 101, wallet: { gold: 1000 } });
      if (path === "/api/combat") return Response.json({ activeBattle: null });
      if (path === "/api/me/bag")
        return Response.json({
          activityItems: materials.map((itemId) => ({ itemId, quantity: 1 })),
        });
      if (path === "/api/businesses/7" && !init.method) {
        if (offline) throw new TypeError("offline");
        return Response.json({
          id: 7,
          level,
          maxLevel: 2,
          canUpgrade: true,
          nextUpgradePrice: 100,
          nextUpgradeCurrency: "gold",
          requiredItems: materials.map((itemId) => ({
            itemId,
            requiredAmount: 1,
            playerAmount: 1,
          })),
        });
      }
      if (path === "/api/businesses/7/upgrade") {
        posts++;
        level++;
        offline = true;
        throw new TypeError("response lost");
      }
      throw new Error(`Unexpected fake route ${init.method || "GET"} ${path}`);
    };
    const createService = () =>
      createAutomationService({
        store,
        fetcher,
        getBoss: () => null,
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
    const step = async () => {
      const timer = timers.find((item) => !item.canceled && !item.done);
      if (!timer) return;
      timer.done = true;
      now += timer.delay;
      timer.callback();
      for (let i = 0; i < 5; i++)
        await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      let entry = await service.identify("Bearer upgrade.payload.sig");
      let counter = 0;
      const command = (name, args) =>
        service.command(entry, {
          id: `upgradecmd${++counter}`,
          command: name,
          expectedVersion: service.snapshot(entry).version,
          args,
        });
      await command("business.select", { businessId });
      await command("business.save", {
        businessId,
        targetLevel: 2,
        maxAttempts: 5,
        durationHours: 1,
        autoUpgrade: true,
      });
      await command("business.refresh", { businessId });
      const plan = service.snapshot(entry).businessAssistant.plans[0];
      await command("business.run.start", {
        businessId,
        expectedPlan: plan.config,
        expectedMissing: [],
      });
      await step();
      assert.equal(posts, 1);
      assert.ok(service.snapshot(entry).businessAssistant.run.pendingUpgrade);
      if (stop) {
        await command("business.run.pause", {});
        assert.equal(
          service.snapshot(entry).businessAssistant.run.status,
          "paused",
        );
      }
      service.close();
      service = createService();
      await service.boot();
      entry = await service.identify("Bearer upgrade.payload.sig");
      await step();
      assert.equal(posts, 1);
      await assert.rejects(
        command("auto.start", {}),
        /business_upgrade_uncertain/,
      );
      if (stop) {
        assert.equal(
          service.snapshot(entry).businessAssistant.run.status,
          "paused",
        );
        entry.collector.tick();
        await new Promise((resolve) => setImmediate(resolve));
        assert.ok(service.snapshot(entry).businessAssistant.run.pendingUpgrade);
      }
      offline = false;
      if (stop) {
        now += 30000;
        entry.collector.tick();
        for (let i = 0; i < 5; i++)
          await new Promise((resolve) => setImmediate(resolve));
        assert.equal(
          service.snapshot(entry).businessAssistant.run.pendingUpgrade,
          null,
        );
        assert.equal(
          service.snapshot(entry).businessAssistant.run.status,
          "paused",
        );
        await command("business.run.stop", {});
      }
      for (let i = 0; i < 6; i++) await step();
      const run = service.snapshot(entry).businessAssistant.run;
      assert.equal(
        run.status,
        stop ? "stopped" : "completed",
        JSON.stringify(run),
      );
      assert.equal(run.pendingUpgrade, null);
      assert.equal(posts, 1);
    } finally {
      service.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("business without a catalogue recipe advances using each fresh game requirement", async () => {
  const directory = mkdtempSync(join(tmpdir(), "business-live-requirements-"));
  const store = createAutomationStateStore({ directory });
  const timers = [];
  const reference = {
    ...catalogue,
    businesses: [{ ...catalogue.businesses[0], maxLevel: 3 }],
    businessUpgrades: [],
  };
  let level = 1;
  let posts = 0;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({ playerId: 101, wallet: { gold: 1000 } });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/me/bag")
      return Response.json({
        activityItems: materials.map((itemId) => ({ itemId, quantity: 1 })),
      });
    if (path === "/api/businesses/7")
      return Response.json({
        id: 7,
        level,
        maxLevel: 3,
        canUpgrade: true,
        nextUpgradePrice: 10,
        nextUpgradeCurrency: "gold",
        requiredItems: [
          { itemId: level === 1 ? 55 : 56, requiredAmount: 1, playerAmount: 1 },
        ],
      });
    if (path === "/api/businesses/7/upgrade") {
      posts++;
      level++;
      return Response.json({ success: true });
    }
    throw new Error(`Unexpected fake route ${init.method || "GET"} ${path}`);
  };
  const service = createAutomationService({
    store,
    fetcher,
    getBoss: () => null,
    getBusinessCatalogue: () => reference,
    now: () => 1000,
    schedule: (callback, delay) => {
      const timer = { callback, delay };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.canceled = true;
    },
  });
  try {
    const entry = await service.identify("Bearer nextlevels.payload.sig");
    let counter = 0;
    const command = (name, args) =>
      service.command(entry, {
        id: `nextlevelcmd${++counter}`,
        command: name,
        expectedVersion: service.snapshot(entry).version,
        args,
      });
    await command("business.select", { businessId });
    await command("business.save", {
      businessId,
      targetLevel: 3,
      maxAttempts: 5,
      durationHours: 1,
      autoUpgrade: true,
    });
    await command("business.refresh", { businessId });
    const plan = service.snapshot(entry).businessAssistant.plans[0];
    assert.equal(plan.materials[0].entityId, 55);
    await command("business.run.start", {
      businessId,
      expectedPlan: plan.config,
      expectedMissing: [],
    });
    for (let i = 0; i < 10; i++) {
      const timer = timers.find((item) => !item.canceled && !item.done);
      if (!timer) break;
      timer.done = true;
      timer.callback();
      for (let j = 0; j < 5; j++)
        await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(posts, 2);
    assert.equal(
      service.snapshot(entry).businessAssistant.run.status,
      "completed",
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("business collection can wait behind a raid and starts without replacing it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-business-run-"));
  const store = createAutomationStateStore({ directory });
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({ playerId: 101, wallet: { gold: 1000 } });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/me/bag") return Response.json({ activityItems: [] });
    if (path === "/api/businesses/7")
      return Response.json({
        id: 7,
        level: 1,
        maxLevel: 2,
        canUpgrade: true,
        requiredItems: materials.map((itemId) => ({
          itemId,
          requiredAmount: 1,
          playerAmount: 0,
        })),
      });
    if (path === "/api/bosses/invitations") return Response.json({ items: [] });
    throw new Error(`unexpected ${path}`);
  };
  const service = createAutomationService({
    store,
    fetcher,
    getBoss: (id) => catalogue.bosses.find((boss) => boss.numericId === id),
    getBusinessCatalogue: () => catalogue,
    schedule: () => ({}),
    cancel: () => {},
    random: () => 0,
  });
  try {
    const entry = await service.identify("Bearer queued.payload.sig");
    let n = 0;
    const command = (name, args) =>
      service.command(entry, {
        id: `business-queue-${++n}`,
        command: name,
        expectedVersion: service.snapshot(entry).version,
        args,
      });
    await command("business.select", { businessId });
    await command("business.save", {
      businessId,
      targetLevel: 2,
      maxAttempts: 5,
      durationHours: 1,
      autoUpgrade: false,
    });
    await command("business.refresh", { businessId });
    const plan = service.snapshot(entry).businessAssistant.plans[0];
    assert.equal(entry.raidWorker.start(17), true);
    entry.raidWorker.pause();
    await service.boot();
    await command("queue.enqueue", {
      type: "business.start",
      action: {
        businessId,
        expectedPlan: plan.config,
        expectedMissing: plan.materials
          .filter((item) => item.missingAmount > 0)
          .map((item) => ({
            itemId: item.entityId,
            amount: item.missingAmount,
          })),
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(service.snapshot(entry).queuedActions[0].status, "queued");
    assert.equal(service.snapshot(entry).raid.userPaused, true);
    assert.equal(service.snapshot(entry).businessAssistant.run, null);
    entry.raidWorker.stop();
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(
      service.snapshot(entry).businessAssistant.run.status,
      "running",
    );
    assert.equal(
      service.snapshot(entry).businessAssistant.run.queueId,
      "business-queue-4",
    );
    const saved = store.read("101");
    assert.ok(saved.businessHelper.startReceipts.includes("business-queue-4"));
    saved.queuedActions[0].status = "running";
    saved.queuedActions[0].nextAt = 0;
    saved.businessHelper.run.queueId = "newer-business-run";
    service.close();
    store.write("101", saved);
    const restoredService = createAutomationService({
      store,
      fetcher,
      identifyPlayer: async () => ({ playerId: 101 }),
      getBoss: (id) => catalogue.bosses.find((boss) => boss.numericId === id),
      getBusinessCatalogue: () => catalogue,
      now: () => Date.now() + 5000,
      schedule: () => ({}),
      cancel: () => {},
      random: () => 0,
    });
    try {
      const restored = await restoredService.identify(
        "Bearer queued.payload.sig",
      );
      await restored.actionQueue.tick();
      assert.equal(restored.actionQueue.snapshot()[0].status, "completed");
      assert.equal(restored.businessHelper.run.queueId, "newer-business-run");
    } finally {
      restoredService.close();
    }
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
