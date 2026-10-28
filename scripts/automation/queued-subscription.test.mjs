import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { createRaidSubscription } from "./raid-subscription.mjs";
import { queuedSubscriptionAdapter } from "./queued-subscription.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationStateStore } from "./state-store.mjs";
import { createAutomationService } from "./service.mjs";

function harness() {
  let now = 1000;
  let online = false;
  let state;
  const entry = { invitations: { items: [] } };
  entry.raidSubscription = createRaidSubscription({
    now: () => now,
    persist: () => true,
  });
  const queue = createActionQueue({
    now: () => now,
    random: () => 0,
    persist: (items) => {
      state = items;
    },
    adapters: {
      "subscription.start": queuedSubscriptionAdapter({
        entry,
        now: () => now,
        getBoss: (id) => ({ numericId: id, name: "Босс" }),
        refresh: async () => {
          if (!online)
            throw Object.assign(new Error("offline"), {
              status: 503,
              retryAfterMs: 20000,
            });
          entry.invitations.items = [
            {
              invitationId: "invite-1",
              battleId: "battle-1",
              leaderPlayerId: 42,
              leaderUsername: "leader",
              bossId: 7,
              available: true,
              expiresAt: now + 60000,
            },
          ];
        },
      }),
    },
  });
  return {
    entry,
    queue,
    state: () => state,
    online: () => {
      online = true;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

test("subscription stops on a permanent invitation-read rejection", async () => {
  let starts = 0;
  const entry = {
    raidSubscription: { getSnapshot: () => ({}), start: () => starts++ },
  };
  const adapter = queuedSubscriptionAdapter({
    entry,
    now: () => 1000,
    refresh: async () => {
      throw Object.assign(new Error("rejected"), { status: 400 });
    },
  });
  const result = await adapter.execute(
    { id: "subscription-rejected", args: { leaderPlayerId: 42, bossId: 7 } },
    { canDispatch: () => true },
  );
  assert.deepEqual(result, {
    status: "failed",
    reason: "game_request_rejected",
  });
  assert.equal(starts, 0);
});

test("subscription waits for a fresh verified invitation and honors Retry-After", async () => {
  const h = harness();
  h.queue.add({
    id: "subscribe-01",
    type: "subscription.start",
    args: { leaderPlayerId: 42, bossId: 7, leaderUsername: "leader" },
  });
  await h.queue.tick();
  assert.equal(h.state()[0].status, "waiting");
  assert.equal(h.state()[0].nextAt, 21000);
  assert.equal(h.entry.raidSubscription.getSnapshot().enabled, false);
  h.online();
  h.advance(20000);
  await h.queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.entry.raidSubscription.getSnapshot().leaderPlayerId, 42);
  assert.equal(h.entry.raidSubscription.getSnapshot().queueId, "subscribe-01");
});

test("reconciliation uses the durable receipt after a later subscription replaces it", async () => {
  const h = harness();
  h.queue.add({
    id: "subscribe-01",
    type: "subscription.start",
    args: { bossId: 7, leaderUsername: "leader" },
  });
  await h.queue.tick();
  const adapter = queuedSubscriptionAdapter({
    entry: h.entry,
    getBoss: () => null,
    now: () => 1000,
  });
  h.entry.raidSubscription.stop();
  h.entry.raidSubscription.start({
    bossId: 8,
    leaderUsername: "other",
    queueId: "subscribe-02",
  });
  assert.equal(
    (await adapter.reconcile({ id: "subscribe-01" })).status,
    "completed",
  );
  assert.equal(h.entry.raidSubscription.getSnapshot().bossId, 8);
});

test("cancelling during the invitation read prevents a late subscription", async () => {
  let release;
  let stored;
  const entry = { invitations: { items: [] } };
  entry.raidSubscription = createRaidSubscription({ persist: () => true });
  const queue = createActionQueue({
    persist: (items) => {
      stored = items;
    },
    adapters: {
      "subscription.start": queuedSubscriptionAdapter({
        entry,
        now: () => 1000,
        getBoss: () => null,
        refresh: async () => {
          await new Promise((resolve) => {
            release = resolve;
          });
          entry.invitations.items = [
            {
              leaderPlayerId: 42,
              bossId: 7,
              available: true,
              expiresAt: 60000,
            },
          ];
        },
      }),
    },
  });
  queue.add({
    id: "subscribe-01",
    type: "subscription.start",
    args: { bossId: 7, leaderPlayerId: 42 },
  });
  const tick = queue.tick();
  queue.stop("subscribe-01");
  release();
  await tick;
  assert.equal(stored[0].status, "cancelled");
  assert.notEqual(entry.raidSubscription.getSnapshot().enabled, true);
});

test("service stores and starts a named subscription without the game API", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-subscription-"));
  const store = createAutomationStateStore({ directory });
  const service = createAutomationService({
    store,
    identifyPlayer: async () => ({ playerId: 17 }),
    fetcher: async () => {
      throw new Error("offline");
    },
    getBoss: (id) => ({ numericId: id, name: "Босс" }),
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    await service.command(entry, {
      id: "subscribe-01",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: {
        type: "subscription.start",
        action: { bossId: 7, leaderUsername: "leader" },
      },
    });
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(service.snapshot(entry).subscription.leaderUsername, "leader");
    await service.command(entry, {
      id: "stop-sub-01",
      command: "queue.cancel",
      expectedVersion: service.snapshot(entry).version,
      args: { id: "subscribe-01" },
    });
    assert.equal(service.snapshot(entry).subscription.enabled, false);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service preserves the game's Retry-After for invitation discovery", async () => {
  const directory = mkdtempSync(join(tmpdir(), "subscription-retry-after-"));
  const store = createAutomationStateStore({ directory });
  const service = createAutomationService({
    store,
    now: () => 1000,
    random: () => 0,
    identifyPlayer: async () => ({ playerId: 17 }),
    fetcher: async () =>
      new Response(null, { status: 429, headers: { "Retry-After": "90" } }),
    getBoss: (id) => ({ numericId: id }),
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    await service.command(entry, {
      id: "subscribe-01",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: {
        type: "subscription.start",
        action: { bossId: 7, leaderPlayerId: 42 },
      },
    });
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].nextAt, 91000);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
