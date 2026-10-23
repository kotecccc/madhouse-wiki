export function businessUpgradeCardGroups(knowledgeBase) {
  const businessesById = new Map(
    (knowledgeBase.businesses || []).map((business) => [business.id, business]),
  );
  const groups = [];

  for (const upgrade of knowledgeBase.businessUpgrades || []) {
    const business = businessesById.get(upgrade.businessId);
    if (!business) continue;

    const itemLengths = (upgrade.items || [])
      .map((item) => (Array.isArray(item.levels) ? item.levels.length : 0))
      .filter((length) => length > 0);
    const highestLevel = itemLengths.length ? Math.min(...itemLengths) : 0;
    const businessId = business.apiId || business.id;

    for (let level = 1; level <= highestLevel; level += 1) {
      groups.push({
        key: `${business.id}:${level}`,
        business,
        businessId,
        requirement: { requiredLevel: level },
      });
    }
  }

  return groups;
}
