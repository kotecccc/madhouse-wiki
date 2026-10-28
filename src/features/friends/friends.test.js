import test from "node:test";
import assert from "node:assert/strict";
import { loadFriends } from "./friends.js";

test("loads all friend pages and passes the cursor", async () => {
  const calls = [];
  const rows = await loadFriends(async (path) => {
    calls.push(path);
    return calls.length === 1
      ? { items: [{ player: { playerId: 1 } }], nextCursor: "next" }
      : { items: [{ player: { playerId: 2 } }], nextCursor: null };
  });
  assert.deepEqual(
    rows.map((row) => row.playerId),
    [1, 2],
  );
  assert.match(calls[1], /cursor=next/);
});

test("refuses incomplete responses and repeated cursors", async () => {
  await assert.rejects(loadFriends(async () => ({ items: [] })));
  await assert.rejects(
    loadFriends(async () => ({ items: [], nextCursor: "same" })),
  );
});

test("normalizes documented friend fields and preserves unknown values", async () => {
  const { normalizeFriend } = await import("./friends.js");
  const friend = normalizeFriend({
    playerId: 4,
    nickname: " Alice ",
    username: "@alice",
    isOnline: false,
    lastSeenAtUtc: "2026-10-20T12:00:00Z",
    stats: { madness: 0, aggression: 42 },
    level: 10,
    experience: 123,
    avatarUrl: "javascript:alert(1)",
  });
  assert.equal(friend.madness, 0);
  assert.equal(friend.rage, null);
  assert.equal(friend.isOnline, false);
  assert.equal(friend.avatarUrl, null);
  assert.equal(friend.lastSeenAt, Date.parse("2026-10-20T12:00:00Z"));
});

test("searches and filters all friends and sorts unknown values last", async () => {
  const { normalizeFriend, selectFriends } = await import("./friends.js");
  const friends = [
    {
      playerId: 1,
      nickname: "Алиса",
      username: "alice",
      isOnline: true,
      stats: { rage: 5 },
    },
    { playerId: 2, nickname: "Борис", isOnline: false, stats: { rage: 12 } },
    { playerId: 3, nickname: "Вика" },
  ].map(normalizeFriend);
  assert.deepEqual(
    selectFriends(friends, { search: "@ali" }).map((x) => x.playerId),
    [1],
  );
  assert.deepEqual(
    selectFriends(friends, { filter: "offline" }).map((x) => x.playerId),
    [2],
  );
  assert.deepEqual(
    selectFriends(friends, { sort: "rage" }).map((x) => x.playerId),
    [2, 1, 3],
  );
});

test("cancelling a page load stops pagination without cancelling a shared request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = loadFriends(async (_path, options) => {
    calls++;
    assert.equal(options.signal, undefined);
    controller.abort();
    return { items: [{ player: { playerId: 1 } }], nextCursor: "next" };
  }, controller.signal);
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(calls, 1);
});

test("Buddy filter shows only selected friends", async () => {
  const { selectFriends } = await import("./friends.js");
  const friends = [
    { playerId: 1, nickname: "А", username: "" },
    { playerId: 2, nickname: "Б", username: "" },
  ];
  assert.deepEqual(
    selectFriends(friends, { filter: "buddy", buddyFriends: [2] }).map(
      (friend) => friend.playerId,
    ),
    [2],
  );
});

test("priority sorting follows Buddy order and places other friends last", async () => {
  const { selectFriends } = await import("./friends.js");
  const friends = [
    { playerId: 1, nickname: "А", username: "" },
    { playerId: 2, nickname: "Б", username: "" },
    { playerId: 3, nickname: "В", username: "" },
  ];
  assert.deepEqual(
    selectFriends(friends, { sort: "priority", buddyFriends: [3, 1] }).map(
      (friend) => friend.playerId,
    ),
    [3, 1, 2],
  );
  assert.deepEqual(
    selectFriends(friends, {
      filter: "buddy",
      sort: "priority",
      buddyFriends: [3, 1],
    }).map((friend) => friend.playerId),
    [3, 1],
  );
});

test("online sorting orders online first, then recent offline, then unknown", async () => {
  const { selectFriends } = await import("./friends.js");
  const friends = [
    {
      playerId: 1,
      nickname: "А",
      username: "",
      isOnline: false,
      lastSeenAt: 10,
    },
    { playerId: 2, nickname: "Б", username: "", isOnline: true, lastSeenAt: 1 },
    {
      playerId: 3,
      nickname: "В",
      username: "",
      isOnline: false,
      lastSeenAt: 20,
    },
    {
      playerId: 4,
      nickname: "Г",
      username: "",
      isOnline: null,
      lastSeenAt: null,
    },
  ];
  assert.deepEqual(
    selectFriends(friends, { sort: "online" }).map((friend) => friend.playerId),
    [2, 3, 1, 4],
  );
});
