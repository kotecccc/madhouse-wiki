export const GAME_HEALTH_FEATURES = Object.freeze([
  "profile",
  "inventory",
  "floors",
  "rooms",
  "clothing",
  "weapons",
  "pets",
  "ornaments",
  "businesses",
  "bosses",
  "friends",
  "game",
]);

export function safeFailedFeatures(value) {
  return Array.isArray(value)
    ? GAME_HEALTH_FEATURES.filter((feature) => value.includes(feature))
    : [];
}

export function safeSuccessfulFeatures(value, failed = []) {
  const unsafeFailed = new Set(safeFailedFeatures(failed));
  return Array.isArray(value)
    ? GAME_HEALTH_FEATURES.filter(
        (feature) => value.includes(feature) && !unsafeFailed.has(feature),
      )
    : [];
}

// Only fixed function identifiers leave the server, never paths or game IDs.
export function featureForGamePath(path) {
  if (path === "/api/me") return "profile";
  if (path === "/api/me/bag" || path === "/api/stash/sets") return "inventory";
  if (path === "/api/clothing/by-category/1") return "weapons";
  if (path === "/api/clothing/by-category/9") return "pets";
  if (path === "/api/friends") return "friends";
  for (const [prefix, feature] of [
    ["floors", "floors"],
    ["rooms", "rooms"],
    ["clothing", "clothing"],
    ["weapons", "weapons"],
    ["pets", "pets"],
    ["ornaments", "ornaments"],
    ["businesses", "businesses"],
    ["bosses", "bosses"],
  ]) {
    if (path === `/api/${prefix}` || path?.startsWith(`/api/${prefix}/`))
      return feature;
  }
  return "game";
}

// Work execution depends on fresh work/profile/bag reads, not wardrobe sections.
// Missing failure detail remains a global outage; credentials always fail closed.
export function workGameUnavailable(health) {
  if (health?.status === "credentials_invalid") return true;
  if (health?.status !== "unavailable") return false;
  const failed = safeFailedFeatures(health.failedFeatures);
  return (
    !failed.length ||
    failed.some((feature) => ["game", "profile", "inventory"].includes(feature))
  );
}
