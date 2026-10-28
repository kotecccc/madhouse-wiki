import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationService } from "./service.mjs";
import { createAutomationStateStore } from "./state-store.mjs";
import assert from "node:assert/strict";
import { queuedEnergyBoosterAdapter } from "./queued-energy-booster.mjs";

function harness({
  count = 0,
  lostBuy = false,
  lostUse = false,
  price = 5,
} = {}) {
  let stock = count,
    dollar = 30,
    energy = 0,
    buys = 0,
    uses = 0;
  const entry = {
    credential: "Bearer test",
    energyBooster: { pending: null, receipts: [] },
    workFarm: { running: () => false },
  };
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({
        wallet: { dollar },
        energy: { current: energy, max: 10 },
      });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: {
          small: {
            count: stock,
            costDollar: price,
            restoreEnergy: 5,
            maxPurchaseQuantity: 1,
          },
        },
      });
    if (path === "/api/me/bag/boosters/buy") {
      buys++;
      stock++;
      dollar -= price;
      if (lostBuy) throw new Error("lost");
      return Response.json({ success: true });
    }
    if (path === "/api/me/bag/boosters/use") {
      uses++;
      stock--;
      energy = 5;
      if (lostUse) throw new Error("lost");
      return Response.json({ success: true });
    }
    throw new Error(path);
  };
  const adapter = queuedEnergyBoosterAdapter({
    entry,
    fetcher,
    save: () => {},
  });
  const job = {
    id: "booster-job-1",
    args: adapter.validate({ type: "small", maxPrice: price }),
  };
  return {
    entry,
    adapter,
    job,
    counts: () => ({ buys, uses, stock }),
    execute: () => adapter.execute(job, { canDispatch: () => true }),
  };
}

test("uses owned booster without purchase", async () => {
  const h = harness({ count: 1 });
  assert.equal((await h.execute()).status, "completed");
  assert.deepEqual(h.counts(), { buys: 0, uses: 1, stock: 0 });
  assert.equal((await h.adapter.reconcile(h.job)).status, "completed");
});

test("confirms purchase then uses once, including lost responses", async () => {
  const h = harness({ lostBuy: true, lostUse: true });
  assert.equal((await h.execute()).status, "retry");
  assert.equal(h.entry.energyBooster.pending.phase, "purchased");
  assert.equal((await h.execute()).status, "completed");
  assert.deepEqual(h.counts(), { buys: 1, uses: 1, stock: 0 });
  assert.equal((await h.adapter.reconcile(h.job)).status, "completed");
});

test("changed price prevents purchase", async () => {
  const h = harness();
  h.job.args.maxPrice = 4;
  assert.equal((await h.execute()).status, "failed");
  assert.deepEqual(h.counts(), { buys: 0, uses: 0, stock: 0 });
});

test("unconfirmed buying or usage is never replayed", async () => {
  const h = harness({ count: 1 });
  h.entry.energyBooster.pending = {
    id: h.job.id,
    type: "small",
    phase: "using",
    count: 1,
    restoreEnergy: 5,
  };
  assert.equal((await h.adapter.reconcile(h.job)).status, "uncertain");
  assert.equal((await h.execute()).status, "uncertain");
  assert.deepEqual(h.counts(), { buys: 0, uses: 0, stock: 1 });
});

test("a cancelled confirmed purchase is not followed by a use", async () => {
  const h = harness();
  h.entry.energyBooster.pending = {
    id: h.job.id,
    type: "small",
    phase: "purchased",
    count: 0,
    dollar: 30,
    price: 5,
  };
  const result = await h.adapter.reconcile({ ...h.job, cancelRequested: true });
  assert.equal(result.status, "retry");
  assert.equal(h.entry.energyBooster.pending, null);
  assert.deepEqual(h.counts(), { buys: 0, uses: 0, stock: 0 });
});

test("reconciliation never reports a dispatched operation as safely retryable while work cannot suspend", async () => {
  const h = harness();
  h.entry.energyBooster.pending = {
    id: h.job.id,
    type: "small",
    phase: "using",
    count: 1,
    restoreEnergy: 5,
  };
  h.entry.workFarm = { running: () => true, suspendForManual: () => false };
  assert.equal((await h.adapter.reconcile(h.job)).status, "uncertain");
});

test("account service queues the approved booster without requiring a work ID", async () => {
  const directory = mkdtempSync(join(tmpdir(), "energy-queue-"));
  const store = createAutomationStateStore({ directory });
  let stock = 1,
    energy = 0,
    uses = 0;
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({
        playerId: 17,
        wallet: { dollar: 10 },
        energy: { current: energy, max: 10 },
      });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: {
          small: {
            count: stock,
            costDollar: 5,
            restoreEnergy: 5,
            maxPurchaseQuantity: 1,
          },
        },
      });
    if (path === "/api/me/bag/boosters/use") {
      uses++;
      stock--;
      energy = 5;
      return Response.json({ success: true });
    }
    throw new Error(path);
  };
  const service = createAutomationService({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 17 }),
    getBoss: () => null,
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    await service.command(entry, {
      id: "energy-job-01",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: {
        type: "energy.booster",
        action: { type: "small", maxPrice: null },
      },
    });
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(uses, 1);
    assert.equal(store.read("17").energyBooster.pending, null);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("account service applies the booster immediately without a queue job", async () => {
  const directory = mkdtempSync(join(tmpdir(), "energy-queue-"));
  const store = createAutomationStateStore({ directory });
  let stock = 1,
    energy = 0,
    uses = 0;
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({
        playerId: 17,
        wallet: { dollar: 10 },
        energy: { current: energy, max: 10 },
      });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: {
          small: {
            count: stock,
            costDollar: 5,
            restoreEnergy: 5,
            maxPurchaseQuantity: 1,
          },
        },
      });
    if (path === "/api/me/bag/boosters/use") {
      uses++;
      stock--;
      energy = 5;
      return Response.json({ success: true });
    }
    throw new Error(path);
  };
  const service = createAutomationService({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 17 }),
    getBoss: () => null,
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    await service.command(entry, {
      id: "energy-job-01",
      command: "energy.booster.use",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "small", maxPrice: null },
    });
    assert.equal(service.snapshot(entry).queuedActions.length, 0);
    assert.equal(uses, 1);
    assert.equal(store.read("17").energyBooster.pending, null);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("confirmed purchase survives service restart and applies only once", async () => {
  const directory = mkdtempSync(join(tmpdir(), "energy-restart-"));
  const store = createAutomationStateStore({ directory });
  let clock = 1000000,
    stock = 0,
    energy = 0,
    dollar = 20,
    buys = 0,
    uses = 0;
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({
        playerId: 17,
        wallet: { dollar },
        energy: { current: energy, max: 10 },
      });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: {
          full: {
            count: stock,
            costDollar: 5,
            restoreEnergy: 10,
            maxPurchaseQuantity: 1,
          },
        },
      });
    if (path === "/api/me/bag/boosters/buy") {
      buys++;
      stock++;
      dollar -= 5;
      throw new Error("lost response");
    }
    if (path === "/api/me/bag/boosters/use") {
      uses++;
      stock--;
      energy = 10;
      return Response.json({ success: true });
    }
    throw new Error(path);
  };
  const makeService = () =>
    createAutomationService({
      store,
      fetcher,
      identifyPlayer: async () => ({ playerId: 17 }),
      getBoss: () => null,
      now: () => clock,
      random: () => 0,
    });
  let service = makeService();
  try {
    let entry = await service.identify("Bearer fake-token");
    await service.command(entry, {
      id: "energy-job-02",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "energy.booster", action: { type: "full", maxPrice: 5 } },
    });
    await entry.actionQueue.tick();
    assert.equal(store.read("17").energyBooster.pending.phase, "purchased");
    assert.equal(buys, 1);
    service.close();
    service = makeService();
    entry = await service.identify("Bearer fake-token");
    clock += 20000;
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(buys, 1);
    assert.equal(uses, 1);
    assert.equal(store.read("17").energyBooster.pending, null);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("lost use survives restart and reconciles without a second use", async () => {
  const directory = mkdtempSync(join(tmpdir(), "energy-use-restart-"));
  const store = createAutomationStateStore({ directory });
  let clock = 1000000,
    stock = 1,
    energy = 0,
    uses = 0,
    offline = false;
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (offline) throw new Error("offline");
    if (path === "/api/me")
      return Response.json({
        playerId: 17,
        wallet: { dollar: 20 },
        energy: { current: energy, max: 10 },
      });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: {
          full: {
            count: stock,
            costDollar: 5,
            restoreEnergy: 10,
            maxPurchaseQuantity: 1,
          },
        },
      });
    if (path === "/api/me/bag/boosters/use") {
      uses++;
      stock--;
      energy = 10;
      offline = true;
      throw new Error("lost response");
    }
    throw new Error(path);
  };
  const makeService = () =>
    createAutomationService({
      store,
      fetcher,
      identifyPlayer: async () => ({ playerId: 17 }),
      getBoss: () => null,
      now: () => clock,
      random: () => 0,
    });
  let service = makeService();
  try {
    let entry = await service.identify("Bearer fake-token");
    await service.command(entry, {
      id: "energy-job-03",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: {
        type: "energy.booster",
        action: { type: "full", maxPrice: null },
      },
    });
    await entry.actionQueue.tick();
    assert.equal(store.read("17").energyBooster.pending.phase, "using");
    assert.equal(
      service.snapshot(entry).queuedActions[0].status,
      "reconciling",
    );
    service.close();
    offline = false;
    clock += 20000;
    service = makeService();
    entry = await service.identify("Bearer fake-token");
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(uses, 1);
    assert.equal(store.read("17").energyBooster.pending, null);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancelling while a submitted purchase completes does not apply the booster", async () => {
  const directory = mkdtempSync(join(tmpdir(), "energy-cancel-buy-"));
  const store = createAutomationStateStore({ directory });
  let stock = 0,
    dollar = 20,
    uses = 0,
    release,
    submitted;
  const sent = new Promise((resolve) => {
    submitted = resolve;
  });
  const fetcher = async (url) => {
    const path = new URL(url).pathname;
    if (path === "/api/me")
      return Response.json({
        playerId: 17,
        wallet: { dollar },
        energy: { current: 0, max: 10 },
      });
    if (path === "/api/me/bag")
      return Response.json({
        boosters: {
          full: {
            count: stock,
            costDollar: 5,
            restoreEnergy: 10,
            maxPurchaseQuantity: 1,
          },
        },
      });
    if (path === "/api/me/bag/boosters/buy") {
      stock++;
      dollar -= 5;
      submitted();
      await new Promise((resolve) => {
        release = resolve;
      });
      return Response.json({ success: true });
    }
    if (path === "/api/me/bag/boosters/use") {
      uses++;
      return Response.json({ success: true });
    }
    throw new Error(path);
  };
  const service = createAutomationService({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 17 }),
    getBoss: () => null,
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    await service.command(entry, {
      id: "energy-job-04",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "energy.booster", action: { type: "full", maxPrice: 5 } },
    });
    const tick = entry.actionQueue.tick();
    await sent;
    await service.command(entry, {
      id: "energy-stop-04",
      command: "queue.cancel",
      expectedVersion: service.snapshot(entry).version,
      args: { id: "energy-job-04" },
    });
    release();
    await tick;
    assert.equal(service.snapshot(entry).queuedActions[0].status, "cancelled");
    assert.equal(store.read("17").energyBooster.pending, null);
    assert.equal(uses, 0);
    assert.equal(stock, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
