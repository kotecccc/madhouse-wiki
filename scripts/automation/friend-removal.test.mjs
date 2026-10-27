import test from "node:test";
import assert from "node:assert/strict";
import { removeFriend, reconcileFriendRemoval } from "./friend-removal.mjs";

function harness() {
  const entry = {
    credential: "Bearer token",
    preferences: { favoriteFriendIds: [7] },
    friendRemoval: { pending: null },
  };
  let present = true;
  let failDelete = false;
  let deletes = 0;
  const saved = [];
  const save = () => saved.push(structuredClone(entry.friendRemoval));
  const fetcher = async (url, init = {}) => {
    if (init.method === "DELETE") {
      deletes++;
      assert.equal(saved.at(-1).pending.playerId, 7);
      if (failDelete) throw new Error("network");
      present = false;
      return new Response(null, { status: 204 });
    }
    return Response.json({
      items:
        url.includes("/api/friends?") && present
          ? [{ player: { playerId: 7 } }]
          : [],
      nextCursor: null,
    });
  };
  return {
    entry,
    fetcher,
    save,
    setFailure: () => {
      failDelete = true;
    },
    getDeletes: () => deletes,
  };
}
test("records intent before deletion and clears only after confirmed friend list", async () => {
  const h = harness();
  assert.equal(
    await removeFriend({
      ...h,
      playerId: 7,
      commandId: "command-1",
      allowed: () => true,
    }),
    "removed",
  );
  assert.equal(h.entry.friendRemoval.pending, null);
  assert.deepEqual(h.entry.preferences.favoriteFriendIds, []);
});
test("an uncertain deletion cannot replay and reconciliation only reads", async () => {
  const h = harness();
  h.setFailure();
  await assert.rejects(
    removeFriend({
      ...h,
      playerId: 7,
      commandId: "command-1",
      allowed: () => true,
    }),
  );
  await assert.rejects(
    removeFriend({
      ...h,
      playerId: 7,
      commandId: "command-2",
      allowed: () => true,
    }),
  );
  assert.equal(await reconcileFriendRemoval(h), "uncertain");
  assert.equal(h.getDeletes(), 1);
  assert.equal(h.entry.friendRemoval.pending.playerId, 7);
});
