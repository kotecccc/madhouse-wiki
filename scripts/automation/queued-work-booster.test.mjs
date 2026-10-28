import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationService } from "./service.mjs";
import { createAutomationStateStore } from "./state-store.mjs";

async function waitFor(check, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(check(), "server worker reached expected state");
}

test("queued booster survives a lost response and restart without another use", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-booster-"));
  const store = createAutomationStateStore({ directory });
  let clock = 1000000,
    count = 1,
    energy = 0,
    uses = 0,
    offline = true;
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (offline && ["/api/me", "/api/me/bag", "/api/works/open"].includes(path))
      throw new TypeError("offline");
    if (path === "/api/me")
      return Response.json({
        playerId: 1,
        wallet: { dollar: 100 },
        energy: { current: energy, max: 10 },
      });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: {
          small: {
            count,
            restoreEnergy: 2,
            costDollar: 5,
            maxPurchaseQuantity: 1,
          },
          full: {
            count: 0,
            restoreEnergy: 10,
            costDollar: 20,
            maxPurchaseQuantity: 1,
          },
        },
      });
    if (path === "/api/works/open")
      return Response.json({
        workId: 7,
        title: "Work",
        completedCycles: 0,
        tasks: [
          {
            id: 1,
            title: "Task",
            required: 1,
            progress: 0,
            energyCost: 1,
            canPerform: energy > 0,
          },
        ],
        energy: { current: energy, max: 10 },
      });
    if (path === "/api/me/bag/boosters/use") {
      uses++;
      count--;
      energy = 2;
      offline = true;
      throw new TypeError("reply lost");
    }
    if (path === "/api/bosses/invitations") return Response.json({ items: [] });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    throw new Error(`unexpected ${path}`);
  };
  const makeService = () =>
    createAutomationService({
      store,
      fetcher,
      identifyPlayer: async () => ({ playerId: 1 }),
      getBoss: () => null,
      getBusinessCatalogue: () => ({
        businesses: [],
        businessUpgrades: [],
        bosses: [],
        works: [{ workId: 7 }],
      }),
      now: () => clock,
      random: () => 0,
    });
  let service = makeService();
  try {
    let entry = await service.identify("Bearer fake");
    await service.boot();
    await service.command(entry, {
      id: "booster-job-1",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "work.booster", action: { workId: 7, type: "small" } },
    });
    await waitFor(
      () => service.snapshot(entry).queuedActions[0].status === "waiting",
    );
    assert.equal(uses, 0);
    offline = false;
    clock += 10000;
    await waitFor(
      () => service.snapshot(entry).queuedActions[0].status === "reconciling",
    );
    assert.equal(uses, 1);
    assert.equal(
      store.read("1").workFarm.manualPending.commandId,
      "booster-job-1",
    );
    service.close();
    service = makeService();
    await service.boot();
    entry = await service.identify("Bearer fake");
    offline = false;
    clock += 30000;
    await waitFor(
      () => service.snapshot(entry).queuedActions[0].status === "completed",
    );
    assert.equal(uses, 1);
    assert.equal(service.snapshot(entry).workFarm.manualPending, null);
    assert.ok(
      store.read("1").workFarm.manualReceipts.includes("booster-job-1"),
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart before the booster checkpoint safely retries an operation that was never sent", async () => {
  const { createActionQueue } = await import("./action-queue.mjs");
  const { queuedWorkBoosterAdapter } =
    await import("./queued-work-booster.mjs");
  let now = 0,
    uses = 0;
  const state = { manualPending: null, manualReceipts: [] };
  const entry = {
    workFarm: {
      running: () => false,
      getSnapshot: () => state,
      useBooster: async (_workId, _type, options) => {
        uses++;
        state.manualReceipts.push(options.commandId);
      },
      refresh: async () => {},
    },
  };
  const queue = createActionQueue({
    saved: [
      {
        id: "booster-job-1",
        type: "work.booster",
        args: { workId: 7, type: "small" },
        status: "running",
        priority: 1,
        createdAt: 0,
        nextAt: null,
        attempts: 0,
      },
    ],
    adapters: { "work.booster": queuedWorkBoosterAdapter({ entry }) },
    persist: () => true,
    now: () => now,
    random: () => 0,
  });
  await queue.tick();
  assert.equal(queue.snapshot()[0].status, "waiting");
  assert.equal(uses, 0);
  now += 10000;
  await queue.tick();
  assert.equal(queue.snapshot()[0].status, "completed");
  assert.equal(uses, 1);
});

test("cancelling during booster preflight never consumes the item", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-booster-cancel-"));
  const store = createAutomationStateStore({ directory });
  let release,
    readsStarted,
    uses = 0;
  const started = new Promise((resolve) => {
    readsStarted = resolve;
  });
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({
        playerId: 1,
        energy: { current: 0, max: 10 },
        wallet: { dollar: 100 },
      });
    if (path === "/api/works/open")
      return Response.json({
        workId: 7,
        title: "Work",
        completedCycles: 0,
        tasks: [
          {
            id: 1,
            title: "Task",
            required: 1,
            progress: 0,
            energyCost: 1,
            canPerform: false,
          },
        ],
        energy: { current: 0, max: 10 },
      });
    if (path === "/api/me/bag") {
      readsStarted();
      await new Promise((resolve) => {
        release = resolve;
      });
      return Response.json({
        boosters: {
          small: {
            count: 1,
            restoreEnergy: 2,
            costDollar: 5,
            maxPurchaseQuantity: 1,
          },
          full: {
            count: 0,
            restoreEnergy: 10,
            costDollar: 20,
            maxPurchaseQuantity: 1,
          },
        },
      });
    }
    if (path === "/api/me/bag/boosters/use") {
      uses++;
      return Response.json({ success: true });
    }
    if (path === "/api/bosses/invitations") return Response.json({ items: [] });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    throw new Error(`unexpected ${path}`);
  };
  const service = createAutomationService({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
    getBusinessCatalogue: () => ({
      businesses: [],
      businessUpgrades: [],
      bosses: [],
      works: [{ workId: 7 }],
    }),
  });
  try {
    const entry = await service.identify("Bearer fake");
    await service.boot();
    await service.command(entry, {
      id: "booster-job-1",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "work.booster", action: { workId: 7, type: "small" } },
    });
    await started;
    await service.command(entry, {
      id: "cancel-job-1",
      command: "queue.cancel",
      expectedVersion: service.snapshot(entry).version,
      args: { id: "booster-job-1" },
    });
    release();
    await waitFor(
      () => service.snapshot(entry).queuedActions[0].status === "cancelled",
    );
    assert.equal(uses, 0);
    assert.equal(service.snapshot(entry).workFarm.manualPending, null);
  } finally {
    release?.();
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("booster preflight honors the upstream retry deadline", async () => {
  const { createActionQueue } = await import("./action-queue.mjs");
  const { queuedWorkBoosterAdapter } =
    await import("./queued-work-booster.mjs");
  const state = { manualPending: null, manualReceipts: [] };
  const entry = {
    workFarm: {
      running: () => false,
      getSnapshot: () => state,
      useBooster: async () => {
        throw Object.assign(new Error("limited"), {
          status: 429,
          retryAfterMs: 90000,
        });
      },
    },
  };
  const queue = createActionQueue({
    adapters: { "work.booster": queuedWorkBoosterAdapter({ entry }) },
    persist: () => true,
    now: () => 0,
    random: () => 0,
  });
  queue.add({
    id: "booster-job-1",
    type: "work.booster",
    args: { workId: 7, type: "small" },
  });
  await queue.tick();
  assert.equal(queue.snapshot()[0].status, "waiting");
  assert.equal(queue.snapshot()[0].nextAt, 90000);
});

test("booster queue distinguishes an expired session from an outage deadline", async () => {
  const { queuedWorkBoosterAdapter } =
    await import("./queued-work-booster.mjs");
  let error = Object.assign(new Error("expired"), {
    status: 401,
    notDispatched: true,
  });
  const entry = {
    workFarm: {
      running: () => false,
      getSnapshot: () => ({ manualPending: null, manualReceipts: [] }),
      useBooster: async () => {
        throw error;
      },
    },
  };
  const adapter = queuedWorkBoosterAdapter({ entry });
  const job = { id: "booster-job-1", args: { workId: 7, type: "small" } };
  assert.deepEqual(await adapter.execute(job, { canDispatch: () => true }), {
    status: "failed",
    reason: "game_session_required",
  });
  error = Object.assign(new Error("game_outage_wait"), {
    notDispatched: true,
    retryAfterMs: 120000,
  });
  assert.deepEqual(await adapter.execute(job, { canDispatch: () => true }), {
    status: "retry",
    reason: "Ожидаем игру.",
    retryAfterMs: 120000,
  });
});

test("queued manual booster runs between farm steps and resumes the same goal", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-booster-farm-"));
  const store = createAutomationStateStore({ directory });
  let count = 1,
    energy = 0,
    uses = 0;
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({
        playerId: 1,
        wallet: { dollar: 100 },
        energy: { current: energy, max: 10 },
      });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: {
          small: {
            count,
            restoreEnergy: 2,
            costDollar: 5,
            maxPurchaseQuantity: 1,
          },
          full: {
            count: 0,
            restoreEnergy: 10,
            costDollar: 20,
            maxPurchaseQuantity: 1,
          },
        },
      });
    if (path === "/api/works/open")
      return Response.json({
        workId: 7,
        title: "Work",
        completedCycles: 0,
        tasks: [
          {
            id: 1,
            title: "Task",
            required: 1,
            progress: 0,
            energyCost: 5,
            canPerform: false,
          },
        ],
        energy: { current: energy, max: 10 },
      });
    if (path === "/api/me/bag/boosters/use") {
      uses++;
      count--;
      energy = 2;
      return Response.json({ success: true });
    }
    if (path === "/api/bosses/invitations") return Response.json({ items: [] });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    throw new Error(`unexpected ${path}`);
  };
  const service = createAutomationService({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
    getBusinessCatalogue: () => ({
      businesses: [],
      businessUpgrades: [],
      bosses: [],
      works: [{ workId: 7 }],
    }),
    random: () => 0,
  });
  try {
    const entry = await service.identify("Bearer fake");
    await service.boot();
    await service.command(entry, {
      id: "farm-before-boost",
      command: "work.start",
      expectedVersion: service.snapshot(entry).version,
      args: {
        workId: 7,
        targetCycles: 3,
        maxActions: 100,
        mode: "wait",
        maxBoosters: 0,
        maxDollar: 0,
        allowPurchase: false,
      },
    });
    await waitFor(
      () => entry.workFarm.running() && entry.workFarm.canSuspend(),
    );
    await service.command(entry, {
      id: "boost-during-farm",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "work.booster", action: { workId: 7, type: "small" } },
    });
    await waitFor(
      () => service.snapshot(entry).queuedActions[0].status === "completed",
    );
    const run = service.snapshot(entry).workFarm.run;
    assert.equal(run.status, "running");
    assert.equal(run.targetCycles, 3);
    assert.equal(run.config.maxBoosters, 0);
    assert.equal(run.usedBoosters, 0);
    assert.equal(uses, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
