import { bossDropIdentity } from "./boss-battle-reference.js";

export const BOSS_GOAL_KINDS = [
  { id: "battles", value: "battles", label: "Кол-во" },
  {
    id: "business_items",
    value: "business_items",
    label: "Бизнес",
  },
  { id: "drops", value: "drops", label: "Дроп" },
];

const SHOP_DROP_TYPES = new Set([
  "room",
  "weapon",
  "pet",
  "clothing_item",
  "ornament",
]);
export const isShopGoalDrop = (item) =>
  SHOP_DROP_TYPES.has(item.type ?? item.key?.split(":")[0]);

export function restoredShopDropGoal(record) {
  if (record?.settings?.kind !== "drops") return record;
  const items = record.settings.items.filter(isShopGoalDrop);
  return items.length
    ? { ...record, settings: { ...record.settings, items } }
    : null;
}

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
  const allOptions = goalDropOptions(boss.reference);
  const options =
    config.kind === "drops" ? allOptions.filter(isShopGoalDrop) : allOptions;
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
    countWins: config.kind === "battles" && config.countWins === true,
  };
}

export function defaultBattleSettings(state, goal) {
  let saved = goal?.boss?.id === state.boss?.id ? goal : null;
  const options = goalDropOptions(state.boss?.reference || state.boss);
  const shopOptions = options.filter(isShopGoalDrop);
  const requirements = (state.openingRequirements || []).filter(
    (target) => Number.isSafeInteger(target.required) && target.required > 0,
  );
  const kills = requirements.filter((target) => target.category === "bosses");
  const remaining = (target) =>
    Math.max(
      0,
      target.required -
        (Number.isSafeInteger(target.current) && target.current >= 0
          ? target.current
          : 0),
    );
  const requiredWins = kills.length ? Math.max(...kills.map(remaining)) : null;
  const materialTarget = requirements.find(
    (target) => target.kind === "business_items",
  );
  if ((requiredWins !== null || materialTarget) && saved?.status !== "active")
    saved = null;
  const duration =
    saved?.durationHours ??
    (saved?.deadlineAt == null
      ? null
      : (saved.deadlineAt - saved.startedAt) / 3600000);
  return {
    kind:
      saved && saved.kind !== "time"
        ? saved.kind
        : materialTarget
          ? "business_items"
          : "battles",
    target: String(
      saved?.targetCount ??
        (materialTarget ? remaining(materialTarget) : requiredWins) ??
        5,
    ),
    countWins: saved?.countWins ?? Boolean(requiredWins),
    itemKey:
      saved?.items?.[0]?.key ??
      materialTarget?.itemKey ??
      options.find((item) => item.type === "activity_item")?.key ??
      "",
    selection:
      saved?.kind === "drops" &&
      saved.items.filter(isShopGoalDrop).length !== shopOptions.length
        ? "selected"
        : "all",
    selectedKeys:
      saved?.kind === "drops"
        ? saved.items.filter(isShopGoalDrop).map((item) => item.key)
        : [],
    hours: saved
      ? [1, 2, 4].includes(duration)
        ? String(duration)
        : "infinite"
      : "1",
  };
}

export function battleSettingsConfig(settings, boss) {
  const options = goalDropOptions(boss.reference || boss);
  const count = Number(settings.target);
  const material =
    options.find(
      (item) => item.type === "activity_item" && item.key === settings.itemKey,
    ) || options.find((item) => item.type === "activity_item");
  const shopOptions = options.filter(isShopGoalDrop);
  const itemKeys =
    settings.selection === "all"
      ? shopOptions.map((item) => item.key)
      : settings.selectedKeys.filter((key) =>
          shopOptions.some((item) => item.key === key),
        );
  if (
    !BOSS_GOAL_KINDS.some((item) => item.value === settings.kind) ||
    (settings.kind !== "drops" &&
      (!Number.isSafeInteger(count) || count <= 0)) ||
    (settings.kind === "business_items" && !material) ||
    (settings.kind === "drops" && !itemKeys.length) ||
    !["1", "2", "4", "infinite"].includes(settings.hours)
  )
    return null;
  return {
    bossId: boss.id,
    kind: settings.kind,
    ...(settings.kind !== "drops" ? { targetCount: count } : {}),
    ...(settings.kind === "battles"
      ? { countWins: settings.countWins === true }
      : {}),
    ...(settings.kind === "business_items" ? { itemKey: material.key } : {}),
    ...(settings.kind === "drops"
      ? {
          selection: settings.selection,
          ...(settings.selection === "selected" ? { itemKeys } : {}),
        }
      : {}),
    durationHours:
      settings.hours === "infinite" ? null : Number(settings.hours),
    maxAttempts:
      settings.kind === "battles" && !settings.countWins ? count : null,
  };
}
