import test from "node:test";
import assert from "node:assert/strict";
import { queuedFriendRemovalAdapter } from "./queued-friend-removal.mjs";
import { queuedFriendRequestAdapter } from "./queued-friend-request.mjs";
import { queuedFriendSettingAdapter } from "./queued-friend-setting.mjs";

for (const type of ["remove", "request", "favorite", "buddy"])
  test(`${type} stops on a permanent read rejection before changing state`, async () => {
    const entry = {
      credential: "Bearer fake",
      friendRemoval: { pending: null },
      raidFriend: { pending: null },
      raidFriendWatch: {},
      raidFriendReceipts: [],
      raidFriendStatuses: {},
      preferences: { favoriteFriendIds: [] },
    };
    let calls = 0;
    const options = {
      entry,
      save: () => {
        throw new Error("must not save");
      },
      fetcher: async (_url, init = {}) => {
        calls++;
        assert.ok(!init.method || init.method === "GET");
        return new Response(null, { status: 400 });
      },
    };
    const adapter =
      type === "remove"
        ? queuedFriendRemovalAdapter(options)
        : type === "request"
          ? queuedFriendRequestAdapter(options)
          : queuedFriendSettingAdapter({ ...options, kind: type });
    const result = await adapter.execute(
      {
        id: "friend-rejected",
        args: { playerId: 7, username: "alice", enabled: true },
      },
      { canDispatch: () => true },
    );
    assert.deepEqual(result, {
      status: "failed",
      reason: "game_request_rejected",
    });
    assert.equal(calls, 1);
    assert.equal(entry.friendRemoval.pending, null);
    assert.equal(entry.raidFriend.pending, null);
  });

for (const type of ["remove", "request"]) {
  test(`${type} preserves outage deadline and rejects an expired session`, async () => {
    const entry = {
      credential: "Bearer fake",
      friendRemoval: { pending: null },
      raidFriend: { pending: null },
      raidFriendWatch: {},
      raidFriendReceipts: [],
      raidFriendStatuses: {},
    };
    let error = Object.assign(new Error("wait"), {
      notDispatched: true,
      retryAfterMs: 120000,
    });
    const options = {
      entry,
      save: () => {},
      fetcher: async () => {
        throw error;
      },
    };
    const adapter =
      type === "remove"
        ? queuedFriendRemovalAdapter(options)
        : queuedFriendRequestAdapter(options);
    const job = {
      id: "friend-outage",
      args: { playerId: 7, username: "alice" },
    };
    const context = { canDispatch: () => true };
    assert.deepEqual(await adapter.execute(job, context), {
      status: "retry",
      reason: "Ожидаем игру.",
      retryAfterMs: 120000,
    });
    error = Object.assign(new Error("expired"), {
      status: 401,
      notDispatched: true,
    });
    assert.deepEqual(await adapter.execute(job, context), {
      status: "failed",
      reason: "game_session_required",
    });
    assert.equal(entry.friendRemoval.pending, null);
    assert.equal(entry.raidFriend.pending, null);
  });
}
