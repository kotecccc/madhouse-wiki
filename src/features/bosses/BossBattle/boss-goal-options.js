import { bossDropIdentity } from "./boss-battle-reference.js";

export const BOSS_GOAL_KINDS = [
  { id: "battles", value: "battles", label: "Количество боёв" },
  {
    id: "business_items",
    value: "business_items",
    label: "Количество предметов бизнеса",
  },
  { id: "drops", value: "drops", label: "Дроп всех или выбранных предметов" },
  { id: "time", value: "time", label: "Время" },
];

export function goalDropOptions(reference) {
  const unique = new Map();
  for (const drop of reference?.possibleDrops || []) {
    const key = bossDropIdentity(drop);
    if (key && !unique.has(key))
      unique.set(key, {
        key,
        name: drop.name || key,
        type: drop.type,
      });
  }
  return [...unique.values()];
}

// IDs, item names and the "all" list are resolved against the server catalogue.
export function resolveBossGoal(config, boss) {
  if (!config || !boss || config.bossId !== boss.id)
    throw new TypeError("Invalid goal boss");
  const options = goalDropOptions(boss.reference);
  let items = [];
  if (config.kind === "business_items") {
    const selected = options.find(
      (item) => item.type === "activity_item" && item.key === config.itemKey,
    );
    if (!selected) throw new TypeError("Unknown business material");
    items = [selected];
  } else if (config.kind === "drops") {
    if (config.selection !== "all" && config.selection !== "selected")
      throw new TypeError("Invalid drop selection");
    const keys =
      config.selection === "all"
        ? options.map((item) => item.key)
        : config.itemKeys;
    if (
      !Array.isArray(keys) ||
      !keys.length ||
      keys.length > 200 ||
      new Set(keys).size !== keys.length
    )
      throw new TypeError("Invalid drop items");
    items = keys.map((key) => {
      const item = options.find((candidate) => candidate.key === key);
      if (!item) throw new TypeError("Unknown drop item");
      return item;
    });
  }
  return {
    bossId: boss.id,
    bossName: boss.name,
    kind: config.kind,
    targetCount: config.kind === "drops" ? items.length : config.targetCount,
    items: items.map(({ key, name }) => ({ key, name })),
    durationHours: config.durationHours ?? null,
    maxAttempts: config.maxAttempts ?? null,
  };
}
