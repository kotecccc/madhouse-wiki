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

export function workStashPartsProgress(stash, ingredients) {
  if (!ingredients?.length || !stash) return null;
  const quantities = ingredients.map(
    (item) =>
      stash.ingredients?.find(
        (entry) => String(entry.ingredientId) === String(item.ingredientId),
      )?.quantity,
  );
  if (quantities.some((quantity) => !Number.isSafeInteger(quantity)))
    return null;
  return {
    owned: quantities.filter((quantity) => quantity > 0).length,
    total: ingredients.length,
  };
}

// The public game client treats a missing stashDrop on a successful task as no drop.
// A drop's items contain the updated owned quantities; reject partial snapshots.
export function applyWorkStashDrop(stash, ingredients, response) {
  if (!stash || response?.success !== true || response.isDuplicate === true)
    return null;
  const drop = response.stashDrop;
  if (drop == null) return stash;
  if (
    typeof drop !== "object" ||
    String(drop.setId) !== String(stash.setId) ||
    !Array.isArray(drop.items) ||
    !ingredients?.some(
      (part) => String(part.ingredientId) === String(drop.ingredientId),
    )
  )
    return null;
  const next = {
    ...stash,
    ingredients: stash.ingredients.map((part) => {
      const matches = drop.items.filter(
        (item) => String(item.ingredientId) === String(part.ingredientId),
      );
      if (
        matches.length !== 1 ||
        !Number.isSafeInteger(matches[0].owned) ||
        matches[0].owned < 0
      )
        return null;
      return { ...part, quantity: matches[0].owned };
    }),
  };
  return next.ingredients.some((part) => !part) ||
    !workStashPartsProgress(next, ingredients)
    ? null
    : next;
}
