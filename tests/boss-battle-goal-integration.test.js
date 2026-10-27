import test from "node:test";
import assert from "node:assert/strict";
import { createBossBattleController } from "../src/features/bosses/BossBattle/boss-battle-controller.js";
import { createBossBattleGoal } from "../src/features/bosses/BossBattle/boss-battle-goal.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));
function fixture({
  kind = "battles",
  targetCount = 3,
  maxAttempts = 3,
  outcomes = ["won", "lost", "won"],
} = {}) {
  let goal;
  let sequence = 0;
  let current = null;
  let beforePreflight = () => {};
  const calls = [];
  const raw = (status = "active") => ({
    battleId: `battle-${sequence}`,
    bossId: 7,
    status,
    playerHealth: status === "lost" ? 0 : 100,
    playerMaxHealth: 100,
    bossHealth: status === "won" ? 0 : 200,
    bossMaxHealth: 200,
  });
  const controller = createBossBattleController({
    canStartBattle: () => goal.canStart(),
    operationId: () => `operation-${calls.length}`,
    request: async (method, path) => {
      calls.push([method, path]);
      if (path === "/api/bosses/7") {
        await beforePreflight();
        return {
          id: 7,
          state: { canStartFight: true },
          activeBattle: current?.status === "active" ? current : null,
        };
      }
      if (method === "GET") return current;
      if (path.endsWith("/attack")) {
        current = raw(outcomes[sequence - 1]);
        return { battle: current, hits: [{ actor: "player", damage: 10 }] };
      }
      sequence++;
      current = raw();
      return { battle: current };
    },
  });
  goal = createBossBattleGoal({ controller });
  return {
    controller,
    goal,
    calls,
    async prepare() {
      controller.open({ numericId: 7, name: "Босс" });
      await settle();
      goal.configure({
        bossId: 7,
        bossName: "Босс",
        kind,
        targetCount,
        maxAttempts,
        items:
          kind === "business_items"
            ? [{ key: "activity_item:1", name: "Материал" }]
            : [],
      });
    },
    setPreflight(fn) {
      beforePreflight = fn;
    },
  };
}

test("manual series counts unique results, preserves goal on close and stops at the requested completed battles", async () => {
  const f = fixture();
  await f.prepare();
  assert.equal(f.calls.filter(([method]) => method === "POST").length, 0);
  await f.controller.start();
  await f.controller.attack();
  await f.controller.refresh();
  assert.equal(f.goal.getSnapshot().wins, 1);
  assert.equal(f.goal.getSnapshot().attempts, 1);
  f.controller.close();
  assert.equal(f.goal.getSnapshot().wins, 1);
  await f.controller.startNextBattle();
  await f.controller.attack();
  assert.equal(f.goal.getSnapshot().losses, 1);
  assert.equal(f.goal.getSnapshot().canContinue, true);
  await f.controller.startNextBattle();
  assert.equal(f.goal.getSnapshot().status, "active");
  await f.controller.attack();
  assert.equal(f.goal.getSnapshot().status, "completed");
  assert.equal(f.goal.getSnapshot().wins, 2);
  assert.equal(f.goal.getSnapshot().attempts, 3);
  const before = f.calls.length;
  await f.controller.startNextBattle();
  assert.equal(f.calls.length, before);
  f.goal.dispose();
});

test("attempt limit blocks another fight after a defeat without blocking the last attempt itself", async () => {
  const f = fixture({
    kind: "business_items",
    targetCount: 2,
    maxAttempts: 1,
    outcomes: ["lost"],
  });
  await f.prepare();
  await f.controller.start();
  assert.equal(f.goal.getSnapshot().status, "active");
  await f.controller.attack();
  assert.equal(f.goal.getSnapshot().status, "exhausted");
  const before = f.calls.length;
  await f.controller.startNextBattle();
  assert.equal(f.calls.length, before);
  f.goal.dispose();
});

test("stopping a goal during the next-battle preflight prevents its POST", async () => {
  const f = fixture();
  await f.prepare();
  await f.controller.start();
  await f.controller.attack();
  f.setPreflight(() => f.goal.stop());
  const posts = f.calls.filter(([method]) => method === "POST").length;
  await f.controller.startNextBattle();
  assert.equal(f.calls.filter(([method]) => method === "POST").length, posts);
  assert.equal(f.goal.getSnapshot().status, "stopped");
  f.goal.dispose();
});
