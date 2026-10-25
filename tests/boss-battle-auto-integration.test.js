import test from "node:test";
import assert from "node:assert/strict";
import { createBossBattleController } from "../src/features/bosses/BossBattle/boss-battle-controller.js";
import { createBossBattleAutoAttack } from "../src/features/bosses/BossBattle/boss-battle-auto.js";

async function fixture({
  missingCooldown = false,
  fail = false,
  victory = false,
  canManualAttack = () => true,
} = {}) {
  let time = 100000;
  const timers = new Map();
  const calls = [];
  let seq = 0;
  const raw = (patch = {}) => ({
    battleId: "fight-1",
    bossId: 7,
    status: "active",
    playerHealth: 100,
    playerMaxHealth: 100,
    bossHealth: 100,
    bossMaxHealth: 100,
    serverTimeUtc: new Date(time).toISOString(),
    expiresAtUtc: new Date(1000000).toISOString(),
    retryAfterMilliseconds: 3000,
    ...patch,
  });
  const controller = createBossBattleController({
    now: () => time,
    operationId: () => `op-${++seq}`,
    canManualAttack,
    request: async (method, path) => {
      calls.push([method, path]);
      if (method === "GET") return { id: 7, activeBattle: raw() };
      if (fail) throw Object.assign(new Error("rate limit"), { status: 429 });
      return {
        battle: raw({
          bossHealth: victory ? 0 : 90,
          status: victory ? "won" : "active",
          ...(missingCooldown ? { retryAfterMilliseconds: undefined } : {}),
        }),
      };
    },
  });
  const auto = createBossBattleAutoAttack({
    controller,
    now: () => time,
    random: () => 0,
    schedule: (fn, delay) => {
      const id = ++seq;
      timers.set(id, { fn, due: time + delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  const advance = async (delay) => {
    time += delay;
    const due = [...timers].filter(([, t]) => t.due <= time);
    for (const [id, timer] of due) {
      timers.delete(id);
      timer.fn();
    }
    await new Promise(setImmediate);
  };
  controller.open({ numericId: 7, name: "Босс" });
  await new Promise(setImmediate);
  return { auto, controller, calls, advance, timers };
}

test("real controller intermediate states do not interrupt auto; each strike sends one POST only", async () => {
  const f = await fixture();
  assert.equal(f.calls.length, 1);
  assert.equal(f.auto.getSnapshot().enabled, false);
  assert.equal(f.auto.start(), true);
  await f.advance(2999);
  assert.equal(f.calls.length, 1);
  await f.advance(1);
  assert.deepEqual(f.calls, [
    ["GET", "/api/bosses/7"],
    ["POST", "/api/bosses/battles/fight-1/attack"],
  ]);
  assert.equal(f.controller.getSnapshot().needsRefresh, false);
  assert.equal(f.auto.getSnapshot().enabled, true);
  assert.equal(f.auto.getSnapshot().nextAttackAt, 108000);
  f.controller.close();
  f.controller.open({ numericId: 7, name: "Босс" }, { refresh: false });
  assert.equal(f.auto.getSnapshot().enabled, true);
  assert.equal(f.calls.length, 2);
  f.controller.close();
  await f.advance(5000);
  assert.deepEqual(f.calls, [
    ["GET", "/api/bosses/7"],
    ["POST", "/api/bosses/battles/fight-1/attack"],
    ["POST", "/api/bosses/battles/fight-1/attack"],
  ]);
  assert.equal(f.auto.getSnapshot().enabled, true);
  f.auto.stop();
  await f.advance(10000);
  assert.equal(f.auto.getSnapshot().enabled, false);
  assert.equal(f.calls.length, 3);
});

test("manual controller guard prevents a manual attack request", async () => {
  const f = await fixture({ canManualAttack: () => false });
  await f.controller.attack();
  assert.equal(f.calls.length, 1);
});

for (const mode of ["missingCooldown", "fail", "victory"]) {
  test(`real controller stops auto after ${mode} without a retry or a new fight`, async () => {
    const f = await fixture({ [mode]: true });
    f.auto.start();
    await f.advance(5000);
    assert.equal(f.auto.getSnapshot().enabled, false);
    assert.equal(f.timers.size, 0);
    await f.advance(100000);
    assert.equal(f.calls.length, 2);
    if (mode === "victory")
      assert.equal(f.controller.getSnapshot().battle.status, "won");
  });
}

test("manual refresh pauses strikes, resumes after success and stops after failed verification", async () => {
  let time = 100000;
  let release;
  let reject;
  let holding = false;
  let posts = 0;
  const timers = new Map();
  let seq = 0;
  const raw = () => ({
    battleId: "refresh-fight",
    bossId: 7,
    status: "active",
    playerHealth: 100,
    playerMaxHealth: 100,
    bossHealth: 100,
    bossMaxHealth: 100,
    retryAfterMilliseconds: 3000,
  });
  const controller = createBossBattleController({
    now: () => time,
    request: async (method, path) => {
      if (method === "POST") {
        posts++;
        return { battle: raw() };
      }
      if (holding)
        return new Promise((resolve, fail) => {
          release = resolve;
          reject = fail;
        });
      return path.includes("/battles/")
        ? raw()
        : { id: 7, activeBattle: raw() };
    },
  });
  await controller.open({ numericId: 7, name: "Boss" });
  const auto = createBossBattleAutoAttack({
    controller,
    now: () => time,
    random: () => 0,
    schedule: (fn) => {
      const id = ++seq;
      timers.set(id, fn);
      return id;
    },
    cancel: (id) => timers.delete(id),
  });
  assert.equal(auto.start(), true);
  holding = true;
  const refresh = controller.refresh();
  assert.equal(auto.getSnapshot().enabled, true);
  assert.equal(timers.size, 0);
  time += 5000;
  assert.equal(posts, 0);
  release(raw());
  await refresh;
  assert.equal(auto.getSnapshot().enabled, true);
  assert.equal(timers.size, 1);
  const failed = controller.refresh();
  reject(new Error("offline"));
  await failed;
  assert.equal(auto.getSnapshot().enabled, false);
  assert.equal(timers.size, 0);
  auto.dispose();
});
