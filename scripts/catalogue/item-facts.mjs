// Public item definitions only. Never forward an API entity or account state.
const statKeys = [
  "madness",
  "aggression",
  "rage",
  "endurance",
  "maxHealth",
  "baseDamage",
  "attackCooldownSeconds",
  "attackCooldownReductionSeconds",
];
const pickStats = (value) =>
  Object.fromEntries(
    statKeys
      .filter((key) => Number.isFinite(value?.[key]))
      .map((key) => [key, value[key]]),
  );
const price = (value) => {
  if (
    !value ||
    !Number.isFinite(value.amount) ||
    value.amount < 0 ||
    !["gold", "dollar", "pills", "stars"].includes(value.currency)
  )
    return null;
  return { amount: value.amount, currency: value.currency };
};

export function itemFacts(entity, kind) {
  if (!entity) return null;
  const base =
    kind === "mutagen"
      ? (entity.bonuses ??
        Object.fromEntries(
          ["madness", "aggression", "rage"]
            .filter((key) => Number.isFinite(entity[`${key}Bonus`]))
            .map((key) => [key, entity[`${key}Bonus`]]),
        ))
      : (entity.baseBonus ?? entity.itemBonus ?? entity.bonuses);
  const installCost = entity.installPillCost;
  return {
    stats: pickStats(base),
    perLevelStats: pickStats(entity.bonusPerLevel),
    purchasePrice: price(entity.price ?? entity.purchasePrice),
    installPrice:
      Number.isFinite(installCost) && installCost >= 0
        ? { amount: installCost, currency: "pills" }
        : null,
  };
}
