import test from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedBattleAttackAdapter } from "./queued-battle-attack.mjs";

function harness({ lost = false, offline = false } = {}) {
  let clock = 0,
    hits = 0,
    damage = 10,
    stored = [];
  const battle = () => ({
    id: "battle-1",
    status: "active",
    playerHealth: 100,
    playerMaxHealth: 100,
    bossHealth: 100,
    bossMaxHealth: 100,
    readyAt: 0,
    expiresAt: null,
    totalDamage: damage,
  });
  const current = {
    boss: { id: 7 },
    battle: battle(),
    needsRefresh: false,
    error: null,
    pending: null,
    medicineOpen: false,
  };
  const entry = {
    manualBattle: { pending: null, receipts: [] },
    queueBattleDispatch: null,
    controller: {
      getSnapshot: () => current,
      refresh: async () => {
        if (offline) {
          current.needsRefresh = true;
          current.error = "offline";
          return;
        }
        current.battle = battle();
        current.needsRefresh = false;
        current.error = null;
      },
      attack: async ({ beforeSend }) => {
        if (!beforeSend({ operationId: "attack-op-1" })) return;
        assert.ok(entry.manualBattle.pending);
        hits++;
        damage += 5;
        if (lost) {
          current.needsRefresh = true;
          current.error = "lost";
          return;
        }
        current.battle = battle();
        return { confirmed: true };
      },
    },
  };
  const make = (saved = []) =>
    createActionQueue({
      saved,
      now: () => clock,
      random: () => 0,
      persist: (value) => {
        stored = value;
      },
      adapters: {
        "battle.attack": queuedBattleAttackAdapter({
          entry,
          save: () => {},
          now: () => clock,
        }),
      },
    });
  return {
    entry,
    current,
    make,
    state: () => stored,
    hits: () => hits,
    advance: (ms) => {
      clock += ms;
    },
    online: () => {
      offline = false;
    },
  };
}
const add = (queue) =>
  queue.add({
    id: "attack-job-1",
    type: "battle.attack",
    args: { bossId: 7, battleId: "battle-1" },
  });

test("attack classifies rejected preflight without submitting a strike", async () => {
  for (const [status, expected] of [
    [401, "failed"],
    [403, "failed"],
    [400, "failed"],
    [429, "waiting"],
    [503, "waiting"],
  ]) {
    const h = harness();
    h.entry.controller.refresh = async () => {
      Object.assign(h.current, {
        error: "unavailable",
        errorStatus: status,
        needsRefresh: true,
      });
    };
    const queue = h.make();
    add(queue);
    await queue.tick();
    assert.equal(h.state()[0].status, expected);
    assert.equal(h.hits(), 0);
  }
});

test("attack preflight honors Retry-After without submitting", async () => {
  const h = harness();
  h.entry.controller.refresh = async () =>
    Object.assign(h.current, {
      error: "limited",
      errorStatus: 429,
      errorRetryAfterMs: 120000,
      needsRefresh: true,
    });
  const queue = h.make();
  add(queue);
  await queue.tick();
  assert.equal(h.state()[0].nextAt, 120000);
  assert.equal(h.hits(), 0);
});

test("attack reconciliation honors Retry-After without resending", async () => {
  const h = harness({ lost: true });
  const queue = h.make();
  add(queue);
  await queue.tick();
  h.advance(10000);
  h.entry.controller.refresh = async () =>
    Object.assign(h.current, {
      error: "limited",
      errorStatus: 429,
      errorRetryAfterMs: 120000,
      needsRefresh: true,
    });
  await queue.tick();
  assert.equal(h.state()[0].status, "reconciling");
  assert.equal(h.state()[0].nextAt, 130000);
  assert.equal(h.hits(), 1);
});

test("manual strike waits for a fresh read and executes once", async () => {
  const h = harness({ offline: true }),
    queue = h.make();
  add(queue);
  await queue.tick();
  assert.equal(h.state()[0].status, "waiting");
  assert.equal(h.hits(), 0);
  h.online();
  h.advance(10000);
  await queue.tick();
  assert.equal(h.state()[0].status, "completed");
  assert.equal(h.hits(), 1);
  assert.ok(h.entry.manualBattle.receipts.includes("attack-job-1"));
});

test("lost attack response remains unresolved after restart without another strike", async () => {
  const h = harness({ lost: true });
  let queue = h.make();
  add(queue);
  await queue.tick();
  assert.equal(h.state()[0].status, "reconciling");
  assert.equal(h.hits(), 1);
  queue = h.make(h.state());
  h.advance(10000);
  await queue.tick();
  assert.equal(h.state()[0].status, "reconciling");
  assert.equal(h.hits(), 1);
  assert.equal(h.entry.manualBattle.receipts.length, 0);
});

test("no confirmed damage increase keeps an uncertain strike pending", async () => {
  const h = harness();
  h.entry.manualBattle.pending = {
    id: "attack-job-1",
    kind: "attack",
    bossId: 7,
    battleId: "battle-1",
    beforeDamage: 10,
    operationId: "attack-op-1",
  };
  const queue = h.make([
    {
      id: "attack-job-1",
      type: "battle.attack",
      args: { bossId: 7, battleId: "battle-1" },
      status: "running",
      attempts: 0,
      priority: 30,
      createdAt: 0,
    },
  ]);
  await queue.tick();
  assert.equal(h.state()[0].status, "reconciling");
  assert.equal(h.hits(), 0);
});

test("a queued strike never moves to a different battle", async () => {
  const h = harness();
  h.current.battle.id = "battle-2";
  const queue = h.make();
  add(queue);
  await queue.tick();
  assert.equal(h.state()[0].status, "failed");
  assert.equal(h.hits(), 0);
});
