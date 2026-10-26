import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeWorkState,
  normalizeEnergy,
  normalizeBoosters,
  workEnergyRemaining,
  planWorkFarm,
  latestWorkEnergy,
} from "../src/features/works/WorkFarm/work-farm-plan.js";
const task = (id, cost, required = 1, progress = 0) => ({
  id,
  title: `Task ${id}`,
  energyCost: cost,
  required,
  progress,
  canPerform: true,
});
const view = (tasks, current = 10, max = 10) => ({
  workId: 1,
  title: "Work",
  completedCycles: 4,
  tasks,
  energy: { current, max, regenIntervalSeconds: 120, secondsToNext: 30 },
  walletDollar: 100,
  boosters: [
    {
      type: "small",
      count: 0,
      restoreEnergy: 5,
      costDollar: 2,
      maxPurchaseQuantity: 100,
    },
    {
      type: "full",
      count: 0,
      restoreEnergy: 10,
      costDollar: 3,
      maxPurchaseQuantity: 100,
    },
  ],
});
const config = {
  targetCycles: 5,
  maxActions: 100,
  maxBoosters: 10,
  maxDollar: 100,
  allowPurchase: true,
  mode: "boosters",
};

test("remaining work energy subtracts prior cycles and partial task progress", () => {
  assert.equal(
    workEnergyRemaining(view([task(1, 2, 5, 3), task(2, 3, 2, 1)]), 6),
    23,
  );
  assert.equal(workEnergyRemaining(view([task(1, 2)]), 4), 0);
});
test("normalizers preserve uncertainty and reject unknown progress/energy", () => {
  assert.throws(() =>
    normalizeWorkState({ workId: 1, title: "Work", tasks: [] }, 1),
  );
  assert.throws(() =>
    normalizeWorkState(
      { ...view([task(1, 1)]), tasks: [task(1, 1), task(1, 1)] },
      1,
    ),
  );
  assert.throws(() => normalizeEnergy({ current: 11, max: 10 }));
  assert.deepEqual(
    normalizeBoosters({ boosters: { small: { count: 0 } } }),
    [],
  );
});
test("planner picks task order that consumes current energy before reset", () => {
  const result = planWorkFarm(
    view([task(1, 6), task(2, 4), task(3, 3)], 7),
    config,
  );
  assert.equal(result.feasible, true);
  assert.equal(result.optimal, true);
  assert.equal(result.wastedEnergy, 0);
  assert.equal(result.usedBoosters, 1);
  assert.deepEqual(
    new Set(result.actions.slice(0, 2).map((action) => action.taskId)),
    new Set([2, 3]),
  );
});
test("live prices choose full refill over two costly small refills", () => {
  const result = planWorkFarm(view([task(1, 5, 2)], 0), config);
  assert.equal(result.spentDollar, 3);
  assert.equal(result.usedBoosters, 1);
  assert.equal(result.actions[0].type, "full");
});
test("owned items minimize new banknote spend before refill count", () => {
  const source = view([task(1, 5, 2)], 0);
  source.boosters[0].count = 2;
  const result = planWorkFarm(source, config);
  assert.equal(result.spentDollar, 0);
  assert.equal(result.usedBoosters, 2);
});
test("hard resource caps forbid plans beyond allowed spend or item count", () => {
  const source = view([task(1, 5, 2)], 0);
  assert.equal(
    planWorkFarm(source, { ...config, maxDollar: 2 }).feasible,
    false,
  );
  assert.equal(
    planWorkFarm(source, { ...config, maxBoosters: 0 }).feasible,
    false,
  );
  assert.equal(
    planWorkFarm(source, { ...config, allowPurchase: false }).feasible,
    false,
  );
});
test("waiting never spends items and reports only confirmed remaining energy", () => {
  const result = planWorkFarm(view([task(1, 4, 3, 1)], 2), {
    ...config,
    mode: "wait",
  });
  assert.deepEqual(result.actions, [{ kind: "wait" }]);
  assert.equal(result.remainingEnergy, 8);
  assert.equal(result.spentDollar, 0);
});
test("bounded search labels a feasible fallback as an estimate", () => {
  const result = planWorkFarm(view([task(1, 5, 2)], 0), config, {
    maxStates: 0,
  });
  assert.equal(result.feasible, true);
  assert.equal(result.optimal, false);
});
test("planner rejects impossible task capacity and unknown cycle reset", () => {
  assert.throws(() => planWorkFarm(view([task(1, 11)], 0), config));
  assert.throws(() => planWorkFarm(view([task(1, 1, 1, 1)]), config));
});

test("work energy uses the newest validated snapshot, not a stale work value", () => {
  const work = { updatedAt: 100, energy: { current: 1, max: 360 } };
  const profile = { energy: { current: 16, max: 360 } };
  assert.equal(latestWorkEnergy(work, profile, 200), profile.energy);
  assert.equal(latestWorkEnergy(work, profile, 50), work.energy);
  assert.equal(
    latestWorkEnergy(work, { energy: { current: 400, max: 360 } }, 200),
    work.energy,
  );
  assert.equal(latestWorkEnergy(null, profile, 200), profile.energy);
});
