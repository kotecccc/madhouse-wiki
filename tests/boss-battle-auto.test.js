import test from "node:test";
import assert from "node:assert/strict";
import { createBossBattleAutoAttack } from "../src/features/bosses/BossBattle/boss-battle-auto.js";

function fixture({ randomValue = 0, readyAt = 0 } = {}) {
  let time = 100_000;
  let id = 0;
  const timers = new Map();
  let state = {
    visible: true,
    battle: {
      id: "fight-1",
      status: "active",
      readyAt,
      expiresAt: 500_000,
      playerHealth: 100,
      playerMaxHealth: 100,
      bossHealth: 100,
      bossMaxHealth: 100,
      cooldownKnown: true,
    },
    pending: null,
    needsRefresh: false,
    medicineOpen: false,
    purchase: null,
    purchaseUncertain: false,
    error: null,
  };
  const listeners = new Set();
  let attackCount = 0;
  let resolveAttack;
  const controller = {
    getSnapshot: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    update(patch) {
      state = { ...state, ...patch };
      for (const fn of listeners) fn();
    },
    attack() {
      attackCount++;
      state = { ...state, pending: "attack", needsRefresh: true };
      for (const fn of listeners) fn();
      return new Promise((resolve) => {
        resolveAttack = () => {
          state = {
            ...state,
            pending: null,
            needsRefresh: false,
            battle: {
              ...state.battle,
              bossHealth: Math.max(0, state.battle.bossHealth - 1),
              readyAt: time,
            },
          };
          for (const fn of listeners) fn();
          resolve();
        };
      });
    },
  };
  const auto = createBossBattleAutoAttack({
    controller,
    now: () => time,
    random: () => randomValue,
    schedule(fn, ms) {
      const key = ++id;
      timers.set(key, { fn, at: time + ms });
      return key;
    },
    cancel(key) {
      timers.delete(key);
    },
  });
  function advance(ms) {
    time += ms;
    let due;
    while ((due = [...timers].find(([, timer]) => timer.at <= time))) {
      timers.delete(due[0]);
      due[1].fn();
    }
  }
  return {
    auto,
    controller,
    advance,
    get attackCount() {
      return attackCount;
    },
    resolve: () => resolveAttack?.(),
    timers,
    time: () => time,
  };
}

test("starts only for confirmed active state and schedules first strike at readyAt", () => {
  const f = fixture({ randomValue: 0.999, readyAt: 103_000 });
  assert.equal(f.auto.start(), true);
  assert.equal(f.auto.getSnapshot().nextAttackAt, 103_000);
  f.auto.stop();
  f.controller.update({
    battle: { ...f.controller.getSnapshot().battle, cooldownKnown: false },
  });
  assert.equal(f.auto.start(), false);
});

test("getSnapshot is referentially stable until a published change", () => {
  const f = fixture({ readyAt: 103_000 });
  const before = f.auto.getSnapshot();
  assert.equal(f.auto.getSnapshot(), before);
  f.auto.start();
  assert.notEqual(f.auto.getSnapshot(), before);
  const scheduled = f.auto.getSnapshot();
  assert.equal(f.auto.getSnapshot(), scheduled);
});

test("cooldown and strike delay combine, then waits for confirmation before scheduling again", async () => {
  const f = fixture({ randomValue: 0, readyAt: 105_000 });
  f.auto.start();
  f.advance(4_999);
  assert.equal(f.attackCount, 0);
  f.advance(1);
  assert.equal(f.attackCount, 1);
  assert.equal(f.auto.getSnapshot().nextAttackAt, null);
  f.resolve();
  await new Promise(setImmediate);
  assert.equal(f.auto.getSnapshot().nextAttackAt, 107_000);
});

for (const threshold of [5, 10]) {
  test(`adds a 5 to 10 second pause after ${threshold} confirmed strikes`, async () => {
    const f = fixture({ randomValue: threshold === 5 ? 0 : 0.999 });
    f.auto.start();
    if (f.attackCount) {
      f.resolve();
      await new Promise(setImmediate);
    }
    for (let i = 1; i < threshold; i++) {
      const due = [...f.timers.values()][0].at;
      f.advance(due - f.time());
      f.resolve();
      await new Promise(setImmediate);
    }
    const snap = f.auto.getSnapshot();
    assert.equal(snap.pause, true);
    assert.equal(
      snap.nextAttackAt - f.time(),
      (threshold === 5 ? 2 : 4) * 1000 + (threshold === 5 ? 5 : 10) * 1000,
    );
  });
}

test("stops and cancels on invalidated state or explicit stop; late attack completion cannot restart", async () => {
  const f = fixture({ readyAt: 103_000 });
  f.auto.start();
  const due = [...f.timers.values()][0].at;
  f.advance(due - f.time());
  f.controller.update({ error: "Состояние неизвестно" });
  assert.equal(f.auto.getSnapshot().enabled, false);
  f.resolve();
  await new Promise(setImmediate);
  assert.equal(f.auto.getSnapshot().nextAttackAt, null);
  assert.equal(f.timers.size, 0);
});

test("stops if a different battle appears while the current timer is pending", () => {
  const f = fixture({ readyAt: 103_000 });
  f.auto.start();
  f.controller.update({
    battle: { ...f.controller.getSnapshot().battle, id: "fight-2" },
  });
  assert.equal(f.auto.getSnapshot().enabled, false);
  assert.equal(f.timers.size, 0);
  f.advance(20_000);
  assert.equal(f.attackCount, 0);
});

test("an extended readyAt is honored without an early strike", () => {
  const f = fixture({ readyAt: 103_000 });
  f.auto.start();
  f.advance(500);
  f.controller.update({
    battle: { ...f.controller.getSnapshot().battle, readyAt: 110_000 },
  });
  f.advance(1_500);
  assert.equal(f.attackCount, 0);
  assert.equal(f.auto.getSnapshot().nextAttackAt, 103_000);
  f.advance(1_000);
  assert.equal(f.auto.getSnapshot().nextAttackAt, 110_000);
  f.advance(7_000);
  assert.equal(f.attackCount, 1);
});

test("a no-op or rejected attack stops without scheduling a retry", async () => {
  const f = fixture({ readyAt: 103_000 });
  f.auto.start();
  f.controller.attack = async () => {};
  const due = [...f.timers.values()][0].at;
  f.advance(due - f.time());
  await new Promise(setImmediate);
  assert.equal(f.auto.getSnapshot().enabled, false);
  assert.equal(f.timers.size, 0);
});

test("invitation wakeups keep the original human attack deadline", async () => {
  const f = fixture();
  const attack = f.controller.attack;
  let invitations = 0;
  f.controller.nextActionAt = (deadline) => Math.min(deadline, f.time() + 1000);
  f.controller.attack = (options) => {
    if (f.time() < options.notBefore) {
      invitations++;
      return Promise.resolve({ kind: "invite" });
    }
    return attack();
  };
  assert.equal(f.auto.start(), true);
  assert.equal(f.auto.getSnapshot().nextAttackAt, 102000);
  f.advance(1000);
  await new Promise(setImmediate);
  assert.equal(invitations, 1);
  assert.equal(f.attackCount, 0);
  assert.equal(f.auto.getSnapshot().nextAttackAt, 102000);
  assert.equal(f.auto.exportState().attackNotBefore, 102000);
  f.advance(1000);
  assert.equal(f.attackCount, 1);
  f.resolve();
  await new Promise(setImmediate);
  assert.equal(f.auto.getSnapshot().nextAttackAt, 104000);
  f.advance(1000);
  await new Promise(setImmediate);
  assert.equal(f.attackCount, 1);
  assert.equal(f.auto.getSnapshot().nextAttackAt, 104000);
  f.auto.dispose();
});
