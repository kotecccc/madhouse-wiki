import test from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedBattleStartAdapter } from "./queued-battle-start.mjs";

function harness({ offline = false, lost = false } = {}) {
  let time = 0,
    posts = 0,
    liveBattle = null,
    stored = [];
  const current = {
    boss: { id: 7 },
    canStart: true,
    needsRefresh: false,
    error: null,
    battle: null,
  };
  const entry = {
    manualBattle: { pending: null, receipts: [] },
    queueBattleDispatch: null,
    controller: {
      getSnapshot: () => current,
      refresh: async () => {
        if (offline) {
          current.error = "offline";
          current.needsRefresh = true;
          return;
        }
        current.error = null;
        current.needsRefresh = false;
        current.battle = liveBattle;
        current.canStart = !liveBattle;
      },
      start: async ({ beforeSend }) => {
        if (!beforeSend({ operationId: "game-op-1" })) return;
        assert.ok(entry.manualBattle.pending);
        posts++;
        liveBattle = { id: "battle-1", status: "active" };
        if (lost) {
          current.error = "lost";
          current.needsRefresh = true;
          return;
        }
        current.battle = liveBattle;
        current.needsRefresh = false;
      },
    },
  };
  const create = (saved = []) =>
    createActionQueue({
      saved,
      now: () => time,
      random: () => 0,
      persist: (value) => {
        stored = value;
      },
      adapters: {
        "battle.start": queuedBattleStartAdapter({
          entry,
          getBoss: () => ({ numericId: 7 }),
          save: () => {},
        }),
      },
    });
  return {
    entry,
    create,
    state: () => stored,
    posts: () => posts,
    advance: (ms) => {
      time += ms;
    },
    online: () => {
      offline = false;
    },
  };
}
function add(queue) {
  queue.add({
    id: "battle-start-1",
    type: "battle.start",
    args: { bossId: 7 },
  });
}

test("start classifies rejected preflight without submitting a battle", async () => {
  for (const [status, expected] of [
    [401, "failed"],
    [403, "failed"],
    [400, "failed"],
    [429, "waiting"],
    [503, "waiting"],
  ]) {
    const h = harness();
    h.entry.controller.refresh = async () => {
      Object.assign(h.entry.controller.getSnapshot(), {
        error: "unavailable",
        errorStatus: status,
        needsRefresh: true,
      });
    };
    const queue = h.create();
    add(queue);
    await queue.tick();
    assert.equal(h.state()[0].status, expected);
    assert.equal(h.posts(), 0);
  }
});

test("battle start waits for a fresh preflight and submits once after recovery", async () => {
  const h = harness({ offline: true }),
    queue = h.create();
  add(queue);
  await queue.tick();
  assert.equal(h.state()[0].status, "waiting");
  assert.equal(h.posts(), 0);
  h.online();
  h.advance(10000);
  await queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.posts(), 1);
  assert.deepEqual(h.entry.manualBattle.receipts, ["battle-start-1"]);
});

test("lost start response is reconciled after restart without another POST", async () => {
  const h = harness({ lost: true });
  let queue = h.create();
  add(queue);
  await queue.tick();
  assert.equal(h.state()[0].status, "reconciling");
  assert.equal(h.posts(), 1);
  queue = h.create(h.state());
  h.advance(10000);
  await queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.posts(), 1);
  assert.equal(h.entry.manualBattle.pending, null);
});

test("unconfirmed start is not repeated when the game still reports no battle", async () => {
  const h = harness();
  h.entry.manualBattle.pending = {
    id: "battle-start-1",
    bossId: 7,
    beforeBattleId: null,
    operationId: "game-op-1",
  };
  const queue = h.create([
    {
      id: "battle-start-1",
      type: "battle.start",
      args: { bossId: 7 },
      status: "running",
      attempts: 0,
      createdAt: 0,
      priority: 30,
    },
  ]);
  await queue.tick();
  assert.equal(h.state()[0].status, "reconciling");
  assert.equal(h.posts(), 0);
});

test("cancelling while preflight is in flight prevents the start", async () => {
  const h = harness();
  let release;
  h.entry.controller.refresh = async () => {
    await new Promise((resolve) => {
      release = resolve;
    });
  };
  const queue = h.create();
  add(queue);
  const attempt = queue.tick();
  while (!release) await Promise.resolve();
  queue.stop("battle-start-1");
  release();
  await attempt;
  assert.equal(h.state()[0].status, "cancelled");
  assert.equal(h.posts(), 0);
  assert.equal(h.entry.manualBattle.pending, null);
});
