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
    sort = "name",
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
      label: count > 0 ? `${label} (${count})` : label,
      ariaLabel: count > 0 ? `${label}: доступно для покупки ${count}` : label,
    };
  });
}
