const typeOrder = new Map([
  ["activity_item", 0],
  ["room", 1],
  ["weapon", 2],
  ["pet", 3],
  ["clothing_item", 4],
  ["ornament", 5],
  ["stash_ingredient", 6],
  ["mutagen", 8],
]);

// Confirmed clothing categories: face, neck accessory, torso, hands, legs, feet.
// Unknown slots remain after the known clothing slots, without guessing a body part.
const clothingOrder = new Map(
  [8, 6, 3, 4, 2, 5].map((id, index) => [id, index]),
);
const slotOrder = new Map([
  ["Маска", 0],
  ["Цепь", 1],
  ["Торс", 2],
  ["Перчатки", 3],
  ["Брюки", 4],
  ["Обувь", 5],
]);
const mutagenOrder = new Map(
  ["I", "A", "X", "F", "S", "Z", "W"].map((type, index) => [type, index]),
);

function mutagenKey(drop) {
  const nameParts = drop.name?.match(/\b([IAXFSZW])[-\s](\d+)\b/i);
  const type = String(drop.mutagenType ?? nameParts?.[1] ?? "").toUpperCase();
  const rawLevel = drop.mutagenLevel ?? nameParts?.[2];
  const level =
    rawLevel != null && Number.isFinite(Number(rawLevel))
      ? Number(rawLevel)
      : Number.MAX_SAFE_INTEGER;
  return [mutagenOrder.get(type) ?? 99, level];
}

export function sortBossDrops(drops = []) {
  return drops
    .map((drop, index) => ({ drop, index }))
    .sort((a, b) => {
      const typeDifference =
        (typeOrder.get(a.drop.type) ?? 7) - (typeOrder.get(b.drop.type) ?? 7);
      if (typeDifference) return typeDifference;
      if (a.drop.type === "clothing_item" && b.drop.type === "clothing_item") {
        const slot = (drop) =>
          clothingOrder.get(Number(drop.categoryId)) ??
          slotOrder.get(drop.slotLabel) ??
          99;
        const difference = slot(a.drop) - slot(b.drop);
        if (difference) return difference;
      }
      if (a.drop.type === "mutagen" && b.drop.type === "mutagen") {
        const [familyA, levelA] = mutagenKey(a.drop),
          [familyB, levelB] = mutagenKey(b.drop);
        const difference = familyA - familyB || levelA - levelB;
        if (difference) return difference;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.drop);
}
