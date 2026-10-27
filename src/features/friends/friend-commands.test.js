import test from "node:test";
import assert from "node:assert/strict";
import { sendFriendCommand } from "./friend-commands.js";
test("friend commands stop before mutation when the signed-in session changes", async () => {
  let session = "first";
  let writes = 0;
  await assert.rejects(
    sendFriendCommand({
      get: async () => {
        session = "second";
        return { version: 1 };
      },
      post: async () => {
        writes++;
      },
      identity: () => session,
      command: "friends.remove",
      args: { playerId: 7 },
    }),
    /session_changed/,
  );
  assert.equal(writes, 0);
});
test("friend commands use a fresh version and compute intent from the same state", async () => {
  const calls = [];
  const result = await sendFriendCommand({
    get: async () => ({ version: 12, buddy: { friendIds: [7] } }),
    post: async (path, body) => {
      calls.push({ path, body });
      return path.endsWith("command-ticket")
        ? { id: "server-command", ticket: "signed-ticket", intentVersion: 13 }
        : body;
    },
    identity: () => "same",
    command: "buddy.set",
    args: (state) => ({
      playerId: 7,
      enabled: !state.buddy.friendIds.includes(7),
    }),
  });
  assert.equal(calls[0].body.expectedVersion, 12);
  assert.equal(result.expectedVersion, 13);
  assert.equal(result.id, "server-command");
  assert.equal(result.admissionTicket, "signed-ticket");
  assert.deepEqual(result.args, { playerId: 7, enabled: false });
});

test("friend commands stop after admission if the session changes", async () => {
  let session = "first";
  const paths = [];
  await assert.rejects(
    sendFriendCommand({
      get: async () => ({ version: 1 }),
      post: async (path) => {
        paths.push(path);
        session = "second";
        return {
          id: "server-command",
          ticket: "signed-ticket",
          intentVersion: 2,
        };
      },
      identity: () => session,
      command: "friends.remove",
      args: { playerId: 7 },
    }),
    /session_changed/,
  );
  assert.deepEqual(paths, ["/api/automation/command-ticket"]);
});
