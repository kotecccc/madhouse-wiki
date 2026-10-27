import test from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedFriendRequestAdapter } from "./queued-friend-request.mjs";

function harness({ offline = false, lostReply = false } = {}) {
  let clock = 0,
    sent = 0,
    outgoing = false,
    stored = [];
  const entry = {
    credential: "Bearer fake",
    raidFriend: { pending: null, status: null },
    raidFriendReceipts: [],
    raidFriendWatch: {},
    raidFriendStatuses: {},
  };
  const fetcher = async (url, init = {}) => {
    if (offline) throw new Error("offline");
    const path = new URL(url).pathname;
    if (init.method === "POST") {
      assert.ok(entry.raidFriend.pending);
      assert.equal(init.canDispatch(), true);
      sent++;
      outgoing = true;
      if (lostReply) throw new Error("reply lost");
      return new Response(null, { status: 204 });
    }
    if (path.endsWith("/search"))
      return Response.json({ players: [{ playerId: 7, username: "Alice" }] });
    return Response.json({
      items:
        path.endsWith("/outgoing") && outgoing
          ? [{ player: { playerId: 7, username: "Alice" } }]
          : [],
      nextCursor: null,
    });
  };
  const makeQueue = (saved = []) =>
    createActionQueue({
      saved,
      now: () => clock,
      random: () => 0,
      persist: (value) => {
        stored = value;
      },
      adapters: {
        "friend.request": queuedFriendRequestAdapter({
          entry,
          fetcher,
          save: () => {},
        }),
      },
    });
  return {
    entry,
    makeQueue,
    state: () => stored,
    sent: () => sent,
    advance: (ms) => {
      clock += ms;
    },
    online: () => {
      offline = false;
    },
  };
}
const add = (queue) =>
  queue.add({
    id: "request-0001",
    type: "friend.request",
    args: { playerId: 7, username: "Alice" },
  });

test("friend request survives a preflight outage and is sent once", async () => {
  const h = harness({ offline: true });
  const queue = h.makeQueue();
  add(queue);
  await queue.tick();
  assert.equal(h.state()[0].status, "waiting");
  assert.equal(h.sent(), 0);
  h.online();
  h.advance(10000);
  await queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.sent(), 1);
  assert.equal(h.entry.raidFriendStatuses["id:7"], "pending");
});

test("lost request response is read-only reconciled after restart", async () => {
  const h = harness({ lostReply: true });
  let queue = h.makeQueue();
  add(queue);
  await queue.tick();
  assert.equal(h.state()[0].status, "reconciling");
  queue = h.makeQueue(h.state());
  h.advance(10000);
  await queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.sent(), 1);
  assert.deepEqual(h.entry.raidFriendReceipts, ["request-0001"]);
});

test("restart after confirmation uses durable receipt without sending again", async () => {
  const h = harness();
  const queue = h.makeQueue();
  add(queue);
  await queue.tick();
  const saved = structuredClone(h.state());
  saved[0].status = "running";
  const restarted = h.makeQueue(saved);
  await restarted.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.sent(), 1);
});

test("cancellation before dispatch clears the unsent checkpoint", async () => {
  const { requestRaidFriend } = await import("./raid-friends.mjs");
  const h = harness();
  let checks = 0;
  await assert.rejects(
    requestRaidFriend({
      entry: h.entry,
      args: { playerId: 7 },
      commandId: "request-0001",
      save: () => {},
      allowed: () => ++checks === 1,
      fetcher: async (url) =>
        new URL(url).pathname.endsWith("/search")
          ? Response.json({ players: [{ playerId: 7 }] })
          : Response.json({ items: [], nextCursor: null }),
    }),
    (error) => error.notDispatched === true,
  );
  assert.equal(h.entry.raidFriend.pending, null);
  assert.equal(h.sent(), 0);
});

test("server executes a queued friend request and publishes the confirmed status", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "friend-request-queue-"));
  const store = createAutomationStateStore({ directory });
  let outgoing = false,
    posts = 0;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    if (path === "/api/friends/requests" && init.method === "POST") {
      outgoing = true;
      posts++;
      return new Response(null, { status: 204 });
    }
    if (path === "/api/friends/search")
      return Response.json({ players: [{ playerId: 7, username: "Alice" }] });
    if (path.startsWith("/api/friends"))
      return Response.json({
        items:
          path.endsWith("/outgoing") && outgoing
            ? [{ player: { playerId: 7, username: "Alice" } }]
            : [],
        nextCursor: null,
      });
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
    await service.boot();
    const result = await service.command(entry, {
      id: "request-queue-1",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: {
        type: "friend.request",
        action: { playerId: 7, username: "Alice" },
      },
    });
    assert.equal(result.queuedActions[0].status, "queued");
    const end = Date.now() + 4000;
    while (
      Date.now() < end &&
      service.snapshot(entry).queuedActions[0].status !== "completed"
    )
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(
      service.snapshot(entry).raidFriend.statuses["id:7"],
      "pending",
    );
    assert.equal(posts, 1);
    assert.ok(store.read("1").raidFriendReceipts.includes("request-queue-1"));
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("friend search respects Retry-After before attempting a request", async () => {
  let clock = 0;
  const entry = {
    credential: "Bearer fake",
    raidFriend: { pending: null },
    raidFriendReceipts: [],
    raidFriendWatch: {},
    raidFriendStatuses: {},
  };
  const queue = createActionQueue({
    now: () => clock,
    random: () => 0,
    persist: () => true,
    adapters: {
      "friend.request": queuedFriendRequestAdapter({
        entry,
        save: () => {},
        fetcher: async () =>
          new Response(null, { status: 429, headers: { "Retry-After": "80" } }),
      }),
    },
  });
  add(queue);
  await queue.tick();
  assert.equal(queue.snapshot()[0].status, "waiting");
  assert.equal(queue.snapshot()[0].nextAt, 80000);
  clock = 79999;
  assert.equal(queue.hasDue(), false);
});
