const collectibleTypes = new Set([
  "room",
  "weapon",
  "pet",
  "clothing_item",
  "ornament",
]);

function positiveId(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

function dropId(drop) {
  const candidates =
    drop.type === "ornament"
      ? [drop.elementId, drop.entityId, drop.id]
      : [drop.itemId, drop.entityId, drop.id];
  for (const value of candidates) {
    const id = positiveId(value);
    if (id) return id;
  }
  return null;
}

function responseAt(responses, path) {
  if (responses instanceof Map) return responses.get(path);
  return responses && typeof responses === "object"
    ? responses[path]
    : undefined;
}

function requestPath(drop) {
  const id = dropId(drop);
  if (!id) return null;
  switch (drop.type) {
    case "clothing_item":
      return "/api/clothing";
    case "room":
      return "/api/rooms";
    case "weapon":
    case "pet":
      return `/api/${drop.type === "pet" ? "pets" : "weapons"}/${id}`;
    case "ornament": {
      const zoneId = positiveId(drop.zoneId);
      return zoneId ? `/api/ornaments/zones/${zoneId}` : null;
    }
    default:
      return null;
  }
}

function responseItems(drop, body) {
  if (!body || typeof body !== "object") return [];
  if (drop.type === "clothing_item") {
    const sets = body.catalog?.sets;
    return Array.isArray(sets)
      ? sets.flatMap((set) => (Array.isArray(set?.items) ? set.items : []))
      : [];
  }
  if (drop.type === "room") {
    const rooms = body.catalog?.rooms;
    return Array.isArray(rooms) ? rooms : [];
  }
  if (drop.type === "ornament")
    return Array.isArray(body.items) ? body.items : [];
  const detail = body[drop.type];
  return detail && typeof detail === "object" ? [detail] : [];
}

function itemId(drop, item) {
  if (drop.type === "ornament") return positiveId(item?.elementId ?? item?.id);
  if (drop.type === "weapon") return positiveId(item?.weaponId ?? item?.id);
  if (drop.type === "pet") return positiveId(item?.petId ?? item?.id);
  return positiveId(item?.id);
}

function collectionState(drop, item) {
  if (drop.mode === "unlock_for_purchase") {
    if (item.unlocked === true || item.owned === true) return true;
    if (item.unlocked === false && item.owned === false) return false;
    return null;
  }
  if (drop.mode === "grant")
    return typeof item.owned === "boolean" ? item.owned : null;
  return null;
}

/** Keep only collectible boss rewards and collapse repeated type/ID pairs. */
export function getBossCollectibleDrops(boss) {
  const seen = new Set();
  const result = [];
  for (const [index, drop] of (Array.isArray(boss?.possibleDrops)
    ? boss.possibleDrops
    : []
  ).entries()) {
    if (!drop || !collectibleTypes.has(drop.type)) continue;
    const id = dropId(drop);
    const key = id ? `${drop.type}:${id}` : `${drop.type}:unknown:${index}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      type: drop.type,
      id,
      ...(typeof drop.mode === "string" ? { mode: drop.mode } : {}),
      ...(drop.categoryId != null ? { categoryId: drop.categoryId } : {}),
      ...(drop.zoneId != null ? { zoneId: drop.zoneId } : {}),
    });
  }
  return result;
}

/** Return deduplicated, deterministic reference/ownership lookup paths. */
export function getCollectionRequests(drops) {
  const paths = new Set();
  for (const drop of Array.isArray(drops) ? drops : []) {
    const path = requestPath(drop);
    if (path) paths.add(path);
  }
  return [...paths];
}

/** Summarize only explicit ownership/unlock flags; absent data stays unknown. */
export function summarizeBossCollection(boss, responses) {
  const drops = getBossCollectibleDrops(boss);
  let collected = 0;
  let known = 0;
  for (const drop of drops) {
    const path = requestPath(drop);
    if (!path) continue;
    const matches = responseItems(drop, responseAt(responses, path)).filter(
      (item) => itemId(drop, item) === drop.id,
    );
    if (matches.length === 0) continue;
    const states = new Set(matches.map((item) => collectionState(drop, item)));
    if (states.size !== 1) continue;
    const [state] = states;
    if (state === null) continue;
    known++;
    if (state) collected++;
  }
  const total = drops.length;
  return {
    total,
    collected,
    known,
    complete: total > 0 && known === total && collected === total,
  };
}
