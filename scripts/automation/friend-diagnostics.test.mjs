import test from "node:test";
import assert from "node:assert/strict";
import {
  annotateFriendError,
  friendDiagnostic,
} from "./friend-diagnostics.mjs";
import { readFriendSnapshot } from "./friend-snapshot.mjs";
import { checkRaidFriends } from "./raid-friends.mjs";

test("diagnostics never expose arbitrary error text or identity", () => {
  const error = Object.assign(new Error("Bearer secret username"), {
    status: 429,
    friendDiagnosticStage: "private",
  });
  assert.deepEqual(friendDiagnostic("secret operation", error), {
    operation: "other",
    stage: "command",
    reason: "other",
    status: 429,
  });
  assert.equal(annotateFriendError(error, "friends"), error);
  assert.equal(friendDiagnostic("raid.friend.check", error).stage, "friends");
});

test("snapshot HTTP failure records safe stage and status", async () => {
  await assert.rejects(
    readFriendSnapshot({
      credential: "Bearer secret",
      fetcher: async () => new Response(null, { status: 429 }),
    }),
    (error) => {
      assert.deepEqual(friendDiagnostic("snapshot.refresh", error), {
        operation: "snapshot.refresh",
        stage: "snapshot",
        reason: "friends_unavailable",
        status: 429,
      });
      return true;
    },
  );
});

test("raid check identifies failing list without exposing its response", async () => {
  let calls = 0;
  await assert.rejects(
    checkRaidFriends({
      credential: "Bearer secret",
      targets: [],
      fetcher: async () =>
        ++calls === 1
          ? Response.json({ items: [], nextCursor: null })
          : new Response("private", { status: 403 }),
    }),
    (error) => {
      assert.deepEqual(friendDiagnostic("raid.friend.check", error), {
        operation: "raid.friend.check",
        stage: "outgoing",
        reason: "friend_status_unavailable",
        status: 403,
      });
      return true;
    },
  );
});
