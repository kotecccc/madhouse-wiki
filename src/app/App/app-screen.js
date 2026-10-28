export function screenFromHash(hash) {
  return ["#raids", "#inventory", "#friends", "#queue"].includes(hash)
    ? hash.slice(1)
    : "overview";
}

export function screenFromLocation(path, hash) {
  return !hash && /^\/queue\/?$/.test(path) ? "queue" : screenFromHash(hash);
}

export function screenUrl(screen, search = "") {
  if (screen === "queue") return `/queue${search}`;
  return `/${search}${screen === "overview" ? "" : `#${screen}`}`;
}

export function pageFromPath(path) {
  const battle = /^\/battle\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (battle) return { kind: "battle", id: battle[1] };
  const match = /^\/(boss|work)\/(\d+)\/?$/.exec(path);
  if (!match) return null;
  const id = Number(match[2]);
  return Number.isSafeInteger(id) && id > 0 ? { kind: match[1], id } : null;
}
