import test from "node:test";
import assert from "node:assert/strict";
import { forecastQuota } from "../scripts/automation/quota-forecast.mjs";
const battle = {
  id: "b",
  dropDamageRequired: 50000,
  totalDamage: 30000,
  bossHealth: 40000,
  participantCount: 2,
  readyAt: 25000,
  expiresAt: 100000,
};
const samples = [
  {
    battleId: "b",
    at: 10000,
    bossHealth: 100000,
    totalDamage: 25000,
    ownHit: 5000,
    participantCount: 2,
    cooldownMs: 6000,
  },
  {
    battleId: "b",
    at: 20000,
    bossHealth: 40000,
    totalDamage: 30000,
    ownHit: 5000,
    participantCount: 2,
    cooldownMs: 6000,
  },
];
test("quota estimate includes waiting, normal intervals and pauses; fast allies produce risk", () => {
  const value = forecastQuota(battle, samples, 20000);
  assert.equal(value.hitsNeeded, 4);
  assert.equal(value.secondsNeeded, 45);
  assert.equal(value.secondsLeft, 6);
  assert.equal(value.atRisk, true);
});
test("unknown data and participant changes never invent a damage forecast", () => {
  assert.equal(
    forecastQuota({ ...battle, dropDamageRequired: null }, samples, 20000),
    null,
  );
  assert.equal(
    forecastQuota({ ...battle, participantCount: 3 }, samples, 20000)
      .hitsNeeded,
    null,
  );
  assert.equal(forecastQuota(battle, [], 20000).secondsNeeded, null);
});
test("quota changes recalculate remaining damage instead of latching completion", () => {
  assert.equal(
    forecastQuota({ ...battle, dropDamageRequired: 25000 }, samples, 20000)
      .remaining,
    0,
  );
  assert.equal(
    forecastQuota({ ...battle, dropDamageRequired: 60000 }, samples, 20000)
      .hitsNeeded,
    6,
  );
  assert.equal(
    forecastQuota({ ...battle, bossHealth: 10000 }, [], 20000).atRisk,
    true,
  );
});
