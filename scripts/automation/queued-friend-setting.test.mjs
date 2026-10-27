import { test } from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedFriendSettingAdapter } from "./queued-friend-setting.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationStateStore } from "./state-store.mjs";
import { createAutomationService } from "./service.mjs";

test("favorite waits through an outage and survives queue restart", async () => {
  let online = false;
  let time = 0;
  let stored;
  const entry = {
    credential: "Bearer fake",
    preferences: { favoriteFriendIds: [] },
  };
  const adapter = queuedFriendSettingAdapter({
    entry,
    kind: "favorite",
    save: () => {},
    fetcher: async () => {
      if (!online) throw new Error("offline");
      return Response.json({
        items: [{ player: { playerId: 7 } }],
        nextCursor: null,
      });
    },
  });
  const makeQueue = (saved = []) =>
    createActionQueue({
      saved,
      adapters: { "friend.favorite": adapter },
      now: () => time,
      random: () => 0,
      persist: (items) => {
        stored = items;
      },
    });
  let queue = makeQueue();
  queue.add({
    id: "favorite-0001",
    type: "friend.favorite",
    args: { playerId: 7, enabled: true },
  });
  await queue.tick();
  assert.equal(stored[0].status, "waiting");
  assert.deepEqual(entry.preferences.favoriteFriendIds, []);
  queue = makeQueue(stored);
  online = true;
  time += 10000;
  await queue.tick();
  assert.equal(stored[0].status, "completed");
  assert.deepEqual(entry.preferences.favoriteFriendIds, [7]);
});

test("service persists queued friend settings without contacting the game", async () => {
  const directory = mkdtempSync(join(tmpdir(), "friend-setting-"));
  const service = createAutomationService({
    store: createAutomationStateStore({ directory }),
    fetcher: async () => {
      throw new Error("offline");
    },
    identifyPlayer: async () => ({ playerId: 17 }),
    getBoss: (id) => ({ numericId: id }),
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    const result = await service.command(entry, {
      id: "favorite-0001",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.enqueue",
      args: { type: "friend.favorite", action: { playerId: 7, enabled: true } },
    });
    assert.equal(result.queuedActions[0].type, "friend.favorite");
    assert.equal(result.queuedActions[0].status, "queued");
    assert.deepEqual(result.preferences.favoriteFriendIds ?? [], []);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a cached old session cannot use a replacement credential", async () => {
  const directory = mkdtempSync(join(tmpdir(), "session-rotation-"));
  let revokeOld = false;
  const service = createAutomationService({
    store: createAutomationStateStore({ directory }),
    fetcher: async () => {
      throw new Error("offline");
    },
    identifyPlayer: async (credential) => {
      if (credential === "Bearer old" && revokeOld)
        throw Object.assign(new Error("revoked"), { status: 401 });
      return { playerId: 17 };
    },
    getBoss: (id) => ({ numericId: id }),
  });
  try {
    await service.identify("Bearer old");
    const entry = await service.identify("Bearer new");
    revokeOld = true;
    await assert.rejects(service.identify("Bearer old"), /revoked/);
    assert.equal(entry.credential, "Bearer new");
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
