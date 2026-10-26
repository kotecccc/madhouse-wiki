export const inventoryCategories = [
  { id: "clothing_item", label: "Одежда" },
  { id: "weapon", label: "Оружие" },
  { id: "pet", label: "Питомцы" },
  { id: "ornament", label: "Тату" },
  { id: "room", label: "Комнаты" },
];
export function inventoryPaths(type, references) {
  if (type === "room") return ["/api/rooms"];
  if (type === "clothing_item") return ["/api/clothing"];
  if (type === "weapon") return ["/api/clothing/by-category/1"];
  if (type === "pet") return ["/api/clothing/by-category/9"];
  if (type === "ornament")
    return [
      ...new Set(
        references
          .filter(
            (item) =>
              item.type === type &&
              Number.isSafeInteger(Number(item.zoneId)) &&
              Number(item.zoneId) > 0,
          )
          .map((item) => `/api/ornaments/zones/${Number(item.zoneId)}`),
      ),
    ];
  return [];
}
const nonnegative = (value) =>
  Number.isFinite(value) && value >= 0 ? value : null;
const list = (value) => (Array.isArray(value) ? value : []);
export function inventoryItems(type, responses, references) {
  const known = new Map(
    references
      .filter((item) => item.type === type)
      .map((item) => [String(item.id), item]),
  );
  const result = new Map();
  for (const path of inventoryPaths(type, references)) {
    const body = responses[path];
    const items =
      type === "room"
        ? list(body?.catalog?.rooms)
        : type === "clothing_item"
          ? list(body?.catalog?.sets).flatMap((set) =>
              list(set?.items).map((item) => ({
                ...item,
                setId: item.setId ?? set.id,
              })),
            )
          : list(body?.items);
    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      if (item.kind && ["weapon", "pet"].includes(type) && item.kind !== type)
        continue;
      const id = item.elementId ?? item.weaponId ?? item.petId ?? item.id;
      if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) continue;
      const reference = known.get(String(id));
      const price = Object.hasOwn(item, "price")
        ? item.price
        : reference?.facts?.purchasePrice;
      const purchasePrice =
        price &&
        Number.isFinite(price.amount) &&
        price.amount >= 0 &&
        ["gold", "dollar", "pills", "stars"].includes(price.currency)
          ? price
          : null;
      // A price or a level requirement alone is never proof of availability.
      const status =
        item.owned === true
          ? "owned"
          : item.owned === false && item.unlocked === true && purchasePrice
            ? "buyable"
            : item.owned === false && item.unlocked === false
              ? "locked"
              : "unknown";
      const currentBonus = item.currentBonus ?? item.currentStats;
      result.set(`${type}:${id}`, {
        ...reference,
        id: String(id),
        type,
        name:
          typeof item.name === "string"
            ? item.name
            : reference?.name || `Предмет №${id}`,
        categoryId: item.categoryId ?? reference?.categoryId,
        setId: item.setId ?? reference?.setId,
        zoneId: item.zoneId ?? reference?.zoneId,
        status,
        equipped: item.equipped === true,
        ownedLevel: item.owned === true ? nonnegative(item.level) : null,
        maxLevel: nonnegative(item.maxLevel ?? reference?.maxLevel),
        durability:
          item.owned === true
            ? nonnegative(
                typeof item.durability === "object" && item.durability !== null
                  ? item.durability.current
                  : item.durability,
              )
            : null,
        durabilityMax: nonnegative(
          item.durability?.max ??
            item.durabilityMax ??
            reference?.durabilityMax,
        ),
        currentStats:
          item.owned === true &&
          currentBonus &&
          typeof currentBonus === "object"
            ? Object.fromEntries(
                Object.entries(currentBonus).filter(
                  ([key, value]) =>
                    [
                      "madness",
                      "aggression",
                      "rage",
                      "endurance",
                      "maxHealth",
                      "baseDamage",
                      "attackCooldownSeconds",
                      "attackCooldownReductionSeconds",
                    ].includes(key) && Number.isFinite(value),
                ),
              )
            : null,
        installedMutagen:
          item.owned === true
            ? normalizeInstalledMutagen(item.installedMutagen)
            : null,
        facts: { ...reference?.facts, purchasePrice },
      });
    }
  }
  return [...result.values()];
}
export function filterInventory(
  items,
  {
    search = "",
    status = "all",
    slot = "all",
    currency = "all",
    sort = "potential",
  } = {},
) {
  const query = search.trim().toLocaleLowerCase("ru");
  return items
    .filter(
      (item) =>
        (!query || item.name.toLocaleLowerCase("ru").includes(query)) &&
        (status === "all" ||
          (status === "equipped" ? item.equipped : item.status === status)) &&
        (slot === "all" ||
          String(item.type === "ornament" ? item.zoneId : item.categoryId) ===
            slot) &&
        (currency === "all" ||
          item.facts?.purchasePrice?.currency === currency),
    )
    .sort((a, b) => {
      const group =
        inventoryGroupOrder(a.status) - inventoryGroupOrder(b.status);
      if (group) return group;
      if (sort === "potential") {
        const ap = inventoryPotential(a),
          bp = inventoryPotential(b);
        if (ap === null || bp === null) {
          if (ap !== bp) return ap === null ? 1 : -1;
        } else {
          const difference = bp.total - ap.total || ap.cooldown - bp.cooldown;
          if (difference) return difference;
        }
      }
      if (sort === "price") {
        const ap = a.facts?.purchasePrice,
          bp = b.facts?.purchasePrice;
        if (!ap || !bp)
          return ap ? -1 : bp ? 1 : a.name.localeCompare(b.name, "ru");
        const diff =
          ap.currency.localeCompare(bp.currency) || ap.amount - bp.amount;
        if (diff) return diff;
      }
      return (
        a.name.localeCompare(b.name, "ru", { numeric: true }) ||
        a.id.localeCompare(b.id)
      );
    });
}

export function inventoryCategoryOptions(responses, references) {
  return inventoryCategories.map(({ id, label }) => {
    const paths = inventoryPaths(id, references);
    const complete = paths.length > 0 && paths.every((path) => responses[path]);
    const count = complete
      ? inventoryItems(id, responses, references).filter(
          (item) => item.status === "buyable",
        ).length
      : 0;
    return {
      value: id,
      label,
      count: count > 0 ? count : undefined,
      ariaLabel: count > 0 ? `${label}: доступно для покупки ${count}` : label,
    };
  });
}

export const inventoryGroups = [
  { status: "buyable", label: "Доступно для покупки" },
  { status: "owned", label: "В инвентаре" },
  { status: "locked", label: "Закрыто" },
  { status: "unknown", label: "Статус неизвестен" },
];
function inventoryGroupOrder(status) {
  const index = inventoryGroups.findIndex((group) => group.status === status);
  return index < 0 ? inventoryGroups.length : index;
}
const potentialStats = [
  "madness",
  "aggression",
  "rage",
  "endurance",
  "maxHealth",
  "baseDamage",
];
export function inventoryPotential(item) {
  const base = item.facts?.stats;
  if (!base || !Object.values(base).some(Number.isFinite)) return null;
  const upgradeable = ["weapon", "pet"].includes(item.type);
  if (
    upgradeable &&
    (!Number.isSafeInteger(item.maxLevel) ||
      item.maxLevel < 0 ||
      !Object.keys(item.facts?.perLevelStats || {}).length)
  )
    return null;
  const levels = upgradeable ? item.maxLevel : 0;
  const increments = item.facts?.perLevelStats || {};
  let total = 0;
  for (const key of potentialStats) {
    const initial = base[key] ?? 0,
      increment = increments[key] ?? 0;
    if (!Number.isFinite(initial) || !Number.isFinite(increment)) return null;
    total += initial + increment * levels;
  }
  const cooldown = Number.isFinite(base.attackCooldownSeconds)
    ? Math.max(
        0,
        base.attackCooldownSeconds -
          (increments.attackCooldownReductionSeconds || 0) * levels,
      )
    : Infinity;
  return Number.isFinite(total) ? { total, cooldown } : null;
}

export function inventoryDisplayStats(item) {
  const base = item.facts?.stats || {};
  const result = Object.fromEntries(
    Object.entries(base).filter(([, value]) => Number.isFinite(value)),
  );
  const level = item.ownedLevel;
  if (
    item.status === "owned" &&
    ["weapon", "pet"].includes(item.type) &&
    Number.isSafeInteger(level) &&
    level >= 0 &&
    (item.maxLevel == null || level <= item.maxLevel)
  ) {
    const increments = item.facts?.perLevelStats || {};
    for (const key of potentialStats) {
      if (Number.isFinite(increments[key]))
        result[key] = (result[key] ?? 0) + increments[key] * level;
    }
    if (
      Number.isFinite(result.attackCooldownSeconds) &&
      Number.isFinite(increments.attackCooldownReductionSeconds)
    ) {
      result.attackCooldownSeconds = Math.max(
        0,
        result.attackCooldownSeconds -
          increments.attackCooldownReductionSeconds * level,
      );
    }
  }
  // Server-provided current values already include upgrades: never add them twice.
  for (const [key, value] of Object.entries(item.currentStats || {})) {
    if (Number.isFinite(value)) result[key] = value;
  }
  return result;
}

export function normalizeInstalledMutagen(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type =
    typeof raw.type === "string" &&
    ["I", "A", "F", "X", "S", "Z", "W"].includes(raw.type.toUpperCase())
      ? raw.type.toUpperCase()
      : null;
  const level =
    Number.isSafeInteger(raw.level) && raw.level > 0 ? raw.level : null;
  const name =
    typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim()
      : type
        ? `Мутаген ${type}${level ? `-${level}` : raw.rank === "Special" ? "-S" : ""}`
        : null;
  return name ? { type, level, name } : null;
}
