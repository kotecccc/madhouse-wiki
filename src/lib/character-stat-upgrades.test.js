import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  allCharacterUpgradesComplete,
  characterUpgradeQuote,
} from "./character-stat-upgrades.js";

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
  assert.equal(characterUpgradeQuote(profile(), "madness", 18).maxPrice, 49500);
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

test("uses observed daily prices only when the game quote matches", () => {
  for (const [stat, used, remaining, price, currency, total] of [
    ["madness", 0, 18, 500, "gold", 49500],
    ["aggression", 0, 60, 150, "gold", 49500],
    ["aggression", 1, 59, 173, "gold", 49350],
    ["rage", 0, 20, 1500, "pills", 30000],
  ]) {
    const p = profile();
    p.wallet.pills = 100000;
    p.characterStats[stat] = { base: 1 };
    p.characterStatsUpgrade[stat] = {
      currency,
      dailyUsed: used,
      dailyRemaining: remaining,
      dailyLimit: used + remaining,
      costPerPoint: price,
      nextCost: price,
      maxCost: stat === "madness" ? 5000 : 1500,
    };
    assert.equal(characterUpgradeQuote(p, stat, remaining).maxPrice, total);
    p.characterStatsUpgrade[stat].nextCost--;
    p.characterStatsUpgrade[stat].costPerPoint--;
    assert.equal(
      characterUpgradeQuote(p, stat, remaining).maxPrice,
      remaining * (stat === "madness" ? 5000 : 1500),
    );
  }
});

test("remaining totals follow the observed sequence after individual upgrades", () => {
  const p = profile();
  const m = p.characterStatsUpgrade.madness;
  m.dailyUsed = 2;
  m.dailyRemaining = 16;
  m.costPerPoint = m.nextCost = 1029;
  assert.equal(
    characterUpgradeQuote(p, "madness", 16).maxPrice,
    49500 - 500 - 765,
  );
  assert.equal(
    characterUpgradeQuote(p, "madness", 3).maxPrice,
    1029 + 1294 + 1559,
  );
  m.startCost = 501;
  assert.equal(characterUpgradeQuote(p, "madness", 16).maxPrice, 80000);
});

test("all stats are complete only with valid unexpired daily limits", () => {
  const current = Date.parse("2026-10-27T12:00:00Z");
  const upgrades = {
    resetAtUtc: "2026-10-27T21:00:00Z",
    madness: { dailyUsed: 18, dailyLimit: 18, dailyRemaining: 0 },
    aggression: { dailyUsed: 60, dailyLimit: 60, dailyRemaining: 0 },
    rage: { dailyUsed: 20, dailyLimit: 20, dailyRemaining: 0 },
  };
  assert.equal(allCharacterUpgradesComplete(upgrades, current), true);
  assert.equal(
    allCharacterUpgradesComplete(upgrades, Date.parse(upgrades.resetAtUtc)),
    false,
  );
  assert.equal(
    allCharacterUpgradesComplete({ ...upgrades, rage: undefined }, current),
    false,
  );
  assert.equal(
    allCharacterUpgradesComplete(
      { ...upgrades, rage: { ...upgrades.rage, dailyRemaining: 1 } },
      current,
    ),
    false,
  );
  assert.equal(
    allCharacterUpgradesComplete(
      { ...upgrades, rage: { dailyUsed: 0, dailyLimit: 0, dailyRemaining: 0 } },
      current,
    ),
    false,
  );
});
