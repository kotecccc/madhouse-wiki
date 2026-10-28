import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createQueueActionGate } from "../scripts/bridge/queue-action-gate.mjs";

test("energy work persists its checkpoint before granting bridge dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "work-bridge-checkpoint-"));
  const store = createAutomationStateStore({ directory });
  const gate = createQueueActionGate();
  const timers = [];
  let progress = 0,
    sends = 0;
  const view = () => ({
    workId: 7,
    title: "Work",
    completedCycles: progress,
    tasks: [
      { id: 1, required: 1, progress: 0, energyCost: 1, canPerform: true },
    ],
    energy: {
      current: 5,
      max: 10,
      regenIntervalSeconds: 120,
      secondsToNext: 100,
    },
  });
  const service = createAutomationService({
    store,
    queueActionGate: gate,
    identifyPlayer: async () => ({ playerId: 101 }),
    getBoss: () => null,
    getBusinessCatalogue: () => ({
      businesses: [],
      works: [{ workId: 7 }],
      businessUpgrades: [],
      bosses: [],
    }),
    schedule: (callback) => {
      const timer = { callback };
      timers.push(timer);
      return timer;
    },
    cancel: () => {},
    fetcher: async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/api/me")
        return Response.json({ playerId: 101, energy: view().energy });
      if (path === "/api/works/open") return Response.json(view());
      if (path === "/api/works/tasks/perform") {
        const saved = store.read("101").workFarm.run;
        const body = JSON.parse(init.body);
        assert.equal(saved.pending.operationId, body.operationId);
        assert.equal(
          gate.claim({
            authorization: "Bearer fake",
            method: "POST",
            path,
            body: init.body,
          }),
          true,
        );
        sends++;
        progress++;
        return Response.json(view());
      }
      return Response.json({});
    },
  });
  try {
    const entry = await service.identify("Bearer fake");
    entry.workFarm.start({
      workId: 7,
      targetCycles: 1,
      mode: "energy",
      energyBudget: 1,
      maxActions: 5,
      durationHours: null,
      maxBoosters: 0,
      maxDollar: 0,
      allowPurchase: false,
    });
    for (let n = 0; n < 20 && !sends; n++) {
      timers.shift()?.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(sends, 1, JSON.stringify(entry.workFarm.getSnapshot()));
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("account-owned work runner persists before POST, resumes without browser and isolates accounts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "work-farm-service-"));
  const store = createAutomationStateStore({ directory });
  const timers = [],
    calls = [];
  let failBag = false;
  let smallBoosters = 1;
  let cycles = 4,
    progress = 1,
    energy = 10;
  const state = () => ({
    workId: 7,
    title: "Work",
    completedCycles: cycles,
    tasks: [
      {
        id: 1,
        title: "Task",
        required: 3,
        progress,
        energyCost: 1,
        canPerform: energy > 0,
      },
    ],
    energy: {
      current: energy,
      max: 10,
      regenIntervalSeconds: 120,
      secondsToNext: 100,
    },
  });
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path === "/api/me")
      return Response.json({
        playerId: init.headers.Authorization.includes("other") ? 202 : 101,
        nickname: "Player",
        energy: state().energy,
        wallet: { dollar: 100 },
      });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/me/bag" && failBag)
      return new Response("bag unavailable", { status: 503 });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: Object.fromEntries(
          ["small", "full"].map((type) => [
            type,
            {
              count: type === "small" ? smallBoosters : 0,
              restoreEnergy: 10,
              costDollar: 10,
              maxPurchaseQuantity: 10,
            },
          ]),
        ),
      });
    if (path === "/api/works/open") return Response.json(state());
    if (path === "/api/me/bag/boosters/use") {
      assert.equal(store.read("101").workFarm.manualPending.type, "small");
      assert.equal(store.read("101").workFarm.manualPending.count, 1);
      smallBoosters--;
      energy = 10;
      return Response.json({ success: true });
    }
    if (path === "/api/works/tasks/perform") {
      const saved = store.read("101");
      assert.equal(saved.workFarm.run.pending.kind, "performing");
      assert.equal(saved.workFarm.run.actionsDone, progress);
      progress++;
      energy--;
      if (progress === 3) {
        cycles++;
        progress = 0;
      }
      return Response.json(state());
    }
    throw new Error(`Unexpected fake request ${path}`);
  };
  const create = () =>
    createAutomationService({
      store,
      fetcher,
      accountHealth: () => ({
        status: "unavailable",
        failedFeatures: ["ornaments", "weapons"],
      }),
      getBoss: () => null,
      getBusinessCatalogue: () => ({
        businesses: [],
        works: [{ workId: 7 }],
        businessUpgrades: [],
        bosses: [],
      }),
      now: () => 1_000_000,
      random: () => 0,
      schedule: (callback, delay) => {
        const timer = { callback, delay };
        timers.push(timer);
        return timer;
      },
      cancel: (timer) => {
        timer.canceled = true;
      },
    });
  let service = create();
  const drainOne = async () => {
    const timer = timers.find((timer) => !timer.canceled);
    assert.ok(timer);
    timer.canceled = true;
    timer.callback();
    await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    let entry = await service.identify("Bearer work.payload.sig");
    let id = 0;
    const command = (name, args) =>
      service.command(entry, {
        id: `workcommand${++id}`,
        command: name,
        expectedVersion: service.snapshot(entry).version,
        args,
      });
    await command("work.refresh", { workId: 7 });
    failBag = true;
    await command("work.refresh", { workId: 7 });
    const partialView = service.snapshot(entry).workFarm.view;
    assert.equal(partialView.workId, 7);
    assert.equal(partialView.tasks[0].progress, progress);
    assert.equal(partialView.energy.current, energy);
    assert.deepEqual(partialView.boosters, []);
    assert.equal(partialView.boostersStatus, "error");
    const mutationCount = calls.filter(
      (path) =>
        path.startsWith("/api/works/tasks/") || path.includes("/boosters/"),
    ).length;
    await command("work.start", {
      workId: 7,
      targetCycles: 5,
      mode: "boosters",
      maxActions: 10,
      durationHours: 1,
      maxBoosters: 10,
      allowPurchase: true,
      maxDollar: 100,
    });
    assert.equal(service.snapshot(entry).workFarm.run.status, "running");
    await command("work.stop", {});
    assert.equal(
      calls.filter(
        (path) =>
          path.startsWith("/api/works/tasks/") || path.includes("/boosters/"),
      ).length,
      mutationCount,
    );
    failBag = false;
    const args = {
      workId: 7,
      targetCycles: 5,
      mode: "wait",
      maxActions: 10,
      durationHours: 1,
      maxBoosters: 0,
      allowPurchase: false,
      maxDollar: 0,
    };
    await command("work.plan", args);
    assert.equal(
      calls.filter(
        (path) =>
          path.startsWith("/api/works/tasks/") || path.includes("/boosters/"),
      ).length,
      mutationCount,
    );
    assert.equal(service.snapshot(entry).workFarm.configs[7].targetCycles, 5);
    assert.equal(service.snapshot(entry).workFarm.view.plan.remainingEnergy, 2);
    // Background reads/other workers can advance the account version after
    // the user selected this job. Named work intent remains valid.
    await service.command(entry, {
      id: "stale-work-intent",
      command: "work.start",
      expectedVersion: 0,
      args,
    });
    await drainOne();
    assert.equal(progress, 2);
    assert.equal(service.snapshot(entry).workFarm.run.status, "running");
    service.close();
    service = create();
    await service.boot();
    await drainOne();
    entry = await service.identify("Bearer work.payload.sig");
    assert.equal(service.snapshot(entry).workFarm.run.status, "completed");
    assert.equal(service.snapshot(entry).workFarm.run.completedCycles, 5);
    assert.equal(
      calls.filter((path) => path === "/api/works/tasks/perform").length,
      2,
    );
    energy = 0;
    await command("work.booster.use", { workId: 7, type: "small" });
    assert.equal(smallBoosters, 0);
    assert.equal(service.snapshot(entry).workFarm.manualPending, null);
    assert.equal(
      calls.filter((path) => path === "/api/me/bag/boosters/use").length,
      1,
    );
    await assert.rejects(
      command("work.booster.use", { workId: 7, type: "small" }),
    );
    assert.equal(
      calls.filter((path) => path === "/api/me/bag/boosters/use").length,
      1,
    );
    const other = await service.identify("Bearer other.payload.sig");
    assert.equal(service.snapshot(other).workFarm.run, null);
    assert.equal(service.snapshot(other).workFarm.view, null);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("character upgrade waits for in-flight work and work resumes without repeating it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "work-character-priority-"));
  const store = createAutomationStateStore({ directory });
  const events = [];
  let progress = 0;
  let energy = 10;
  let gold = 1000;
  let releaseWork;
  let releaseCharacter;
  const characterStats = { madness: { base: 10, total: 10 } };
  const characterStatsUpgrade = {
    resetAtUtc: "2099-01-01T00:00:00Z",
    madness: {
      currency: "gold",
      dailyLimit: 2,
      dailyUsed: 0,
      dailyRemaining: 2,
      costPerPoint: 10,
      nextCost: 10,
      maxCost: 10,
    },
  };
  const work = () => ({
    workId: 7,
    title: "Work",
    completedCycles: progress === 3 ? 1 : 0,
    tasks: [
      {
        id: 1,
        title: "Task",
        required: 3,
        progress: progress === 3 ? 0 : progress,
        energyCost: 1,
        canPerform: true,
      },
    ],
    energy: {
      current: energy,
      max: 10,
      regenIntervalSeconds: 120,
      secondsToNext: 100,
    },
  });
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({
        playerId: 101,
        wallet: { gold, pills: 0, dollar: 0 },
        energy: work().energy,
        characterStats,
        characterStatsUpgrade,
      });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    if (path === "/api/works/open") return Response.json(work());
    if (path === "/api/works/tasks/perform") {
      events.push("work");
      if (events.filter((event) => event === "work").length === 1)
        await new Promise((resolve) => {
          releaseWork = resolve;
        });
      progress++;
      energy--;
      return Response.json(work());
    }
    if (path === "/api/character-stats/upgrade") {
      events.push("character");
      await new Promise((resolve) => {
        releaseCharacter = resolve;
      });
      gold -= 10;
      characterStats.madness.base++;
      characterStats.madness.total++;
      characterStatsUpgrade.madness.dailyUsed++;
      characterStatsUpgrade.madness.dailyRemaining--;
      return Response.json({
        success: true,
        balance: { gold },
        characterStats,
        characterStatsUpgrade,
      });
    }
    return Response.json({ items: [] });
  };
  const service = createAutomationService({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 101 }),
    getBoss: () => null,
    getBusinessCatalogue: () => ({
      businesses: [],
      works: [{ workId: 7 }],
      businessUpgrades: [],
      bosses: [],
    }),
    schedule: (fn) => setTimeout(fn, 2),
    cancel: clearTimeout,
    random: () => 0,
  });
  const waitUntil = async (predicate) => {
    for (let i = 0; i < 200; i++) {
      if (predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Timed out waiting for fake operation");
  };
  try {
    const entry = await service.identify("Bearer work-priority.payload.sig");
    let id = 0;
    const command = (name, args = {}) =>
      service.command(entry, {
        id: `prioritywork${++id}`,
        command: name,
        expectedVersion: service.snapshot(entry).version,
        args,
      });
    const initial = await command("character.refresh");
    const expected = (
      await import("../src/lib/character-stat-upgrades.js")
    ).characterUpgradeQuote(initial.characterUpgrade.profile, "madness", 1);
    await command("work.start", {
      workId: 7,
      targetCycles: 1,
      mode: "energy",
      energyBudget: 3,
      maxActions: 10,
      durationHours: 1,
      maxBoosters: 0,
      allowPurchase: false,
      maxDollar: 0,
    });
    await waitUntil(() => Boolean(releaseWork));
    await command("character.upgrade", { stat: "madness", expected });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ["work"]);
    releaseWork();
    await waitUntil(() => Boolean(releaseCharacter));
    assert.deepEqual(events, ["work", "character"]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(events, ["work", "character"]);
    releaseCharacter();
    await waitUntil(
      () => service.snapshot(entry).characterUpgrade.run.status === "completed",
    );
    await waitUntil(
      () => events.filter((event) => event === "work").length >= 2,
    );
    assert.deepEqual(events.slice(0, 3), ["work", "character", "work"]);
  } finally {
    releaseWork?.();
    releaseCharacter?.();
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
