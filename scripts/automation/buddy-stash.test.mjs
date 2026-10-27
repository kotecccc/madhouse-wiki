import test from "node:test";
import assert from "node:assert/strict";
import { tickBuddyStash } from "./buddy-stash.mjs";
function setup({ owned = 2, success = true } = {}) {
  const state = {
    stashEnabled: true,
    stashReserve: 1,
    stashPending: null,
    stashCompleted: [],
    log: [],
  };
  const entry = {
    credential: "Bearer fake",
    buddyHelp: state,
    raidSubscription: {
      getSnapshot: () => ({ enabled: true, mode: "buddy", friendIds: [7] }),
    },
  };
  const saved = [],
    posts = [];
  const fetcher = async (url, init = {}) => {
    if (init.method === "POST") {
      posts.push({
        body: JSON.parse(init.body),
        saved: structuredClone(saved.at(-1)),
      });
      return Response.json({ success });
    }
    if (url.includes("/api/friends?"))
      return Response.json({
        items: [{ player: { playerId: 7 } }],
        nextCursor: null,
      });
    if (url.endsWith("/api/stash/help-requests/7"))
      return Response.json({
        items: [{ setId: 1, ingredientId: 2, ownedByMe: owned, canSend: true }],
        remainingToday: 2,
      });
    throw new Error("unexpected");
  };
  return {
    entry,
    state,
    fetcher,
    save: () => saved.push(structuredClone(state)),
    now: () => 1000,
    allowed: () => true,
    posts,
  };
}
test("gift is checkpointed and one item above reserve is sent once", async () => {
  const h = setup();
  await tickBuddyStash(h);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].saved.stashPending.ingredientId, 2);
  assert.deepEqual(h.posts[0].body.items, [{ setId: 1, ingredientId: 2 }]);
  await tickBuddyStash(h);
  assert.equal(h.posts.length, 1);
});
test("stash reserve and uncertain results prevent repeated gifts", async () => {
  const reserved = setup({ owned: 1 });
  await tickBuddyStash(reserved);
  assert.equal(reserved.posts.length, 0);
  const h = setup({ success: false });
  await assert.rejects(tickBuddyStash(h));
  await tickBuddyStash(h);
  assert.equal(h.posts.length, 1);
  assert.equal(h.state.stashPending.playerId, 7);
});

test("a missing request cannot prove an uncertain gift succeeded or authorize replay", async () => {
  const h = setup();
  h.state.stashPending = {
    playerId: 7,
    setId: 1,
    ingredientId: 2,
    operationId: "uncertain",
  };
  h.fetcher = async () => Response.json({ items: [], remainingToday: 2 });
  await tickBuddyStash(h);
  assert.equal(h.state.stashPending.operationId, "uncertain");
  assert.equal(h.posts.length, 0);
});
