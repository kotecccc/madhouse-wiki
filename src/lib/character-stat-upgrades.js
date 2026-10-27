export const CHARACTER_STATS = ["madness", "aggression", "rage"];
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;

export function allCharacterUpgradesComplete(upgrades, now = Date.now()) {
  const resetAt = Date.parse(upgrades?.resetAtUtc);
  return (
    Number.isFinite(resetAt) &&
    resetAt > now &&
    CHARACTER_STATS.every((stat) => {
      const value = upgrades?.[stat];
      return (
        Number.isSafeInteger(value?.dailyLimit) &&
        value.dailyLimit > 0 &&
        value.dailyUsed === value.dailyLimit &&
        value.dailyRemaining === 0
      );
    })
  );
}

// Prices observed from the game on 2026-10-27, in daily purchase order.
const DAILY_PRICES = {
  madness: [
    500, 765, 1029, 1294, 1559, 1824, 2088, 2353, 2618, 2882, 3147, 3412, 3676,
    3941, 4206, 4471, 4735, 5000,
  ],
  aggression: [
    150, 173, 196, 219, 242, 264, 287, 310, 333, 356, 379, 402, 425, 447, 470,
    493, 516, 539, 562, 585, 608, 631, 653, 676, 699, 722, 745, 768, 791, 814,
    836, 859, 882, 905, 928, 951, 974, 997, 1019, 1042, 1065, 1088, 1111, 1134,
    1157, 1180, 1203, 1225, 1248, 1271, 1294, 1317, 1340, 1363, 1386, 1408,
    1431, 1454, 1477, 1500,
  ],
  rage: Array(20).fill(1500),
};
const CURRENCIES = { madness: "gold", aggression: "gold", rage: "pills" };

// Confirm the game's current quote and limits still match the observed table.
// If they change, retain a conservative ceiling instead of guessing a total.
export function characterUpgradeQuote(profile, stat, amount) {
  if (
    !CHARACTER_STATS.includes(stat) ||
    !Number.isSafeInteger(amount) ||
    amount < 1
  )
    return null;
  const config = profile?.characterStatsUpgrade?.[stat];
  const base = profile?.characterStats?.[stat]?.base;
  const resetAt = profile?.characterStatsUpgrade?.resetAtUtc;
  if (
    !config ||
    !nonnegative(base) ||
    !nonnegative(config.dailyLimit) ||
    !nonnegative(config.dailyUsed) ||
    !nonnegative(config.dailyRemaining) ||
    config.dailyUsed + config.dailyRemaining !== config.dailyLimit ||
    amount > config.dailyRemaining ||
    !nonnegative(config.costPerPoint) ||
    !nonnegative(config.nextCost) ||
    config.costPerPoint !== config.nextCost ||
    !nonnegative(config.maxCost) ||
    config.maxCost < config.nextCost ||
    !["gold", "pills"].includes(config.currency) ||
    !nonnegative(profile.wallet?.[config.currency]) ||
    typeof resetAt !== "string" ||
    !Number.isFinite(Date.parse(resetAt))
  )
    return null;
  const prices = DAILY_PRICES[stat];
  const matchesTable =
    config.currency === CURRENCIES[stat] &&
    config.dailyLimit === prices.length &&
    config.nextCost === prices[config.dailyUsed] &&
    config.maxCost === prices.at(-1) &&
    (config.startCost == null || config.startCost === prices[0]);
  const maxPrice = matchesTable
    ? prices
        .slice(config.dailyUsed, config.dailyUsed + amount)
        .reduce((sum, price) => sum + price, 0)
    : amount * config.maxCost;
  if (!Number.isSafeInteger(maxPrice)) return null;
  return {
    stat,
    amount,
    base,
    dailyUsed: config.dailyUsed,
    dailyRemaining: config.dailyRemaining,
    dailyLimit: config.dailyLimit,
    resetAt,
    currency: config.currency,
    nextCost: config.nextCost,
    maxCost: config.maxCost,
    balance: profile.wallet[config.currency],
    maxPrice: amount === 1 ? config.nextCost : maxPrice,
  };
}
