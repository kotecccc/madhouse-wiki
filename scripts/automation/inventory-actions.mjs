import { randomUUID } from "node:crypto";

const root = "https://cargohustle.online";
const fail = (status, message) => Object.assign(new Error(message), { status });
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isFinite(value) && value >= 0;
function readFailure(response, message) {
  const status =
    response.status >= 400 && response.status < 500 ? response.status : 503;
  const error = fail(status, message);
  const header = response.headers.get("Retry-After");
  if (header) {
    const delay = /^\d+$/.test(header)
      ? Number(header) * 1000
      : Date.parse(header) - Date.now();
    if (Number.isFinite(delay) && delay >= 0) error.retryAfterMs = delay;
  }
  return error;
}
export const INVENTORY_ACTION_TYPES = {
  weapon: {
    path: "/api/clothing/by-category/1",
    id: "weaponId",
    buy: "/api/weapons/buy",
    equip: "/api/weapons/select",
    method: "PUT",
    remove: "/api/weapons/select",
  },
  pet: {
    path: "/api/clothing/by-category/9",
    id: "petId",
    buy: "/api/pets/buy",
    equip: "/api/pets/select",
    method: "PUT",
    remove: "/api/pets/select",
  },
  room: {
    path: "/api/rooms",
    id: "roomId",
    buy: "/api/rooms/buy",
    equip: "/api/rooms/select",
    method: "PUT",
  },
  clothing_item: {
    path: "/api/clothing",
    id: "itemId",
    buy: "/api/clothing/items/buy",
    equip: "/api/clothing/equip",
    method: "POST",
    remove: "/api/clothing/equip/",
  },
  ornament: {
    id: "elementId",
    buy: "/api/ornaments/elements/buy",
    equip: "/api/ornaments/equip",
    method: "POST",
    remove: "/api/ornaments/equip/",
  },
};
export function inventoryReadPath(type, zoneId, categoryId) {
  const definition = INVENTORY_ACTION_TYPES[type];
  if (!definition) throw fail(400, "invalid_inventory_type");
  if (type === "clothing_item" && categoryId != null) {
    if (!Number.isSafeInteger(categoryId) || categoryId < 2 || categoryId > 8)
      throw fail(400, "invalid_inventory_category");
    return `/api/clothing/by-category/${categoryId}`;
  }
  if (type === "ornament") {
    if (!positive(zoneId)) throw fail(400, "invalid_inventory_zone");
    return `/api/ornaments/zones/${zoneId}`;
  }
  return definition.path;
}
export function inventoryResponseItems(type, body, categoryId) {
  if (!body || body.success === false || body.partial === true || body.error)
    throw fail(503, "inventory_unavailable");
  const items =
    type === "clothing_item"
      ? categoryId != null
        ? body.categoryId === categoryId
          ? body.items
          : null
        : Array.isArray(body.catalog?.sets) &&
            body.catalog.sets.every((set) => Array.isArray(set.items))
          ? body.catalog.sets.flatMap((set) => set.items)
          : null
      : type === "room"
        ? body.catalog?.rooms
        : body.items;
  if (!Array.isArray(items)) throw fail(503, "inventory_unavailable");
  if (
    type === "clothing_item" &&
    categoryId != null &&
    items.some((item) => item?.categoryId !== categoryId)
  )
    throw fail(503, "inventory_unavailable");
  return items.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      (!["weapon", "pet"].includes(type) || !item.kind || item.kind === type),
  );
}
export const inventoryEntityId = (type, item) =>
  Number(
    type === "weapon"
      ? (item.weaponId ?? item.id)
      : type === "pet"
        ? (item.petId ?? item.id)
        : type === "ornament"
          ? (item.elementId ?? item.id)
          : item.id,
  );
export const inventoryEquipped = (type, item) =>
  type === "room" ? item.selected : item.equipped;
function pendingEffectConfirmed(pending, type, item) {
  if (!pending || !item) return false;
  const action =
    pending.action ??
    (typeof pending.equip === "boolean"
      ? pending.equip
        ? "equip"
        : "unequip"
      : null);
  if (action === "buy") return item.owned === true;
  if (action === "repair")
    return (
      Number.isFinite(item.durability?.current) &&
      item.durability.current > 0 &&
      item.durability.current === item.durability.max &&
      item.durability.isBroken !== true
    );
  if (action === "equip") return inventoryEquipped(type, item) === true;
  if (action === "unequip") return inventoryEquipped(type, item) === false;
  return false;
}
export function inventoryPrice(value) {
  return value &&
    nonnegative(value.amount) &&
    ["gold", "dollar", "pills", "stars"].includes(value.currency)
    ? { amount: value.amount, currency: value.currency }
    : null;
}
export async function inventoryRead({
  entry,
  type,
  zoneId,
  categoryId,
  fetcher,
}) {
  const path = inventoryReadPath(type, zoneId, categoryId);
  const response = await fetcher(root + path, {
    headers: { Authorization: entry.credential, Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw readFailure(response, "inventory_unavailable");
  if (response.headers.get("X-Madhouse-Snapshot") === "stale")
    throw fail(503, "inventory_unavailable");
  const text = await response.text();
  if (Buffer.byteLength(text) > 4 * 1024 * 1024)
    throw fail(502, "inventory_response_too_large");
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw fail(503, "inventory_unavailable");
  }
  return { path, body, items: inventoryResponseItems(type, body, categoryId) };
}
export async function inventoryWallet({ entry, body, fetcher }) {
  if (body.player?.wallet && typeof body.player.wallet === "object")
    return body.player.wallet;
  const response = await fetcher(root + "/api/me", {
    headers: { Authorization: entry.credential, Accept: "application/json" },
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw readFailure(response, "inventory_wallet_unavailable");
  if (response.headers.get("X-Madhouse-Snapshot") === "stale")
    throw fail(503, "inventory_wallet_unavailable");
  const profile = await response.json();
  if (profile?.error || profile?.partial === true)
    throw fail(503, "inventory_wallet_unavailable");
  return profile.wallet;
}
export async function inventoryAction({
  entry,
  args,
  commandId,
  refreshOnly = false,
  fetcher,
  save,
  makeOperationId = randomUUID,
  allowed = () => true,
}) {
  const pending = entry.equipment?.pending;
  if (pending && !refreshOnly) throw fail(409, "inventory_action_uncertain");
  const type = refreshOnly
    ? (pending?.type ?? (pending?.weaponId ? "weapon" : args.type))
    : args.type;
  const zoneId = refreshOnly ? (pending?.zoneId ?? args.zoneId) : args.zoneId;
  const definition = INVENTORY_ACTION_TYPES[type];
  if (!definition) throw fail(400, "invalid_inventory_type");
  if (
    !refreshOnly &&
    (!positive(args.id) ||
      !["buy", "equip", "unequip", "repair"].includes(args.action) ||
      (args.action === "repair" && type !== "weapon") ||
      (args.action === "unequip" && !definition.remove))
  )
    throw fail(400, "invalid_inventory_action");
  const categoryId =
    type === "clothing_item"
      ? refreshOnly && pending
        ? pending.categoryId
        : args.categoryId
      : undefined;
  const current = await inventoryRead({
    entry,
    type,
    zoneId,
    categoryId,
    fetcher,
  });
  if (refreshOnly) {
    const itemId = pending?.entityId ?? pending?.weaponId;
    const item = current.items.find(
      (value) => inventoryEntityId(type, value) === itemId,
    );
    if (pending && !pendingEffectConfirmed(pending, type, item))
      return { item: item ?? null, pending: true };
    entry.equipment = { pending: null, checked: true, paths: [current.path] };
    save(entry);
    return {
      item: item ?? null,
      pending: false,
    };
  }
  const item = current.items.find(
    (item) => inventoryEntityId(type, item) === args.id,
  );
  if (!item) throw fail(409, "inventory_item_unknown");
  let price = null;
  if (args.action === "buy") {
    if (item.owned !== false || item.unlocked !== true)
      throw fail(409, "inventory_item_not_buyable");
    price = inventoryPrice(item.price);
  } else {
    if (item.owned !== true) throw fail(409, "inventory_item_not_owned");
    const equipped = inventoryEquipped(type, item);
    if (args.action === "equip" && equipped === true) {
      entry.equipment = { pending: null, checked: true, paths: [current.path] };
      save(entry);
      return;
    }
    if (args.action === "unequip" && equipped !== true)
      throw fail(409, "inventory_equipment_changed");
    if (args.action === "equip" && equipped !== false)
      throw fail(409, "inventory_equipment_unknown");
    if (args.action === "repair") {
      if (item.durability?.isBroken !== true && item.durability?.current !== 0)
        throw fail(409, "inventory_weapon_not_broken");
      price = nonnegative(item.durability?.repairCost)
        ? { currency: "pills", amount: item.durability.repairCost }
        : null;
    }
  }
  if (["buy", "repair"].includes(args.action)) {
    const expected = inventoryPrice(args.price);
    if (
      !price ||
      !expected ||
      price.amount !== expected.amount ||
      price.currency !== expected.currency
    )
      throw fail(409, "inventory_price_changed");
    const wallet = await inventoryWallet({
      entry,
      body: current.body,
      fetcher,
    });
    if (!wallet || !nonnegative(wallet[price.currency]))
      throw fail(409, "inventory_balance_unknown");
    if (wallet[price.currency] < price.amount)
      throw fail(409, "inventory_balance_insufficient");
    // Automatic repair must recheck the strict threshold immediately before reserving spend.
    if (
      args.automatic === true &&
      (price.currency !== "pills" || wallet.pills <= 5000)
    )
      throw fail(409, "inventory_auto_repair_reserve");
  }
  if (
    args.action === "equip" &&
    type === "weapon" &&
    (item.durability?.isBroken === true || item.durability?.current === 0)
  )
    throw fail(409, "inventory_weapon_broken");
  if (!allowed()) throw fail(409, "inventory_action_cancelled");
  const operationId = ["buy", "repair"].includes(args.action)
    ? makeOperationId()
    : null;
  const actionPath =
    args.action === "buy"
      ? definition.buy
      : args.action === "repair"
        ? "/api/weapons/repair"
        : args.action === "equip"
          ? definition.equip
          : definition.remove.endsWith("/")
            ? definition.remove + args.id
            : definition.remove;
  const method =
    args.action === "buy" || args.action === "repair"
      ? "POST"
      : args.action === "unequip"
        ? "DELETE"
        : definition.method;
  const body =
    args.action === "unequip"
      ? undefined
      : { [definition.id]: args.id, ...(operationId ? { operationId } : {}) };
  entry.equipment = {
    pending: {
      id: commandId,
      type,
      zoneId: zoneId ?? null,
      ...(categoryId != null ? { categoryId } : {}),
      entityId: args.id,
      action: args.action,
      operationId,
      price,
    },
    checked: false,
    paths: [current.path],
  };
  save(entry);
  if (entry.storageFailed) throw fail(503, "automation_storage_unavailable");
  let mutationReturned = false;
  try {
    if (!allowed()) {
      entry.equipment.pending = null;
      save(entry);
      throw fail(409, "inventory_action_cancelled");
    }
    const response = await fetcher(root + actionPath, {
      method,
      headers: {
        Authorization: entry.credential,
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(20000),
      canDispatch: allowed,
    });
    mutationReturned = true;
    if (!response.ok) {
      if (
        response.status >= 400 &&
        response.status < 500 &&
        response.status !== 429
      ) {
        entry.equipment.pending = null;
        save(entry);
      }
      throw readFailure(response, "inventory_action_failed");
    }
    await response.body?.cancel();
    const confirmed = await inventoryRead({
      entry,
      type,
      zoneId,
      categoryId,
      fetcher,
    });
    const after = confirmed.items.find(
      (item) => inventoryEntityId(type, item) === args.id,
    );
    const confirmedAction =
      after &&
      (args.action === "buy"
        ? after.owned === true
        : args.action === "repair"
          ? nonnegative(after.durability?.current) &&
            after.durability.current > 0 &&
            after.durability.current === after.durability.max &&
            after.durability.isBroken !== true
          : inventoryEquipped(type, after) === (args.action === "equip"));
    if (!confirmedAction) throw fail(409, "inventory_action_unconfirmed");
    entry.equipment = { pending: null, checked: true, paths: [current.path] };
    save(entry);
  } catch (error) {
    // The account lane proves this request never reached the game.
    if (!mutationReturned && error?.notDispatched)
      entry.equipment.pending = null;
    save(entry);
    throw error;
  }
}
