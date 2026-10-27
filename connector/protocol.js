export const CHANNEL = "madhouse-wiki-connection";
export const VERSION = 2;
export const ACTIONS = [
  "status",
  "connect-game",
  "logout",
  "cancel",
  "ui-action",
];
export const UI_COMMANDS = [
  "enable-footer",
  "choose-phone",
  "choose-qr",
  "back",
  "submit",
  "logout",
];
export const UI_STAGES = [
  "loading",
  "waiting",
  "consent",
  "wrong-account",
  "phone",
  "code",
  "password",
  "qr",
  "busy",
  "connected",
  "retry",
  "unavailable",
];

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
        "wikiInitData",
        "restoreRequestId",
        "requestId",
        "command",
      ].includes(key),
    ) &&
    data.channel === CHANNEL &&
    data.version === VERSION &&
    typeof data.id === "string" &&
    /^[a-f0-9-]{36}$/.test(data.id) &&
    ACTIONS.includes(data.action) &&
    (data.expectedUserId == null || /^\d{1,20}$/.test(data.expectedUserId)) &&
    (data.interactive == null || typeof data.interactive === "boolean") &&
    (data.wikiInitData == null ||
      (typeof data.wikiInitData === "string" &&
        data.wikiInitData.length <= 8192)) &&
    (data.restoreRequestId == null ||
      (data.action === "connect-game" &&
        data.interactive === true &&
        typeof data.restoreRequestId === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
          data.restoreRequestId,
        ))) &&
    (data.action === "ui-action"
      ? /^[a-f0-9-]{36}$/.test(data.requestId || "") &&
        UI_COMMANDS.includes(data.command) &&
        data.expectedUserId == null &&
        data.interactive == null &&
        data.wikiInitData == null
      : data.requestId == null && data.command == null)
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
