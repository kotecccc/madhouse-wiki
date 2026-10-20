export function getBusinessUpgradeTotals(upgrade, targetLevel) {
  if (!upgrade || !Array.isArray(upgrade.items)) return [];

  const validTarget = Number.isSafeInteger(targetLevel) && targetLevel > 0;

  return upgrade.items.map((item) => {
    let requiredAmount = null;

    if (
      validTarget &&
      Array.isArray(item.levels) &&
      item.levels.length >= targetLevel
    ) {
      const prefix = item.levels.slice(0, targetLevel);
      if (prefix.every((count) => Number.isFinite(count) && count >= 0)) {
        const total = prefix.reduce((sum, count) => sum + count, 0);
        if (Number.isFinite(total)) requiredAmount = total;
      }
    }

    return { ...item, requiredAmount };
  });
}

export function findItemBosses(bosses, itemId) {
  if (!Array.isArray(bosses) || itemId == null) return [];
  const targetId = String(itemId);

  return bosses.filter((boss) =>
    (boss.dropItems ?? []).some(
      (item) => item.entityId != null && String(item.entityId) === targetId,
    ),
  );
}
