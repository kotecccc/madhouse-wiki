// owned is a quantity in /api/stash/sets, unlike boolean wardrobe ownership.
// purchaseUnlocked only describes purchase unlock; never infer discovery from it.
export function normalizeWorkStash(raw, setId, previous = null) {
  const set = raw?.sets?.find((item) => String(item.setId) === String(setId));
  if (!Array.isArray(set?.ingredients)) return previous;
  return {
    setId,
    canCraft: typeof set.canCraft === "boolean" ? set.canCraft : null,
    craftedCount:
      Number.isSafeInteger(set.craftedCount) && set.craftedCount >= 0
        ? set.craftedCount
        : null,
    ingredients: set.ingredients.map((item) => ({
      ingredientId: item.ingredientId,
      quantity:
        Number.isSafeInteger(item.owned) && item.owned >= 0 ? item.owned : null,
      unlocked: typeof item.unlocked === "boolean" ? item.unlocked : null,
      purchaseUnlocked:
        typeof item.purchaseUnlocked === "boolean"
          ? item.purchaseUnlocked
          : null,
    })),
  };
}

export function workStashFirstCollection(stash, ingredients) {
  if (stash?.craftedCount > 0) return { status: "collected" };
  if (stash?.craftedCount !== 0) return { status: "unknown" };
  if (!ingredients?.length) return { status: "not_collected", missing: null };
  const quantities = ingredients.map(
    (item) =>
      stash.ingredients?.find(
        (entry) => String(entry.ingredientId) === String(item.ingredientId),
      )?.quantity,
  );
  if (quantities.some((quantity) => !Number.isSafeInteger(quantity)))
    return { status: "not_collected", missing: null };
  const missing = quantities.filter((quantity) => quantity === 0).length;
  return { status: "not_collected", missing };
}
