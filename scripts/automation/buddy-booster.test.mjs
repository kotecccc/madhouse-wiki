import test from "node:test";
import assert from "node:assert/strict";
import { tickBuddyBooster } from "./buddy-booster.mjs";
const now = () => 1000000;
const expiresAtUtc = new Date(1100000).toISOString();
function setup({ count = 2, success = true } = {}) {
  const state = {
    boostersEnabled: true,
    fullBoosterReserve: 1,
    pending: null,
    log: [],
  };
  const entry = {
    credential: "Bearer fake",
    buddyHelp: state,
    raidSubscription: {
      getSnapshot: () => ({ mode: "buddy", enabled: true, friendIds: [7] }),
    },
  };
  const saves = [];
  const posts = [];
  const fetcher = async (url, init = {}) => {
    if (init.method === "POST") {
      posts.push({
        url,
        body: JSON.parse(init.body),
        saved: structuredClone(saves.at(-1)),
      });
      return Response.json({ success });
    }
    if (url.includes("booster-requests/incoming"))
      return Response.json({
        items: [
          { requestId: "req-1", playerId: 7, status: "pending", expiresAtUtc },
        ],
        nextCursor: null,
      });
    if (url.includes("/api/friends?"))
      return Response.json({
        items: [{ player: { playerId: 7 } }],
        nextCursor: null,
      });
    if (url.endsWith("/api/me/bag"))
      return Response.json({ boosters: { full: { count } } });
    throw new Error("unexpected");
  };
  return {
    entry,
    fetcher,
    save: () => saves.push(structuredClone(state)),
    now,
    allowed: () => true,
    posts,
    state,
  };
}
test("saves intent before sending one full booster above reserve", async () => {
  const h = setup();
  await tickBuddyBooster(h);
  assert.equal(h.posts.length, 1);
  assert.equal(h.posts[0].saved.pending.requestId, "req-1");
  assert.equal(
    h.posts[0].body.operationId,
    h.posts[0].saved.pending.operationId,
  );
  assert.equal(h.state.pending, null);
  assert.equal(h.state.log[0].result, "confirmed");
});
test("reserve is respected and missing success never triggers a replay", async () => {
  const reserved = setup({ count: 1 });
  await tickBuddyBooster(reserved);
  assert.equal(reserved.posts.length, 0);
  const h = setup({ success: false });
  await assert.rejects(tickBuddyBooster(h));
  await tickBuddyBooster(h);
  assert.equal(h.posts.length, 1);
  assert.equal(h.state.pending.requestId, "req-1");
});

test("a completed request cannot be sent twice while the game still lists it pending", async () => {
  const h = setup();
  await tickBuddyBooster(h);
  await tickBuddyBooster(h);
  assert.equal(h.posts.length, 1);
});
