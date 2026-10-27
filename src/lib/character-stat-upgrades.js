export const CHARACTER_STATS = ["madness", "aggression", "rage"];
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;

// Values must come from a fresh /api/me response for the verified account.
// Never infer a bulk price from the current single-point price: the game also
// reports a price cap and the price can change after each upgrade.
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
  const maxPrice = amount * config.maxCost;
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
