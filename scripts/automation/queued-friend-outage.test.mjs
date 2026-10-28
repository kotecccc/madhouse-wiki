import test from "node:test";
import assert from "node:assert/strict";
import { queuedFriendRemovalAdapter } from "./queued-friend-removal.mjs";
import { queuedFriendRequestAdapter } from "./queued-friend-request.mjs";

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
