import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFriendSnapshot } from "./friend-snapshot.mjs";
import { createAutomationService } from "./service.mjs";
import { createAutomationStateStore } from "./state-store.mjs";
import { createAutomationHttp } from "./http.mjs";

const row = (playerId, nickname) => ({
  player: {
    playerId,
    nickname,
    username: `user${playerId}`,
    stats: { madness: 3 },
    token: "secret",
  },
});
async function waitFor(check) {
  const end = Date.now() + 5000;
  while (!check() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.ok(check());
}

test("friend snapshots require a complete bounded traversal and strip unrelated fields", async () => {
  let reads = 0;
  const fetcher = async (url) => {
    reads++;
    const cursor = new URL(url).searchParams.get("cursor");
    return Response.json(
      cursor
        ? { items: [row(2, "Bob")], nextCursor: null }
        : { items: [row(1, "Alice")], nextCursor: "next" },
    );
  };
  const items = await readFriendSnapshot({
    fetcher,
    credential: "Bearer fake",
  });
  assert.deepEqual(
    items.map((item) => item.playerId),
    [1, 2],
  );
  assert.equal(reads, 2);
  assert.equal("token" in items[0], false);
  await assert.rejects(
    readFriendSnapshot({
      credential: "Bearer fake",
      fetcher: async () =>
        Response.json({ items: [row(1, "Alice")], nextCursor: "same" }),
    }),
    /friends_incomplete/,
  );
});

test("combat defers background friends and invitations but allows a requested friends refresh", async () => {
  const directory = mkdtempSync(join(tmpdir(), "combat-background-"));
  const store = createAutomationStateStore({ directory });
  const calls = [];
  const service = createAutomationService({
    store,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
    fetcher: async (url) => {
      const path = new URL(url).pathname;
      calls.push(path);
      if (path === "/api/friends")
        return Response.json({ items: [row(2, "Bob")], nextCursor: null });
      if (path === "/api/bosses/invitations")
        return Response.json({ items: [] });
      if (path === "/api/combat") return Response.json({ activeBattle: null });
      return Response.json({ playerId: 1 });
    },
  });
  try {
    const entry = await service.identify("Bearer account-a");
    entry.controller.restoreState({
      ...entry.controller.getSnapshot(),
      boss: { id: 7, name: "Boss" },
      battle: { id: "fight-1", status: "active" },
    });
    service.friends(entry, "Bearer account-a");
    await service.boot();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(calls.filter((path) => path === "/api/friends").length, 0);
    assert.equal(
      calls.filter((path) => path === "/api/bosses/invitations").length,
      0,
    );
    entry.busy = true;
    await service.refreshFriends(entry, "Bearer account-a");
    assert.equal(calls.filter((path) => path === "/api/friends").length, 0);
    entry.busy = false;
    await waitFor(
      () => calls.filter((path) => path === "/api/friends").length === 1,
    );
    entry.controller.reset();
    entry.controller.restoreState({
      ...entry.controller.getSnapshot(),
      boss: { id: 7, name: "Boss" },
      battle: { id: "fight-1", status: "won" },
    });
    await waitFor(() => calls.includes("/api/bosses/invitations"));
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a complete friend snapshot stays account-isolated through a partial outage and restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "friend-snapshot-"));
  const store = createAutomationStateStore({ directory });
  let clock = 1000000,
    partial = false;
  const fetcher = async (url, init = {}) => {
    const parsed = new URL(url),
      auth = new Headers(init.headers).get("authorization");
    if (parsed.pathname === "/api/friends") {
      const cursor = parsed.searchParams.get("cursor");
      if (auth === "Bearer account-b")
        return Response.json({ items: [row(8, "Other")], nextCursor: null });
      if (cursor && partial) return new Response(null, { status: 503 });
      return Response.json(
        cursor
          ? { items: [row(2, "Bob")], nextCursor: null }
          : {
              items: [row(1, partial ? "Changed" : "Alice")],
              nextCursor: "next",
            },
      );
    }
    if (parsed.pathname === "/api/combat")
      return Response.json({ activeBattle: null });
    if (parsed.pathname === "/api/bosses/invitations")
      return Response.json({ items: [] });
    return Response.json({ playerId: auth === "Bearer account-b" ? 2 : 1 });
  };
  const create = () =>
    createAutomationService({
      store,
      fetcher,
      identifyPlayer: async (auth) => ({
        playerId: auth === "Bearer account-b" ? 2 : 1,
      }),
      getBoss: () => null,
      now: () => clock,
      random: () => 0,
    });
  let service = create();
  try {
    const a = await service.identify("Bearer account-a"),
      b = await service.identify("Bearer account-b");
    const handle = createAutomationHttp({ service });
    const read = async (authorization) => {
      const response = await handle(
        new Request("https://example.test/api/automation/friends", {
          headers: { authorization },
        }),
      );
      assert.equal(response.status, 200);
      return response.json();
    };
    assert.equal((await read("Bearer account-a")).items, null);
    assert.equal((await read("Bearer account-b")).items, null);
    await service.boot();
    await waitFor(
      () =>
        service.friends(a, "Bearer account-a").items?.length === 2 &&
        service.friends(b, "Bearer account-b").items?.length === 1,
    );
    assert.deepEqual(
      (await read("Bearer account-a")).items.map((item) => item.nickname),
      ["Alice", "Bob"],
    );
    assert.deepEqual(
      (await read("Bearer account-b")).items.map((item) => item.nickname),
      ["Other"],
    );
    assert.throws(
      () => service.friends(a, "Bearer account-b"),
      /game_session_required/,
    );
    clock += 1000;
    const refresh = await handle(
      new Request("https://example.test/api/automation/friends/refresh", {
        method: "POST",
        headers: {
          authorization: "Bearer account-a",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    assert.equal(refresh.status, 200);
    await waitFor(
      () => service.friends(a, "Bearer account-a").updatedAt === clock,
    );
    assert.notEqual(service.friends(b, "Bearer account-b").updatedAt, clock);
    partial = true;
    clock += 300000;
    await waitFor(
      () =>
        store.read("1").friendSnapshot.failures > 0 &&
        !service.friends(a, "Bearer account-a").refreshing,
    );
    assert.deepEqual(
      service.friends(a, "Bearer account-a").items.map((item) => item.nickname),
      ["Alice", "Bob"],
    );
    service.close();
    service = create();
    await service.boot();
    const restored = await service.identify("Bearer account-a");
    assert.deepEqual(
      service
        .friends(restored, "Bearer account-a")
        .items.map((item) => item.nickname),
      ["Alice", "Bob"],
    );
    assert.equal(service.friends(restored, "Bearer account-a").stale, true);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
