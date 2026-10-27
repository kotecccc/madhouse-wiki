import { test } from "node:test";
import { strict as assert } from "node:assert";
import { characterUpgradeQuote } from "./character-stat-upgrades.js";

const profile = () => ({
  characterStats: { madness: { base: 429 } },
  wallet: { gold: 100000 },
  characterStatsUpgrade: {
    resetAtUtc: "2026-10-27T21:00:00Z",
    madness: {
      costPerPoint: 500,
      nextCost: 500,
      maxCost: 5000,
      currency: "gold",
      dailyLimit: 18,
      dailyUsed: 0,
      dailyRemaining: 18,
    },
  },
});

test("quotes a single upgrade and a bounded maximum from game data", () => {
  assert.equal(characterUpgradeQuote(profile(), "madness", 1).maxPrice, 500);
  assert.equal(characterUpgradeQuote(profile(), "madness", 18).maxPrice, 90000);
  assert.equal(characterUpgradeQuote(profile(), "madness", 19), null);
});

test("rejects incomplete or contradictory limits, prices and account data", () => {
  for (const mutate of [
    (p) => delete p.characterStatsUpgrade.madness.nextCost,
    (p) => (p.characterStatsUpgrade.madness.costPerPoint = 501),
    (p) => (p.characterStatsUpgrade.madness.dailyRemaining = 17),
    (p) => (p.characterStatsUpgrade.madness.maxCost = 100),
    (p) => (p.characterStatsUpgrade.madness.currency = "unknown"),
    (p) => delete p.wallet.gold,
    (p) => delete p.characterStats.madness.base,
    (p) => (p.characterStatsUpgrade.resetAtUtc = "unknown"),
  ]) {
    const data = profile();
    mutate(data);
    assert.equal(characterUpgradeQuote(data, "madness", 1), null);
  }
});
