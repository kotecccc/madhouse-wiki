// owned is a quantity in /api/stash/sets, unlike boolean wardrobe ownership.
// purchaseUnlocked only describes purchase unlock; never infer discovery from it.
export function normalizeWorkStash(raw, setId, previous = null) {
  const set = raw?.sets?.find((item) => String(item.setId) === String(setId));
  if (!Array.isArray(set?.ingredients)) return previous;
  return {
    setId,
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
