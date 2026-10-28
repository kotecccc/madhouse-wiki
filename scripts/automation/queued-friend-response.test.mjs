import { test } from "node:test";
import { strict as assert } from "node:assert";
import { queuedFriendResponseAdapter } from "./queued-friend-response.mjs";

function setup(decision, { lost = false } = {}) {
  let incoming = true,
    friend = false,
    posts = 0;
  const entry = { credential: "fake", friendSnapshot: { nextAt: 123 } };
  const fetcher = async (url, options = {}) => {
    const path = new URL(url).pathname;
    if (options.method === "POST" || options.method === "DELETE") {
      posts++;
      incoming = false;
      friend = decision === "accept";
      if (lost) throw new Error("timeout");
      return Response.json({ success: true });
    }
    const present =
      path === "/api/friends"
        ? friend
        : path === "/api/friends/requests/incoming"
          ? incoming
          : false;
    return Response.json({
      items: present ? [{ player: { playerId: 42 } }] : [],
      nextCursor: null,
    });
  };
  const adapter = queuedFriendResponseAdapter({
    entry,
    fetcher,
    save: () => {},
  });
  const job = {
    id: "request-test",
    args: adapter.validate({ playerId: 42, decision }),
  };
  return { adapter, job, posts: () => posts, entry };
}
for (const decision of ["accept", "decline"]) {
  test(`${decision} submits one request and confirms from fresh lists`, async () => {
    const h = setup(decision);
    assert.equal(
      (await h.adapter.execute(h.job, { canDispatch: () => true })).status,
      "completed",
    );
    assert.equal(h.posts(), 1);
    assert.equal(h.entry.friendSnapshot.nextAt, 0);
  });
  test(`${decision} reconciles a lost response without replay`, async () => {
    const h = setup(decision, { lost: true });
    assert.equal(
      (await h.adapter.execute(h.job, { canDispatch: () => true })).status,
      "completed",
    );
    assert.equal((await h.adapter.reconcile(h.job)).status, "completed");
    assert.equal(h.posts(), 1);
  });
}

test("an unconfirmed dispatched response remains uncertain without replay", async () => {
  let posts = 0;
  const entry = { credential: "fake", friendSnapshot: { nextAt: 10 } };
  const fetcher = async (url, options = {}) => {
    if (options.method === "POST") {
      posts++;
      throw new Error("timeout");
    }
    return Response.json({
      items: new URL(url).pathname.endsWith("/incoming")
        ? [{ player: { playerId: 42 } }]
        : [],
      nextCursor: null,
    });
  };
  const adapter = queuedFriendResponseAdapter({
    entry,
    fetcher,
    save: () => {},
  });
  const job = {
    id: "request-test",
    args: adapter.validate({ playerId: 42, decision: "accept" }),
  };
  assert.equal(
    (await adapter.execute(job, { canDispatch: () => true })).status,
    "uncertain",
  );
  assert.equal((await adapter.reconcile(job)).status, "uncertain");
  assert.equal(posts, 1);
});
