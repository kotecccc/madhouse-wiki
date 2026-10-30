export function inventoryGame({
  pills = 10000,
  owned = false,
  equipped = false,
  broken = false,
  cost = 30,
  failMutation = false,
  failConfirmation = false,
  unknownCost = false,
  beforeMutation = () => {},
  stale = false,
} = {}) {
  const types = ["weapon", "pet", "room", "clothing_item", "ornament"];
  const items = Object.fromEntries(
    types.map((type, i) => [
      type,
      {
        id: i + 1,
        ...(type === "weapon"
          ? { kind: type, weaponId: i + 1 }
          : type === "pet"
            ? { kind: type, petId: i + 1 }
            : type === "ornament"
              ? { elementId: i + 1 }
              : {}),
        name: type,
        owned,
        equipped,
        selected: equipped,
        unlocked: true,
        zoneId: 4,
        categoryId: 3,
        price: { currency: "gold", amount: 100 },
        ...(type === "weapon"
          ? {
              durability: {
                current: broken ? 0 : 90,
                max: 90,
                isBroken: broken,
                ...(unknownCost ? {} : { repairCost: cost }),
              },
            }
          : {}),
      },
    ]),
  );
  const wallet = { gold: 10000, dollar: 10000, pills, stars: 10000 };
  const calls = [];
  let changed = false;
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname,
      method = init.method || "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    if (method === "GET") {
      if (changed && failConfirmation) throw new Error("confirmation_lost");
      let value;
      if (path === "/api/me") value = { playerId: 1, wallet };
      else if (path === "/api/rooms")
        value = { catalog: { rooms: [items.room] }, player: { wallet } };
      else if (path === "/api/clothing")
        value = {
          catalog: { sets: [{ id: 1, items: [items.clothing_item] }] },
          player: { wallet },
        };
      else if (path === "/api/clothing/by-category/3")
        value = {
          success: true,
          categoryId: 3,
          items: [items.clothing_item],
          player: { wallet },
        };
      else if (path.startsWith("/api/ornaments/zones/"))
        value = { success: true, items: [items.ornament] };
      else if (path === "/api/clothing/by-category/1")
        value = { success: true, items: [items.weapon], player: { wallet } };
      else if (path === "/api/clothing/by-category/9")
        value = { success: true, items: [items.pet], player: { wallet } };
      else throw new Error(`unexpected_read:${path}`);
      return Response.json(value, {
        headers: stale ? { "X-Madhouse-Snapshot": "stale" } : {},
      });
    }
    beforeMutation({ path, method, body });
    if (failMutation === "reject")
      return Response.json({ error: "rejected" }, { status: 400 });
    if (failMutation) throw new Error("submission_lost");
    const type = path.startsWith("/api/weapons/")
      ? "weapon"
      : path.startsWith("/api/pets/")
        ? "pet"
        : path.startsWith("/api/rooms/")
          ? "room"
          : path.startsWith("/api/ornaments/")
            ? "ornament"
            : "clothing_item";
    const item = items[type];
    if (path.endsWith("/buy")) {
      item.owned = true;
      wallet[item.price.currency] -= item.price.amount;
    } else if (path.endsWith("/repair")) {
      wallet.pills -= item.durability.repairCost;
      item.durability.current = item.durability.max;
      item.durability.isBroken = false;
      item.durability.repairCost = 0;
    } else {
      item.equipped = method !== "DELETE";
      item.selected = item.equipped;
    }
    changed = true;
    return Response.json({ success: true });
  };
  return {
    fetcher,
    items,
    wallet,
    calls,
    mutations: () => calls.filter((call) => call.method !== "GET"),
  };
}
