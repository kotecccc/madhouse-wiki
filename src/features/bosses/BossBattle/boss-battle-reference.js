import { mutagenImageUrl } from "../../../../scripts/catalogue/public-assets.mjs";

const identityFields = [
  "type",
  "entityId",
  "itemId",
  "elementId",
  "setId",
  "ingredientId",
  "mutagenType",
  "mutagenLevel",
];
const dropFields = [
  ...identityFields,
  "name",
  "image",
  "amount",
  "slotLabel",
  "categoryId",
];
const referenceFields = [
  "name",
  "image",
  "requiredLevel",
  "rewardUntilLevel",
  "maxHp",
  "damageMin",
  "damageMax",
  "maxFightDurationSeconds",
  "maxParticipants",
];
const pick = (source, fields) =>
  Object.fromEntries(
    fields
      .filter((key) => source?.[key] != null)
      .map((key) => [key, source[key]]),
  );
const positiveId = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
};

export function bossBattleReference(boss) {
  return {
    ...pick(boss, referenceFields),
    rewardPreview: pick(boss?.rewardPreview, [
      "gold",
      "dollar",
      "pills",
      "exp",
    ]),
    possibleDrops: (Array.isArray(boss?.possibleDrops)
      ? boss.possibleDrops
      : []
    ).map((drop) => pick(drop, dropFields)),
  };
}

export function bossDropIdentity(drop) {
  if (!drop || typeof drop.type !== "string") return null;
  if (drop.type === "mutagen") {
    const family =
      typeof drop.mutagenType === "string"
        ? drop.mutagenType.toUpperCase()
        : "";
    const level = positiveId(drop.mutagenLevel);
    return /^[IAXFSZW]$/.test(family) && level
      ? `mutagen:${family}:${level}`
      : null;
  }
  if (drop.type === "stash_ingredient") {
    const set = positiveId(drop.setId),
      ingredient = positiveId(drop.ingredientId);
    if (set && ingredient) return `stash_ingredient:${set}:${ingredient}`;
  }
  const id =
    positiveId(drop.itemId) ||
    positiveId(drop.elementId) ||
    positiveId(drop.entityId);
  return id ? `${drop.type}:${id}` : null;
}

// Current-battle receipts only. Never infer inventory ownership from catalogue data.
export function grantedBattleDrops(reward) {
  if (!Array.isArray(reward?.drops)) return [];
  return reward.drops
    .filter(
      (drop) =>
        drop?.granted === true &&
        Number.isSafeInteger(drop.amount) &&
        drop.amount > 0,
    )
    .map((drop) => ({
      ...pick(drop, [...identityFields, "amount"]),
      ...(typeof drop.name === "string" ? { name: drop.name } : {}),
    }));
}

export function bossBattleLoot(reference, battle) {
  const granted = new Map();
  const unidentifiable = [];
  for (const drop of battle?.grantedDrops || []) {
    const key = bossDropIdentity(drop);
    if (!key) {
      unidentifiable.push(drop);
      continue;
    }
    const previous = granted.get(key);
    const sum = (previous?.amount || 0) + drop.amount;
    granted.set(key, {
      ...drop,
      amount:
        previous?.amount === null
          ? null
          : Number.isSafeInteger(sum)
            ? sum
            : null,
    });
  }
  const seen = new Set();
  const result = [];
  for (const [index, item] of (reference?.possibleDrops || []).entries()) {
    const identity = bossDropIdentity(item);
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    const receipt = identity ? granted.get(identity) : null;
    result.push({
      item,
      key: identity || `catalogue-${index}`,
      received: Boolean(receipt),
      amount: receipt?.amount ?? null,
    });
  }
  for (const [key, drop] of granted) {
    if (!seen.has(key))
      result.push({
        key,
        item:
          drop.type === "mutagen"
            ? {
                ...drop,
                image: mutagenImageUrl(drop.mutagenType, drop.mutagenLevel),
              }
            : drop,
        received: true,
        amount: drop.amount,
      });
  }
  for (const [index, drop] of unidentifiable.entries())
    result.push({
      key: `receipt-${index}`,
      item: drop,
      received: true,
      amount: drop.amount,
    });
  return result;
}
