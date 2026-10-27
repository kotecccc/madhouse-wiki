import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveRaidLeader,
  checkRaidFriends,
  requestRaidFriend,
  reconcileRaidFriend,
  refreshWatchedRaidFriends,
} from "../scripts/automation/raid-friends.mjs";

test("background reads track multiple requests and keep uncertain checkpoints", async () => {
  const entry = {
    credential: "test",
    raidFriend: {
      pending: { playerId: 9 },
      username: "carol",
      status: "uncertain",
    },
    raidFriendWatch: { 7: "alice", 8: "bob" },
    raidFriendStatuses: {},
  };
  let calls = 0;
  const fetcher = async (url, options) => {
    assert.notEqual(options.method, "POST");
    calls++;
    return {
      ok: true,
      json: async () => ({
        items: url.includes("/api/friends?")
          ? [{ player: { playerId: 7, username: "alice" } }]
          : url.includes("/outgoing?")
            ? [{ player: { playerId: 8, username: "bob" } }]
            : [],
        nextCursor: null,
      }),
    };
  };
  let saves = 0;
  await refreshWatchedRaidFriends({
    entry,
    fetcher,
    save() {
      saves++;
    },
  });
  assert.equal(entry.raidFriendStatuses["id:7"], "friend");
  assert.equal(entry.raidFriendStatuses["id:8"], "pending");
  assert.equal(entry.raidFriendStatuses["id:9"], "uncertain");
  assert.equal(entry.raidFriend.pending.playerId, 9);
  assert.deepEqual(entry.raidFriendWatch, { 8: "bob" });
  assert.equal(calls, 3);
  assert.equal(saves, 1);
});

test("friend and outgoing lists classify only supplied leaders, including missing usernames", async () => {
  const fetcher = async (url) => ({
    ok: true,
    json: async () => ({
      items: url.includes("/outgoing?")
        ? [{ player: { playerId: 8, username: "bob" } }]
        : [
            { player: { playerId: 7, username: "alice" } },
            { player: { playerId: 9, username: null } },
          ],
      nextCursor: null,
    }),
  });
  assert.deepEqual(
    await checkRaidFriends({
      fetcher,
      credential: "test",
      targets: [
        { username: "Alice" },
        { username: "bob" },
        { username: "other" },
        { playerId: 10 },
      ],
    }),
    {
      "name:alice": "friend",
      "name:bob": "pending",
      "name:other": "unknown",
      "id:10": "none",
    },
  );
});

test("leader resolution requires one exact verified identity", () => {
  assert.throws(
    () =>
      resolveRaidLeader(
        { player: { playerId: 7, username: "alice" } },
        { playerId: 7, username: "bob" },
      ),
    /friend_leader_unverified/,
  );
  assert.equal(
    resolveRaidLeader(
      { player: { playerId: 7, username: "Alice" }, relationship: "friends" },
      { username: "@alice" },
    ),
    7,
  );
  assert.equal(
    resolveRaidLeader(
      { players: [{ playerId: 7, username: "Alice" }] },
      { username: "@alice" },
    ),
    7,
  );
  assert.throws(
    () =>
      resolveRaidLeader(
        {
          players: [
            { playerId: 7, username: "alice" },
            { playerId: 8, username: "Alice" },
          ],
        },
        { username: "alice" },
      ),
    /friend_leader_unverified/,
  );
  assert.throws(
    () =>
      resolveRaidLeader(
        { players: [{ playerId: 7, username: "alice2" }] },
        { username: "alice" },
      ),
    /friend_leader_unverified/,
  );
  assert.throws(
    () =>
      resolveRaidLeader(
        { player: { id: 7, username: "alice" } },
        { username: "alice" },
      ),
    /friend_leader_unverified/,
  );
});

test("uncertain friend request is persisted before POST and never replayed", async () => {
  const entry = { credential: "test", storageFailed: false };
  const saved = [];
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push([url, options.method ?? "GET"]);
    if (url.includes("/search?"))
      return {
        ok: true,
        json: async () => ({ players: [{ playerId: 7, username: "alice" }] }),
      };
    if (options.method === "POST") {
      assert.equal(saved.at(-1).pending.playerId, 7);
      throw new Error("lost response");
    }
    return { ok: true, json: async () => ({ items: [], nextCursor: null }) };
  };
  const save = () => saved.push(structuredClone(entry.raidFriend));
  await assert.rejects(
    requestRaidFriend({
      entry,
      args: { username: "alice" },
      commandId: "request-1",
      fetcher,
      save,
    }),
    /lost response/,
  );
  assert.equal(
    await reconcileRaidFriend({ entry, fetcher, save }),
    "uncertain",
  );
  await assert.rejects(
    requestRaidFriend({
      entry,
      args: { username: "alice" },
      commandId: "request-2",
      fetcher,
      save,
    }),
    /friend_request_uncertain/,
  );
  assert.equal(calls.filter(([, method]) => method === "POST").length, 1);
});

test("a previously submitted request is not sent again", async () => {
  const entry = { credential: "test" };
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(options.method ?? "GET");
    if (url.includes("/search?"))
      return {
        ok: true,
        json: async () => ({ players: [{ playerId: 7, username: "alice" }] }),
      };
    return {
      ok: true,
      json: async () => ({
        items: url.includes("/outgoing?") ? [{ player: { playerId: 7 } }] : [],
        nextCursor: null,
      }),
    };
  };
  assert.deepEqual(
    await requestRaidFriend({
      entry,
      args: { username: "alice" },
      commandId: "request-1",
      fetcher,
      save() {},
    }),
    { playerId: 7, status: "pending" },
  );
  assert.ok(!calls.includes("POST"));
});

test("successful request is confirmed from the outgoing list and retained", async () => {
  const entry = { credential: "test", storageFailed: false };
  let submitted = false;
  const fetcher = async (url, options) => {
    if (url.includes("/search?"))
      return {
        ok: true,
        json: async () => ({ players: [{ playerId: 7, username: "alice" }] }),
      };
    if (options.method === "POST") {
      assert.deepEqual(JSON.parse(options.body), { playerId: 7 });
      submitted = true;
      return { ok: true };
    }
    return {
      ok: true,
      json: async () => ({
        items:
          submitted && url.includes("/outgoing?")
            ? [{ player: { playerId: 7 } }]
            : [],
        nextCursor: null,
      }),
    };
  };
  const save = () => {};
  assert.deepEqual(
    await requestRaidFriend({
      entry,
      args: { username: "alice" },
      commandId: "request-1",
      fetcher,
      save,
    }),
    { playerId: 7, status: "pending" },
  );
  assert.deepEqual(entry.raidFriend, {
    pending: null,
    playerId: 7,
    username: "alice",
    status: "pending",
  });
});

test("an accepted request is observed from the friends list without a POST", async () => {
  const entry = {
    credential: "test",
    raidFriend: {
      pending: null,
      playerId: 7,
      username: "alice",
      status: "pending",
    },
  };
  const fetcher = async (url, options) => {
    assert.notEqual(options.method, "POST");
    return {
      ok: true,
      json: async () => ({
        items: url.includes("/api/friends?")
          ? [{ player: { playerId: 7, username: "alice" } }]
          : [],
        nextCursor: null,
      }),
    };
  };
  let saved = 0;
  assert.equal(
    await reconcileRaidFriend({
      entry,
      fetcher,
      save() {
        saved++;
      },
    }),
    "friend",
  );
  assert.equal(entry.raidFriend.status, "friend");
  assert.equal(saved, 1);
});

test("temporary absence from lists does not authorize a repeated request", async () => {
  const entry = {
    credential: "test",
    raidFriend: {
      pending: null,
      playerId: 7,
      username: "alice",
      status: "pending",
    },
    raidFriendWatch: { 7: "alice" },
    raidFriendStatuses: {},
  };
  const fetcher = async () => ({
    ok: true,
    json: async () => ({ items: [], nextCursor: null }),
  });
  await refreshWatchedRaidFriends({ entry, fetcher, save() {} });
  assert.equal(entry.raidFriend.status, "pending");
  assert.equal(entry.raidFriendStatuses["id:7"], "pending");
  assert.deepEqual(entry.raidFriendWatch, { 7: "alice" });
  let posts = 0;
  const searchFetcher = async (url, options) => {
    if (options.method === "POST") posts++;
    if (url.includes("/search?"))
      return {
        ok: true,
        json: async () => ({ player: { playerId: 7, username: "alice" } }),
      };
    return fetcher();
  };
  assert.equal(
    (
      await requestRaidFriend({
        entry,
        args: { username: "alice" },
        commandId: "request-2",
        fetcher: searchFetcher,
        save() {},
      })
    ).status,
    "pending",
  );
  assert.equal(posts, 0);
});

test("storage failure and rejected upstream response cannot cause replay", async () => {
  for (const storageFailure of [true, false]) {
    const entry = { credential: "test", storageFailed: false };
    let posts = 0;
    const fetcher = async (url, options) => {
      if (url.includes("/search?"))
        return {
          ok: true,
          json: async () => ({ player: { playerId: 7, username: "alice" } }),
        };
      if (options.method === "POST") {
        posts++;
        return { ok: false, status: 429 };
      }
      return { ok: true, json: async () => ({ items: [], nextCursor: null }) };
    };
    const save = () => {
      if (storageFailure) entry.storageFailed = true;
    };
    await assert.rejects(
      requestRaidFriend({
        entry,
        args: { username: "alice" },
        commandId: "request-1",
        fetcher,
        save,
      }),
    );
    assert.equal(posts, storageFailure ? 0 : 1);
    await assert.rejects(
      requestRaidFriend({
        entry,
        args: { username: "alice" },
        commandId: "request-2",
        fetcher,
        save,
      }),
      /friend_request_uncertain/,
    );
    assert.equal(posts, storageFailure ? 0 : 1);
  }
});

test("incomplete and cyclic paginated lists do not claim a leader is absent", async () => {
  for (const body of [{ items: [] }, { items: [], nextCursor: "same" }]) {
    const fetcher = async () => ({ ok: true, json: async () => body });
    await assert.rejects(
      checkRaidFriends({
        fetcher,
        credential: "test",
        targets: [{ playerId: 7 }],
      }),
      /friend_status_unavailable/,
    );
  }
});
