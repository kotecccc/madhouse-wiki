import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationService } from "./service.mjs";
import { createAutomationStateStore } from "./state-store.mjs";
import { inventoryGame } from "../../tests/helpers/inventory-game.mjs";

const credential = "Bearer event.queue.test";
const purchase = (id = 1) => ({
  type: "weapon",
  id,
  action: "buy",
  price: { amount: 100, currency: "gold" },
});

async function harness(
  fetcher,
  {
    now = Date.now,
    savedCooldownMs = 0,
    bridgeOwnerKeyForPlayer = () => null,
  } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "event-driven-queue-"));
  const store = createAutomationStateStore({ directory });
  if (savedCooldownMs > 0) {
    const timestamp = now();
    store.acquireLease("cooldown-seed", timestamp, 15_000);
    store.setQueueCooldown(
      timestamp + savedCooldownMs,
      1,
      "cooldown-seed",
      timestamp,
    );
    store.releaseLease("cooldown-seed");
  }
  const service = createAutomationService({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
    now,
    schedule: () => ({ unref() {} }),
    cancel: () => {},
    random: () => 0,
    bridgeOwnerKeyForPlayer,
  });
  const entry = await service.identify(credential);
  let heartbeatCallback;
  const nativeInterval = globalThis.setInterval;
  globalThis.setInterval = (callback, delay, ...args) => {
    heartbeatCallback = callback;
    return nativeInterval(() => {}, Math.max(delay, 60_000), ...args);
  };
  try {
    await service.boot();
  } finally {
    globalThis.setInterval = nativeInterval;
  }
  return {
    directory,
    store,
    service,
    entry,
    heartbeatCallback,
    close() {
      service.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
    async enqueue(id, args = purchase()) {
      return service.command(entry, {
        id,
        command: "queue.enqueue",
        expectedVersion: service.snapshot(entry).version,
        args: { type: "inventory", action: args },
      });
    },
    async cancel(id, jobId) {
      return service.command(entry, {
        id,
        command: "queue.cancel",
        expectedVersion: service.snapshot(entry).version,
        args: { id: jobId },
      });
    },
  };
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${label}`);
}

test("queued work wakes from an empty queue without a heartbeat tick", async () => {
  const game = inventoryGame();
  const h = await harness(game.fetcher);
  try {
    assert.equal(typeof h.heartbeatCallback, "function");
    assert.equal(h.service.snapshot(h.entry).queuedActions.length, 0);
    await h.enqueue("wake-empty-queue");
    await waitFor(
      () =>
        h.service.snapshot(h.entry).queuedActions[0]?.status === "completed",
      "event-driven queue completion",
    );
    assert.equal(game.mutations().length, 1);
  } finally {
    h.close();
  }
});

test("manual equipment wakes from an empty queue without a heartbeat tick", async () => {
  const game = inventoryGame({ owned: true });
  const h = await harness(game.fetcher);
  try {
    assert.equal(typeof h.heartbeatCallback, "function");
    await h.enqueue("wake-equip-weapon", {
      type: "weapon",
      id: 1,
      action: "equip",
    });
    await waitFor(
      () =>
        h.service.snapshot(h.entry).queuedActions[0]?.status === "completed",
      "event-driven equipment completion",
    );
    assert.equal(game.mutations().length, 1);
    assert.equal(game.items.weapon.equipped, true);
  } finally {
    h.close();
  }
});

test("wake storms preserve the durable checkpoint, serialization, and cancellation", async () => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const held = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const game = inventoryGame();
  let activeMutations = 0;
  let maximumActiveMutations = 0;
  const fetcher = async (url, init = {}) => {
    if (init.method && init.method !== "GET") {
      activeMutations++;
      maximumActiveMutations = Math.max(
        maximumActiveMutations,
        activeMutations,
      );
      const persisted = storeForDispatch?.read("1");
      assert.equal(persisted?.queuedActions?.[0]?.status, "running");
      firstStarted();
      try {
        await held;
        return await game.fetcher(url, init);
      } finally {
        activeMutations--;
      }
    }
    return game.fetcher(url, init);
  };
  let storeForDispatch;
  const h = await harness(fetcher);
  storeForDispatch = h.store;
  try {
    await h.enqueue("wake-first-job", purchase(1));
    await started;
    await h.enqueue("wake-cancel-job", purchase(2));
    for (let i = 0; i < 20; i++) h.entry.actionQueue.rescheduleWake();
    await h.cancel("cancel-second-job", "wake-cancel-job");
    releaseFirst();
    await waitFor(
      () =>
        h.service.snapshot(h.entry).queuedActions[0]?.status === "completed",
      "first queued mutation completion",
    );
    const jobs = h.service.snapshot(h.entry).queuedActions;
    assert.equal(
      jobs.find((job) => job.id === "wake-cancel-job").status,
      "cancelled",
    );
    assert.equal(maximumActiveMutations, 1);
    assert.equal(game.mutations().length, 1);
  } finally {
    releaseFirst();
    h.close();
  }
});

test("an independent action wakes after mutation release and cooldown without heartbeat", async () => {
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const held = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  const game = inventoryGame();
  const mutationPaths = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method && init.method !== "GET") {
      mutationPaths.push(path);
      if (path === "/api/weapons/buy") {
        firstStarted();
        await held;
      }
    }
    return game.fetcher(url, init);
  };
  const h = await harness(fetcher);
  try {
    assert.equal(typeof h.heartbeatCallback, "function");
    await h.enqueue("wake-held-weapon", purchase(1));
    await started;
    await h.enqueue("wake-pending-pet", {
      type: "pet",
      id: 2,
      action: "buy",
      price: { amount: 100, currency: "gold" },
    });
    releaseFirst();
    await waitFor(
      () =>
        h.service
          .snapshot(h.entry)
          .queuedActions.every((job) => job.status === "completed"),
      "both independent purchases after the serialized cooldown",
    );
    assert.deepEqual(mutationPaths, ["/api/weapons/buy", "/api/pets/buy"]);
    assert.equal(game.mutations().length, 2);
  } finally {
    releaseFirst();
    h.close();
  }
});

test("a 429 keeps the uncertain checkpoint behind the shared cooldown", async () => {
  let clock = Date.now();
  const game = inventoryGame();
  let mutationCount = 0;
  const fetcher = async (url, init = {}) => {
    if (init.method && init.method !== "GET") {
      mutationCount++;
      return new Response(null, {
        status: 429,
        headers: { "Retry-After": "120" },
      });
    }
    return game.fetcher(url, init);
  };
  const h = await harness(fetcher, { now: () => clock });
  try {
    await h.enqueue("wake-rate-limited-job");
    await waitFor(
      () =>
        h.service.snapshot(h.entry).queuedActions[0]?.status === "reconciling",
      "429 reconciliation checkpoint",
    );
    const checkpoint = h.service.snapshot(h.entry).queuedActions[0];
    assert.ok(checkpoint.nextAt > clock);
    assert.ok(h.store.getQueueCooldown().readyAt > clock);
    assert.equal(mutationCount, 1);
    for (let i = 0; i < 20; i++) h.entry.actionQueue.rescheduleWake();
    clock += 1000;
    assert.equal(h.entry.actionQueue.hasDue(), false);
    assert.equal(mutationCount, 1);
  } finally {
    h.close();
  }
});

test("verified bridge reconnect reschedules a saved job only after cooldown without heartbeat", async () => {
  const game = inventoryGame();
  const cooldownMs = 800;
  const h = await harness(game.fetcher, {
    savedCooldownMs: cooldownMs,
    bridgeOwnerKeyForPlayer: (playerId) =>
      String(playerId) === "1" ? "verified-owner" : null,
  });
  try {
    assert.equal(typeof h.heartbeatCallback, "function");
    await h.enqueue("bridge-cooldown-job");
    const beforeReconnect = h.store.read("1").queuedActions[0];
    assert.equal(beforeReconnect.status, "queued");
    assert.equal(beforeReconnect.attempts, 0);

    assert.equal(h.service.wakeBridgeOwner("verified-owner"), true);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const beforeDeadline = h.store.read("1").queuedActions[0];
    assert.equal(beforeDeadline.status, "queued");
    assert.equal(beforeDeadline.attempts, 0);
    assert.equal(game.mutations().length, 0);

    await waitFor(
      () =>
        h.service.snapshot(h.entry).queuedActions[0]?.status === "completed",
      "saved cooldown deadline and bridge wake",
    );
    assert.equal(game.mutations().length, 1);
    assert.equal(h.store.read("1").queuedActions[0].attempts, 0);
  } finally {
    h.close();
  }
});
