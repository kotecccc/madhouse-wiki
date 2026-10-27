import test from "node:test";
import assert from "node:assert/strict";
import { sendFriendCommand } from "./friend-commands.js";
test("friend commands stop before mutation when the signed-in session changes", async () => {
  let credential = "first";
  let writes = 0;
  await assert.rejects(
    sendFriendCommand({
      get: async () => {
        credential = "second";
        return { version: 1 };
      },
      post: async () => {
        writes++;
      },
      authorize: () => credential,
      makeId: () => "command-1",
      command: "friends.remove",
      args: { playerId: 7 },
    }),
    /session_changed/,
  );
  assert.equal(writes, 0);
});
test("friend commands use a fresh version and compute intent from the same state", async () => {
  const result = await sendFriendCommand({
    get: async () => ({ version: 12, buddy: { friendIds: [7] } }),
    post: async (_path, body) => body,
    authorize: () => "same",
    makeId: () => "command-1",
    command: "buddy.set",
    args: (state) => ({
      playerId: 7,
      enabled: !state.buddy.friendIds.includes(7),
    }),
  });
  assert.equal(result.expectedVersion, 12);
  assert.deepEqual(result.args, { playerId: 7, enabled: false });
});
