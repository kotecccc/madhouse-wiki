import test from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedInventoryAdapter } from "./queued-inventory.mjs";
import { inventoryGame } from "../../tests/helpers/inventory-game.mjs";

const purchase = {
  type: "weapon",
  id: 1,
  action: "buy",
  price: { amount: 100, currency: "gold" },
};
function harness(fetcher, initial = {}) {
  const entry = {
    credential: "Bearer fake",
    equipment: initial.equipment ?? { pending: null },
    storageFailed: false,
  };
  let clock = 0;
  let stored = initial.queue ?? [];
  const queue = createActionQueue({
    saved: stored,
    now: () => clock,
    random: () => 0,
    persist: (state) => {
      stored = state;
    },
    adapters: {
      inventory: queuedInventoryAdapter({ entry, fetcher, save: () => {} }),
    },
  });
  return {
    queue,
    entry,
    state: () => structuredClone(stored),
    advance: (ms) => {
      clock += ms;
    },
  };
}

test("inventory intent survives preflight outage and is executed once after recovery", async () => {
  const game = inventoryGame();
  let online = false;
  const h = harness((...args) =>
    online ? game.fetcher(...args) : Promise.reject(new Error("offline")),
  );
  h.queue.add({ id: "purchase-1", type: "inventory", args: purchase });
  await h.queue.tick();
  assert.equal(h.state()[0].status, "waiting");
  assert.equal(game.mutations().length, 0);
  online = true;
  h.advance(10000);
  await h.queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(game.mutations().length, 1);
});

test("outage barrier deadline is retained in the inventory queue", async () => {
  const h = harness(async () => {
    throw Object.assign(new Error("game_outage_wait"), {
      notDispatched: true,
      retryAfterMs: 120000,
    });
  });
  h.queue.add({ id: "purchase-outage", type: "inventory", args: purchase });
  await h.queue.tick();
  assert.equal(h.state()[0].status, "waiting");
  assert.equal(h.state()[0].nextAt, 120000);
  assert.equal(h.entry.equipment.pending, null);
});

test("lost mutation response is reconciled after restart and never submitted again", async () => {
  const game = inventoryGame();
  let loseReply = true;
  const fetcher = async (...args) => {
    const response = await game.fetcher(...args);
    if (args[1]?.method === "POST" && loseReply) {
      loseReply = false;
      throw new Error("lost reply");
    }
    return response;
  };
  const first = harness(fetcher);
  first.queue.add({ id: "purchase-1", type: "inventory", args: purchase });
  await first.queue.tick();
  assert.equal(first.state()[0].status, "reconciling");
  assert.equal(game.mutations().length, 1);
  const second = harness(fetcher, {
    queue: first.state(),
    equipment: first.entry.equipment,
  });
  second.advance(10000);
  await second.queue.tick();
  assert.equal(second.state()[0].status, "completed");
  assert.equal(second.entry.equipment.pending, null);
  assert.equal(game.mutations().length, 1);
});

test("a blocked confirmation read never clears a submitted purchase checkpoint", async () => {
  const game = inventoryGame();
  let blockConfirmation = true;
  const fetcher = async (...args) => {
    if (blockConfirmation && game.mutations().length > 0) {
      blockConfirmation = false;
      throw Object.assign(new Error("read was not dispatched"), {
        notDispatched: true,
      });
    }
    return game.fetcher(...args);
  };
  const first = harness(fetcher);
  first.queue.add({
    id: "purchase-confirmation",
    type: "inventory",
    args: purchase,
  });
  await first.queue.tick();
  assert.equal(game.mutations().length, 1);
  assert.equal(first.state()[0].status, "reconciling");
  assert.ok(first.entry.equipment.pending);
  const second = harness(fetcher, {
    queue: first.state(),
    equipment: first.entry.equipment,
  });
  second.advance(10000);
  await second.queue.tick();
  assert.equal(second.state()[0].status, "completed");
  assert.equal(game.mutations().length, 1);
});

test("unconfirmed operation is kept for reconciliation even after cancel", async () => {
  const game = inventoryGame({ failMutation: true });
  const h = harness(game.fetcher);
  h.queue.add({ id: "purchase-1", type: "inventory", args: purchase });
  await h.queue.tick();
  h.queue.stop("purchase-1");
  h.advance(10000);
  await h.queue.tick();
  assert.equal(h.state()[0].status, "reconciling");
  assert.ok(h.entry.equipment.pending);
  assert.equal(game.mutations().length, 1);
});

test("service stores queued intents under the verified account and keeps cancellation across restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "queued-inventory-"));
  const store = createAutomationStateStore({ directory });
  const game = inventoryGame();
  const makeService = () =>
    createAutomationService({
      store,
      fetcher: game.fetcher,
      identifyPlayer: async (token) => ({
        playerId: token.includes("other") ? 2 : 1,
      }),
      getBoss: () => null,
    });
  let service = makeService();
  try {
    const first = await service.identify("Bearer first");
    const second = await service.identify("Bearer other");
    const command = {
      id: "purchase-1",
      expectedVersion: service.snapshot(first).version,
      command: "queue.enqueue",
      args: { type: "inventory", action: purchase },
    };
    const accepted = await service.command(first, command);
    assert.equal(accepted.queuedActions[0].status, "queued");
    assert.deepEqual(service.snapshot(second).queuedActions, []);
    assert.equal(JSON.stringify(accepted).includes("Bearer first"), false);
    assert.equal(game.mutations().length, 0);
    await service.command(first, {
      id: "cancel-0001",
      expectedVersion: accepted.version,
      command: "queue.cancel",
      args: { id: "purchase-1" },
    });
    service.close();
    service = makeService();
    const restored = await service.identify("Bearer first");
    assert.equal(
      service.snapshot(restored).queuedActions[0].status,
      "cancelled",
    );
    assert.equal(game.mutations().length, 0);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("server worker executes a persisted intent without a browser connection", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "queue-worker-"));
  const store = createAutomationStateStore({ directory });
  const game = inventoryGame();
  const service = createAutomationService({
    store,
    fetcher: game.fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
  });
  try {
    const entry = await service.identify("Bearer fake");
    await service.command(entry, {
      id: "purchase-1",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.enqueue",
      args: { type: "inventory", action: purchase },
    });
    await service.boot();
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(game.mutations().length, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a persisted common outage pauses due cards without executing them", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "queue-outage-ready-"));
  const store = createAutomationStateStore({ directory });
  let clock = 1000000;
  store.acquireLease("prior", clock, 1000);
  store.setGameOutage(
    { evidence: [], readyAt: clock + 120000, failures: 1 },
    "prior",
    clock,
  );
  store.releaseLease("prior");
  const game = inventoryGame();
  const service = createAutomationService({
    store,
    fetcher: game.fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
    now: () => clock,
  });
  try {
    const entry = await service.identify("Bearer fake");
    await service.command(entry, {
      id: "purchase-outage-ready",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.enqueue",
      args: { type: "inventory", action: purchase },
    });
    assert.equal(entry.actionQueue.hasDue(), false);
    assert.equal(entry.actionQueue.snapshot()[0].blockedBy, "game");
    assert.equal(service.snapshot(entry).queueNotBefore, clock + 120000);
    await entry.actionQueue.tick();
    assert.equal(entry.actionQueue.snapshot()[0].attempts, 0);
    assert.equal(game.mutations().length, 0);
    clock += 120000;
    assert.equal(entry.actionQueue.hasDue(), true);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("worker honors a shared cooldown restored from storage", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "queue-cooldown-worker-"));
  const store = createAutomationStateStore({ directory });
  const game = inventoryGame();
  const service = createAutomationService({
    store,
    fetcher: game.fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
  });
  // Another owner can persist the deadline after this service was created.
  const seededAt = Date.now();
  store.acquireLease("prior-worker", seededAt, 1000);
  store.setQueueCooldown(seededAt + 2500, 1, "prior-worker", seededAt);
  store.releaseLease("prior-worker");
  try {
    const entry = await service.identify("Bearer fake");
    await service.command(entry, {
      id: "purchase-cooldown-1",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.enqueue",
      args: { type: "inventory", action: purchase },
    });
    assert.equal(service.snapshot(entry).queueNotBefore, seededAt + 2500);
    await service.boot();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(game.mutations().length, 0);
    assert.notEqual(
      service.snapshot(entry).queuedActions[0].status,
      "completed",
    );
    const end = Date.now() + 5000;
    while (
      Date.now() < end &&
      service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(game.mutations().length, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cooldown storage failure stops further game mutations", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "queue-cooldown-failure-"));
  const store = createAutomationStateStore({ directory });
  store.setQueueCooldown = () => {
    throw new Error("disk failure");
  };
  const game = inventoryGame();
  const service = createAutomationService({
    store,
    fetcher: game.fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
  });
  try {
    const entry = await service.identify("Bearer fake");
    await service.command(entry, {
      id: "purchase-failure-1",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.enqueue",
      args: { type: "inventory", action: purchase },
    });
    await service.boot();
    await new Promise((resolve) => setTimeout(resolve, 2200));
    assert.equal(game.mutations().length, 1);
    assert.equal(entry.storageFailed, true);
    assert.notEqual(
      service.snapshot(entry).queuedActions[0].status,
      "completed",
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cooldown read failure prevents dispatch", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "queue-cooldown-read-"));
  const store = createAutomationStateStore({ directory });
  const game = inventoryGame();
  const service = createAutomationService({
    store,
    fetcher: game.fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
  });
  try {
    const entry = await service.identify("Bearer fake");
    await service.command(entry, {
      id: "purchase-read-failure",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.enqueue",
      args: { type: "inventory", action: purchase },
    });
    store.getQueueCooldown = () => {
      throw new Error("disk failure");
    };
    await service.boot();
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(game.mutations().length, 0);
    assert.equal(entry.storageFailed, true);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("purchase runs between work-farm steps without stopping the farm", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "queue-farm-"));
  const store = createAutomationStateStore({ directory });
  const game = inventoryGame();
  const service = createAutomationService({
    store,
    fetcher: game.fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
    getBusinessCatalogue: () => ({
      businesses: [],
      businessUpgrades: [],
      bosses: [],
      works: [{ workId: 7 }],
    }),
    schedule: () => ({}),
    cancel: () => {},
  });
  try {
    const entry = await service.identify("Bearer fake");
    await service.boot();
    await service.command(entry, {
      id: "work-start-1",
      expectedVersion: service.snapshot(entry).version,
      command: "work.start",
      args: {
        workId: 7,
        targetCycles: 5,
        mode: "wait",
        maxActions: 10,
        durationHours: 1,
        maxBoosters: 0,
        allowPurchase: false,
        maxDollar: 0,
      },
    });
    await service.command(entry, {
      id: "work-pause-1",
      expectedVersion: service.snapshot(entry).version,
      command: "work.pause",
      args: {},
    });
    assert.equal(service.snapshot(entry).workFarm.run.status, "paused");
    await service.command(entry, {
      id: "work-resume-1",
      expectedVersion: service.snapshot(entry).version,
      command: "work.resume",
      args: {},
    });
    assert.equal(service.snapshot(entry).workFarm.run.status, "running");
    await service.command(entry, {
      id: "purchase-1",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.enqueue",
      args: { type: "inventory", action: purchase },
    });
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(service.snapshot(entry).workFarm.run.status, "running");
    assert.equal(game.mutations().length, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("rate limits honor Retry-After without dispatching a mutation", async () => {
  const game = inventoryGame();
  let limited = true;
  const h = harness((...args) =>
    limited
      ? Promise.resolve(
          new Response(null, { status: 429, headers: { "Retry-After": "90" } }),
        )
      : game.fetcher(...args),
  );
  h.queue.add({ id: "purchase-1", type: "inventory", args: purchase });
  await h.queue.tick();
  assert.equal(h.state()[0].status, "waiting");
  assert.equal(h.state()[0].nextAt, 90000);
  limited = false;
  h.advance(89999);
  await h.queue.tick();
  assert.equal(game.mutations().length, 0);
  h.advance(1);
  await h.queue.tick();
  assert.equal(game.mutations().length, 1);
});

test("inventory waits for an in-flight work mutation before its own dispatch", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "queue-work-pending-"));
  const store = createAutomationStateStore({ directory });
  const game = inventoryGame();
  let releaseWork;
  let startedWork;
  const workStarted = new Promise((resolve) => {
    startedWork = resolve;
  });
  const work = (progress) => ({
    workId: 7,
    title: "Work",
    completedCycles: 0,
    tasks: [
      {
        id: 1,
        title: "Task",
        required: 3,
        progress,
        energyCost: 1,
        canPerform: true,
      },
    ],
    energy: {
      current: 10,
      max: 10,
      regenIntervalSeconds: 120,
      secondsToNext: 100,
    },
  });
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/works/open") return Response.json(work(0));
    if (path === "/api/me")
      return Response.json({
        playerId: 1,
        wallet: { gold: 10000, dollar: 100 },
        energy: work(0).energy,
      });
    if (path === "/api/me/bag") return Response.json({ boosters: {} });
    if (path === "/api/works/tasks/perform") {
      startedWork();
      await new Promise((resolve) => {
        releaseWork = resolve;
      });
      return Response.json(work(1));
    }
    return game.fetcher(url, init);
  };
  const timers = [];
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
    schedule: (callback) => {
      const timer = { callback };
      timers.push(timer);
      return timer;
    },
    cancel: (timer) => {
      timer.cancelled = true;
    },
  });
  try {
    const entry = await service.identify("Bearer fake");
    await service.boot();
    await service.command(entry, {
      id: "work-start-1",
      expectedVersion: service.snapshot(entry).version,
      command: "work.start",
      args: {
        workId: 7,
        targetCycles: 5,
        mode: "wait",
        maxActions: 10,
        durationHours: 1,
        maxBoosters: 0,
        allowPurchase: false,
        maxDollar: 0,
      },
    });
    const timer = timers.find((item) => !item.cancelled);
    assert.ok(timer);
    timer.callback();
    await workStarted;
    await service.command(entry, {
      id: "purchase-1",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.enqueue",
      args: { type: "inventory", action: purchase },
    });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(game.mutations().length, 0);
    assert.equal(service.snapshot(entry).queuedActions[0].status, "queued");
    releaseWork();
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(game.mutations().length, 1);
  } finally {
    releaseWork?.();
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("queued action confirms a previous purchase without repeating it", async () => {
  const game = inventoryGame({ owned: true });
  const h = harness(game.fetcher, {
    equipment: {
      pending: {
        id: "old-purchase",
        type: "weapon",
        entityId: 1,
        action: "buy",
      },
      checked: false,
    },
  });
  h.queue.add({ id: "purchase-1", type: "inventory", args: purchase });
  await h.queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.entry.equipment.pending, null);
  assert.equal(game.mutations().length, 0);
});
