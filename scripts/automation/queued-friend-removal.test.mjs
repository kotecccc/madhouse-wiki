import test from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedFriendRemovalAdapter } from "./queued-friend-removal.mjs";

function harness({ offline = false, lostReply = false } = {}) {
  let present = true,
    deleted = 0,
    clock = 0,
    stored = [];
  const entry = {
    credential: "Bearer fake",
    friendRemoval: { pending: null },
    preferences: { favoriteFriendIds: [7] },
    raidSubscription: {
      getSnapshot: () => ({ enabled: false }),
      setBuddyFriends: () => true,
    },
  };
  const fetcher = async (url, init = {}) => {
    if (offline) throw new Error("offline");
    if (init.method === "DELETE") {
      assert.ok(entry.friendRemoval.pending);
      assert.equal(init.canDispatch(), true);
      deleted++;
      present = false;
      if (lostReply) throw new Error("reply lost");
      return new Response(null, { status: 204 });
    }
    const friends = new URL(url).pathname === "/api/friends";
    return Response.json({
      items: friends && present ? [{ player: { playerId: 7 } }] : [],
      nextCursor: null,
    });
  };
  const queue = createActionQueue({
    now: () => clock,
    random: () => 0,
    persist: (value) => {
      stored = value;
    },
    adapters: {
      "friend.remove": queuedFriendRemovalAdapter({
        entry,
        fetcher,
        save: () => {},
      }),
    },
  });
  return {
    entry,
    queue,
    state: () => stored,
    deleted: () => deleted,
    advance: (ms) => {
      clock += ms;
    },
    online: () => {
      offline = false;
    },
  };
}

test("friend removal waits for recovery before its first submission", async () => {
  const h = harness({ offline: true });
  h.queue.add({
    id: "remove-0001",
    type: "friend.remove",
    args: { playerId: 7, name: "Alice" },
  });
  await h.queue.tick();
  assert.equal(h.state()[0].status, "waiting");
  assert.equal(h.deleted(), 0);
  h.online();
  h.advance(10000);
  await h.queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.deleted(), 1);
  assert.deepEqual(h.entry.preferences.favoriteFriendIds, []);
});

test("lost removal response is reconciled without repeating DELETE", async () => {
  const h = harness({ lostReply: true });
  h.queue.add({
    id: "remove-0001",
    type: "friend.remove",
    args: { playerId: 7 },
  });
  await h.queue.tick();
  assert.equal(h.state()[0].status, "reconciling");
  h.advance(10000);
  await h.queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.deleted(), 1);
  assert.equal(h.entry.friendRemoval.pending, null);
});

test("cancellation before deletion clears only a proven unsent checkpoint", async () => {
  const { removeFriend } = await import("./friend-removal.mjs");
  const h = harness();
  let saves = 0;
  await assert.rejects(
    removeFriend({
      entry: h.entry,
      playerId: 7,
      commandId: "remove-0001",
      save: () => {
        saves++;
      },
      allowed: () => false,
      fetcher: async () =>
        Response.json({
          items: [{ player: { playerId: 7 } }],
          nextCursor: null,
        }),
    }),
    (error) => error.notDispatched === true,
  );
  assert.equal(h.entry.friendRemoval.pending, null);
  assert.equal(saves, 2);
});

test("server reconciles a legacy pending removal without a browser or repeated DELETE", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "friend-removal-recover-"));
  const store = createAutomationStateStore({ directory });
  let deletes = 0;
  const fetcher = async (_url, init = {}) => {
    if (init.method === "DELETE") deletes++;
    return Response.json({ items: [], nextCursor: null });
  };
  const makeService = () =>
    createAutomationService({
      store,
      fetcher,
      identifyPlayer: async () => ({ playerId: 1 }),
      getBoss: () => null,
    });
  let service = makeService();
  try {
    await service.identify("Bearer fake");
    const saved = store.read("1");
    saved.friendRemoval = {
      pending: { playerId: 7, commandId: "older-action" },
    };
    store.write("1", saved);
    service.close();
    service = makeService();
    await service.boot();
    const entry = await service.identify("Bearer fake");
    const end = Date.now() + 4000;
    while (Date.now() < end && service.snapshot(entry).friendRemoval.pending)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(service.snapshot(entry).friendRemoval.pending, null);
    assert.equal(deletes, 0);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repeated clicks for the same friend share a single pending intention", async () => {
  const h = harness({ offline: true });
  const first = h.queue.add({
    id: "remove-0001",
    type: "friend.remove",
    args: { playerId: 7, name: "Alice" },
  });
  const second = h.queue.add({
    id: "remove-0002",
    type: "friend.remove",
    args: { playerId: 7, name: "Updated name" },
  });
  assert.equal(second.id, first.id);
  assert.equal(h.state().length, 1);
  h.online();
  await h.queue.tick();
  assert.equal(h.deleted(), 1);
});

test("friend list rate limit defers the first deletion until Retry-After", async () => {
  let clock = 0;
  const entry = {
    credential: "Bearer fake",
    friendRemoval: { pending: null },
    preferences: {},
    raidSubscription: { getSnapshot: () => ({ enabled: false }) },
  };
  const queue = createActionQueue({
    now: () => clock,
    random: () => 0,
    persist: () => true,
    adapters: {
      "friend.remove": queuedFriendRemovalAdapter({
        entry,
        save: () => {},
        fetcher: async () =>
          new Response(null, { status: 429, headers: { "Retry-After": "80" } }),
      }),
    },
  });
  queue.add({
    id: "remove-0001",
    type: "friend.remove",
    args: { playerId: 7 },
  });
  await queue.tick();
  assert.equal(queue.snapshot()[0].status, "waiting");
  assert.equal(queue.snapshot()[0].nextAt, 80000);
  clock = 79999;
  assert.equal(queue.hasDue(), false);
});

test("server executes queued removal while Buddy is monitoring and removes it from Buddy only after confirmation", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "friend-buddy-queue-"));
  const store = createAutomationStateStore({ directory });
  let present = true,
    deletes = 0;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (init.method === "DELETE") {
      deletes++;
      present = false;
      return new Response(null, { status: 204 });
    }
    if (path === "/api/friends")
      return Response.json({
        items: present ? [{ player: { playerId: 7 } }] : [],
        nextCursor: null,
      });
    if (path === "/api/friends/requests/outgoing")
      return Response.json({ items: [], nextCursor: null });
    if (path === "/api/bosses/invitations") return Response.json({ items: [] });
    if (path === "/api/combat") return Response.json({ activeBattle: null });
    return Response.json({ playerId: 1 });
  };
  const service = createAutomationService({
    store,
    fetcher,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
  });
  try {
    const entry = await service.identify("Bearer fake");
    assert.equal(entry.raidSubscription.setBuddyFriends([7]), true);
    await service.boot();
    const result = await service.command(entry, {
      id: "queued-remove-1",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: { type: "friend.remove", action: { playerId: 7, name: "Alice" } },
    });
    assert.equal(result.queuedActions[0].status, "queued");
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    const state = service.snapshot(entry);
    assert.equal(state.queuedActions[0].status, "completed");
    assert.equal(state.buddy.enabled, false);
    assert.equal(deletes, 1);
    await assert.rejects(
      service.command(entry, {
        id: "queued-remove-1",
        command: "favorites.set",
        expectedVersion: state.version,
        args: { bossIds: [] },
      }),
      /already_received/,
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
