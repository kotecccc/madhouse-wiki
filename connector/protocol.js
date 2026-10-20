export const CHANNEL = "madhouse-wiki-connection";
export const VERSION = 1;
export const ACTIONS = ["status", "connect-game", "logout", "cancel"];

export function connectorOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/" ||
      (url.protocol !== "https:" &&
        !(url.protocol === "http:" && url.hostname === "127.0.0.1"))
    )
      return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function validRequest(data) {
  return (
    !!data &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    Object.keys(data).every((key) =>
      [
        "channel",
        "version",
        "id",
        "action",
        "expectedUserId",
        "interactive",
      ].includes(key),
    ) &&
    data.channel === CHANNEL &&
    data.version === VERSION &&
    typeof data.id === "string" &&
    /^[a-f0-9-]{36}$/.test(data.id) &&
    ACTIONS.includes(data.action) &&
    (data.expectedUserId == null || /^\d{1,20}$/.test(data.expectedUserId)) &&
    (data.interactive == null || typeof data.interactive === "boolean")
  );
}

// Each accepted command is consumed exactly once, including failed commands.
export function createMessageGate({ origins, parent, limit = 256 }) {
  const seen = new Set();
  return (event) => {
    if (
      event.source !== parent ||
      !origins.includes(event.origin) ||
      !validRequest(event.data)
    )
      return false;
    if (seen.has(event.data.id) || seen.size >= limit) return false;
    seen.add(event.data.id);
    return true;
  };
}
