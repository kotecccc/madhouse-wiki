import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateCycleEnergy,
  calculateRequirementEnergy,
} from "../src/lib/energy.js";
import { restoreTime } from "../src/lib/format.js";

test("full cycles support zero and multiply the published energy cost", () => {
  assert.deepEqual(calculateCycleEnergy(688, 5), {
    total: 3440,
    count: 5,
    cost: 688,
  });
  assert.equal(calculateCycleEnergy(47.5, 2).total, 95);
  assert.equal(calculateCycleEnergy(90, 0).total, 0);
});
test("unknown costs and invalid counts never become an energy estimate", () => {
  for (const cost of [undefined, null, NaN, Infinity, -1])
    assert.equal(calculateCycleEnergy(cost, 5), null);
  for (const count of [-1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(calculateCycleEnergy(90, count), null);
});
test("recovery uses current energy and limit-based refills", () => {
  assert.deepEqual(calculateRequirementEnergy(688, 105, 105), {
    remaining: 583,
    minutes: 1166,
    maxEnergy: 105,
    currentEnergy: 105,
    largeRefills: 6,
    smallRefills: 0,
    defibrillators: 6,
    banknotes: 60,
  });
  assert.deepEqual(calculateRequirementEnergy(90, 185, 90), {
    remaining: 0,
    minutes: 0,
    maxEnergy: 185,
    currentEnergy: 90,
    largeRefills: 0,
    smallRefills: 0,
    defibrillators: 0,
    banknotes: 0,
  });
  const partial = calculateRequirementEnergy(220, 100, 0);
  assert.equal(partial.remaining, 220);
  assert.equal(partial.largeRefills, 2);
  assert.equal(partial.smallRefills, 2);
  assert.equal(partial.banknotes, 24);
  assert.equal(calculateRequirementEnergy(90, -1, 0), null);
  assert.equal(calculateRequirementEnergy(90, 0, 0), null);
  assert.equal(restoreTime(1440 + 120 + 6), "1 дн 2 ч 6 мин");
  assert.equal(restoreTime(0), "0 мин");
});
