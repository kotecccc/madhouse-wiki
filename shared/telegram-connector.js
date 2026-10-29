import {
  CHANNEL,
  UI_COMMANDS,
  UI_STAGES,
  VERSION,
  connectorOrigin,
} from "../connector/protocol.js";
import { normalizeActiveBossBattle } from "./active-boss-battle.js";

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
  onUiState = () => {},
  onRevocationFailure = () => {},
  randomId = () => crypto.randomUUID(),
  timeout = 300000,
}) {
  origin = connectorOrigin(origin);
  if (!origin) throw new Error("invalid_connector_origin");
  let ready = false,
    pending = null,
    generation = 0,
    activeUiRequestId = null;
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
      data.kind === "ui-state" &&
      activeUiRequestId &&
      data.requestId === activeUiRequestId &&
      Object.keys(data).every((key) =>
        [
          "channel",
          "version",
          "kind",
          "requestId",
          "stage",
          "busy",
          "canSubmit",
          "height",
          "hostedControls",
        ].includes(key),
      ) &&
      UI_STAGES.includes(data.stage) &&
      typeof data.busy === "boolean" &&
      typeof data.canSubmit === "boolean" &&
      Number.isInteger(data.height) &&
      data.height >= 1 &&
      data.height <= 2000 &&
      typeof data.hostedControls === "boolean"
    ) {
      onUiState({
        requestId: data.requestId,
        stage: data.stage,
        busy: data.busy,
        canSubmit: data.canSubmit,
        height: data.height,
        hostedControls: data.hostedControls,
      });
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
          "wikiSession",
          "wikiSessionExpiresAt",
          "gameConnection",
          "playerLevel",
          "currentExp",
          "expToNextLevel",
          "activeBossBattle",
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
      ![
        "connected",
        "disconnected",
        "wiki-connected",
        "login-required",
        "pending",
        "failed",
      ].includes(data.status)
    )
      return;
    if (
      data.accessToken != null &&
      (typeof data.accessToken !== "string" || data.accessToken.length > 16384)
    )
      return;
    if (
      data.playerLevel != null &&
      (!Number.isSafeInteger(data.playerLevel) || data.playerLevel < 1)
    )
      return;
    if (
      data.currentExp != null &&
      (!Number.isSafeInteger(data.currentExp) || data.currentExp < 0)
    )
      return;
    if (
      data.expToNextLevel != null &&
      (!Number.isSafeInteger(data.expToNextLevel) || data.expToNextLevel < 1)
    )
      return;
    if ((data.currentExp == null) !== (data.expToNextLevel == null)) return;
    if (
      pending.message.action === "connect-game" &&
      data.status === "connected" &&
      !data.accessToken
    )
      return;
    if (
      data.status === "pending" &&
      (pending.message.action !== "connect-game" || data.accessToken)
    )
      return;
    if (data.accessToken && data.status !== "connected") return;
    if (
      (data.playerLevel != null || data.currentExp != null) &&
      data.status !== "connected"
    )
      return;
    if (data.currentExp != null && data.status !== "connected") return;
    if (data.expToNextLevel != null && data.status !== "connected") return;
    if (data.activeBossBattle != null && data.status !== "connected") return;
    if (pending.message.action !== "connect-game" && data.accessToken) return;
    if (
      data.wikiSession != null &&
      (typeof data.wikiSession !== "string" ||
        data.wikiSession.length < 1 ||
        data.wikiSession.length > 4096 ||
        pending.message.action !== "connect-game" ||
        !["connected", "wiki-connected"].includes(data.status) ||
        !Number.isFinite(data.wikiSessionExpiresAt) ||
        data.wikiSessionExpiresAt <= 0)
    )
      return;
    if (
      data.wikiSessionExpiresAt != null &&
      (!data.wikiSession ||
        !Number.isFinite(data.wikiSessionExpiresAt) ||
        data.wikiSessionExpiresAt <= 0)
    )
      return;
    if (
      data.gameConnection != null &&
      !["connected", "login-required"].includes(data.gameConnection)
    )
      return;
    if (
      data.status === "wiki-connected" &&
      (pending.message.action !== "connect-game" ||
        !data.wikiSession ||
        !data.wikiSessionExpiresAt ||
        data.gameConnection !== "login-required" ||
        data.accessToken)
    )
      return;
    if (
      data.status === "connected" &&
      data.gameConnection != null &&
      data.gameConnection !== "connected"
    )
      return;
    if (
      data.gameConnection === "login-required" &&
      !["wiki-connected", "login-required"].includes(data.status)
    )
      return;
    if (data.status === "failed") finish(new Error("connection_failed"));
    else
      finish(null, {
        status: data.status,
        accessToken: data.accessToken,
        wikiSession: data.wikiSession,
        wikiSessionExpiresAt: data.wikiSessionExpiresAt,
        gameConnection: data.gameConnection,
        playerLevel: data.playerLevel,
        currentExp: data.currentExp,
        expToNextLevel: data.expToNextLevel,
        activeBossBattle: normalizeActiveBossBattle(data.activeBossBattle),
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
    activeUiRequestId = null;
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
      activeUiRequestId =
        action === "connect-game" && interactive ? message.id : null;
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
    uiAction(command, requestId) {
      if (
        !UI_COMMANDS.includes(command) ||
        !/^[a-f0-9-]{36}$/.test(requestId || "") ||
        requestId !== activeUiRequestId
      )
        return false;
      send({
        channel: CHANNEL,
        version: VERSION,
        id: randomId(),
        action: "ui-action",
        requestId,
        command,
      });
      return true;
    },
    cancel,
    destroy({ preserveRemoteSession = false } = {}) {
      if (preserveRemoteSession) {
        generation++;
        finish(new Error("cancelled"));
      } else cancel();
      unlisten(receive);
    },
  };
}
