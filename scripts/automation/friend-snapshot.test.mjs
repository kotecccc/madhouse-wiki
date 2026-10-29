import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFriendSnapshot } from "./friend-snapshot.mjs";
import { createAutomationService } from "./service.mjs";
import { createAutomationStateStore } from "./state-store.mjs";

const row = (playerId, nickname) => ({
  player: {
    playerId,
    nickname,
    username: `user${playerId}`,
    stats: { madness: 3 },
    token: "secret",
  },
});
test("friend snapshots require a complete bounded traversal and strip unrelated fields", async () => {
  let reads = 0;
  const fetcher = async (url) => {
    reads++;
    const cursor = new URL(url).searchParams.get("cursor");
    return Response.json(
      cursor
        ? { items: [row(2, "Bob")], nextCursor: null }
        : { items: [row(1, "Alice")], nextCursor: "next" },
    );
  };
  const items = await readFriendSnapshot({
    fetcher,
    credential: "Bearer fake",
  });
  assert.deepEqual(
    items.map((item) => item.playerId),
    [1, 2],
  );
  assert.equal(reads, 2);
  assert.equal("token" in items[0], false);
  await assert.rejects(
    readFriendSnapshot({
      credential: "Bearer fake",
      fetcher: async () =>
        Response.json({ items: [row(1, "Alice")], nextCursor: "same" }),
    }),
    /friends_incomplete/,
  );
});

test("a previously enabled friend snapshot does not refresh in the background", async () => {
  const directory = mkdtempSync(join(tmpdir(), "friend-no-background-"));
  const store = createAutomationStateStore({ directory });
  let friendReads = 0;
  const service = createAutomationService({
    store,
    identifyPlayer: async () => ({ playerId: 1 }),
    getBoss: () => null,
    fetcher: async (url) => {
      const path = new URL(url).pathname;
      if (path === "/api/friends") {
        friendReads++;
        return Response.json({ items: [row(2, "Bob")], nextCursor: null });
      }
      if (path === "/api/bosses/invitations")
        return Response.json({ items: [] });
      if (path === "/api/combat") return Response.json({ activeBattle: null });
      return Response.json({ playerId: 1 });
    },
  });
  try {
    const entry = await service.identify("Bearer account-a");
    entry.friendSnapshot.enabled = true;
    entry.friendSnapshot.nextAt = 0;
    await service.boot();
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.equal(friendReads, 0);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
