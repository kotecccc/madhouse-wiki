import { CHANNEL, VERSION, connectorOrigin } from "../connector/protocol.js";

export const AUTO_CONNECT_KEY = "madhouse.wiki.telegram-connected";
export const CONNECTION_EPOCH_KEY = "madhouse.wiki.connection-generation";

// A client-side account mismatch hint, never proof of identity or API access.
// Capture it at startup, before Wiki's own anchor links replace the launch hash.
export function telegramUserHint(browserWindow) {
  try {
    const sdkId = browserWindow?.Telegram?.WebApp?.initDataUnsafe?.user?.id;
    if (Number.isSafeInteger(sdkId) && sdkId > 0) return String(sdkId);
    const launch = new URLSearchParams(browserWindow?.location?.hash?.slice(1));
    const raw = launch.get("tgWebAppData");
    if (!raw) return undefined;
    const id = JSON.parse(new URLSearchParams(raw).get("user"))?.id;
    return Number.isSafeInteger(id) && id > 0 ? String(id) : undefined;
  } catch {
    return undefined;
  }
}

export function createConnectorBridge({
  origin,
  source,
  listen,
  unlisten,
  onInteraction = () => {},
  onRevocationFailure = () => {},
  randomId = () => crypto.randomUUID(),
  timeout = 300000,
}) {
  origin = connectorOrigin(origin);
  if (!origin) throw new Error("invalid_connector_origin");
  let ready = false,
    pending = null,
    generation = 0;
  const cancelled = new Set();
  const send = (data) => source()?.postMessage(data, origin);
  const finish = (error, result) => {
    if (!pending) return;
    const current = pending;
    pending = null;
    clearTimeout(current.timer);
    if (error) current.reject(error);
    else current.resolve(result);
  };
  const transmit = () => {
    if (ready && pending && !pending.sent) {
      pending.sent = true;
      send(pending.message);
    }
  };
  const receive = (event) => {
    const data = event.data;
    if (
      event.origin !== origin ||
      event.source !== source() ||
      !data ||
      typeof data !== "object" ||
      Array.isArray(data) ||
      data.channel !== CHANNEL ||
      data.version !== VERSION
    )
      return;
    if (
      data.kind === "ready" &&
      Object.keys(data).every((key) =>
        ["channel", "version", "kind"].includes(key),
      )
    ) {
      ready = true;
      transmit();
      return;
    }
    if (
      cancelled.has(data.id) &&
      data.kind === "result" &&
      data.status === "disconnected" &&
      !data.accessToken
    ) {
      cancelled.delete(data.id);
      if (data.remoteRevoked !== true || data.localCleared !== true)
        onRevocationFailure();
      return;
    }
    if (
      !pending ||
      data.id !== pending.message.id ||
      pending.generation !== generation ||
      !Object.keys(data).every((key) =>
        [
          "channel",
          "version",
          "id",
          "kind",
          "status",
          "accessToken",
          "remoteRevoked",
          "localCleared",
        ].includes(key),
      )
    )
      return;
    if (
      data.kind === "interaction-required" &&
      data.status === "login-required" &&
      !data.accessToken
    ) {
      if (pending.message.interactive) onInteraction();
      return;
    }
    if (
      data.kind !== "result" ||
      !["connected", "disconnected", "login-required", "failed"].includes(
        data.status,
      )
    )
      return;
    if (
      data.accessToken != null &&
      (typeof data.accessToken !== "string" || data.accessToken.length > 16384)
    )
      return;
    if (
      pending.message.action === "connect-game" &&
      data.status === "connected" &&
      !data.accessToken
    )
      return;
    if (pending.message.action !== "connect-game" && data.accessToken) return;
    if (data.status === "failed") finish(new Error("connection_failed"));
    else
      finish(null, {
        status: data.status,
        accessToken: data.accessToken,
        remoteRevoked: data.remoteRevoked === true,
        localCleared: data.localCleared === true,
      });
  };
  listen(receive);
  function sendCancel() {
    if (!ready) return;
    const id = randomId();
    if (cancelled.size >= 256)
      cancelled.delete(cancelled.values().next().value);
    cancelled.add(id);
    send({ channel: CHANNEL, version: VERSION, id, action: "cancel" });
  }
  function cancel() {
    generation++;
    sendCancel();
    finish(new Error("cancelled"));
  }
  return {
    request(
      action,
      { expectedUserId, wikiInitData, interactive = false } = {},
    ) {
      if (!["status", "connect-game", "logout"].includes(action))
        return Promise.reject(new Error("invalid_action"));
      if (
        pending &&
        action === "connect-game" &&
        pending.message.action === action &&
        pending.message.interactive === interactive &&
        pending.message.expectedUserId ===
          (expectedUserId ? String(expectedUserId) : undefined)
      )
        return pending.promise;
      if (pending) cancel();
      const message = {
        channel: CHANNEL,
        version: VERSION,
        id: randomId(),
        action,
        interactive,
      };
      if (expectedUserId) message.expectedUserId = String(expectedUserId);
      if (wikiInitData) message.wikiInitData = wikiInitData;
      const entry = { message, generation, sent: false };
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      entry.timer = setTimeout(
        () => {
          if (pending !== entry) return;
          generation++;
          sendCancel();
          finish(new Error("connection_timeout"));
        },
        action === "logout" ? 150000 : interactive ? timeout : 45000,
      );
      pending = entry;
      transmit();
      return entry.promise;
    },
    cancel,
    destroy() {
      cancel();
      unlisten(receive);
    },
  };
}
