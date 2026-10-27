import test from "node:test";
import assert from "node:assert/strict";
import { combineRaids, raidFriendKey, raidFriendTarget } from "./raid-list.js";

test("friend actions only target verified ids or explicit Telegram handles", () => {
  assert.deepEqual(raidFriendTarget({ leader: "@Alice" }, null), {
    username: "Alice",
  });
  assert.equal(raidFriendKey({ username: "Alice" }), "name:alice");
  assert.equal(raidFriendTarget({ leader: "Nickname" }, null), null);
  assert.deepEqual(
    raidFriendTarget({ leader: "Nickname" }, { leaderPlayerId: 42 }),
    { playerId: 42, username: "" },
  );
});

test("combines verified game invitations with the matching public raid", () => {
  const feed = [{ boss: "Белорогая", leader: "@alice", time: "12:00" }];
  const candidate = {
    bossName: "Белорогая",
    leaderUsername: "alice",
    leaderPlayerId: 42,
    bossId: 7,
  };
  const rows = combineRaids(feed, [candidate], null);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].candidate.leaderPlayerId, 42);
});

test("does not infer identity from a nickname and retains a waiting subscription", () => {
  const feed = [{ boss: "Белорогая", leader: "@alice" }];
  const candidate = {
    bossName: "Белорогая",
    sender: "alice",
    leaderPlayerId: 42,
    bossId: 7,
  };
  assert.equal(combineRaids(feed, [candidate], null).length, 2);
  const subscription = {
    enabled: true,
    leaderPlayerId: 42,
    bossId: 7,
    bossName: "Белорогая",
    leaderName: "Alice",
  };
  assert.equal(
    combineRaids([], [], subscription)[0].candidate.leaderPlayerId,
    42,
  );
});

test("a public raid can be selected when its boss and handle are unambiguous", () => {
  const bosses = [{ numericId: 7, name: "Белорогая" }];
  const raid = { boss: "Белорогая", leader: "@alice" };
  const [row] = combineRaids([raid], [], null, bosses);
  assert.deepEqual(row.candidate, {
    leaderPlayerId: null,
    leaderUsername: "alice",
    bossId: 7,
    bossName: "Белорогая",
  });
  assert.equal(
    combineRaids([raid], [], null, [
      ...bosses,
      { numericId: 8, name: "Белорогая" },
    ])[0].candidate,
    null,
  );
});
