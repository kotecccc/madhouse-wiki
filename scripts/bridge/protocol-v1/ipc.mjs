import {
  assertEnum,
  assertInteger,
  assertStringBytes,
  assertUniqueEnumArray,
  assertUuid,
  exactKeys,
  fail,
  isRecord,
} from "./common.mjs";

export const IPC_DIAGNOSTIC_CATEGORIES = Object.freeze([
  "transport",
  "safe_errors",
  "versions",
]);
export const IPC_ERROR_CODES = Object.freeze([
  "invalid_request",
  "not_authorized",
  "device_offline",
  "device_revoked",
  "consent_required",
  "vault_unavailable",
  "telegram_unavailable",
  "storage_unavailable",
  "operation_pending",
  "update_required",
  "bridge_unavailable",
  "pairing_code_invalid",
  "pairing_not_found",
  "pairing_expired",
  "pairing_already_pending",
  "idempotency_conflict",
  "device_already_registered",
  "device_limit_reached",
  "device_history_limit_reached",
  "device_generation_conflict",
  "rate_limited",
  "telegram_session_required",
  "telegram_login_failed",
  "telegram_owner_mismatch",
  "telegram_logout_failed",
]);

const REQUEST_TYPES = Object.freeze([
  "status.get",
  "pairing.start",
  "pairing.status",
  "pairing.cancel",
  "consent.set",
  "telegram.login.start",
  "telegram.login.status",
  "telegram.login.reply",
  "telegram.login.cancel",
  "telegram.status.get",
  "telegram.logout",
  "startup.settings.get",
  "startup.settings.set",
  "update.check",
  "update.install",
  "game.status.check",
  "device.pause",
  "device.resume",
  "device.disconnect",
  "wiki.open",
  "diagnostics.export",
]);

function requestId(value) {
  assertUuid(value);
}

export function parseIpcRequest(request) {
  if (!isRecord(request)) fail();
  assertEnum(request.type, REQUEST_TYPES);
  switch (request.type) {
    case "status.get":
    case "telegram.status.get":
    case "telegram.logout":
    case "startup.settings.get":
    case "update.check":
    case "update.install":
    case "game.status.check":
    case "device.pause":
    case "device.resume":
    case "device.disconnect":
    case "wiki.open":
      exactKeys(request, [
        "type",
        "requestId",
        ...(request.type === "wiki.open" ? ["destination"] : []),
      ]);
      requestId(request.requestId);
      if (request.type === "wiki.open")
        assertEnum(request.destination, ["wiki", "wiki-help"]);
      break;
    case "startup.settings.set":
      exactKeys(request, ["type", "requestId", "enabled"]);
      requestId(request.requestId);
      if (typeof request.enabled !== "boolean") fail();
      break;
    case "telegram.login.start":
      exactKeys(request, ["type", "requestId"], ["method"]);
      requestId(request.requestId);
      if (Object.hasOwn(request, "method"))
        assertEnum(request.method, ["phone", "qr"]);
      break;
    case "telegram.login.status":
      exactKeys(request, ["type", "requestId", "loginId"]);
      requestId(request.requestId);
      assertUuid(request.loginId);
      break;
    case "pairing.start":
      exactKeys(request, ["type", "requestId", "deviceName"]);
      requestId(request.requestId);
      assertStringBytes(request.deviceName, { min: 1, max: 80 });
      break;
    case "pairing.status":
      exactKeys(request, ["type", "requestId"]);
      requestId(request.requestId);
      break;
    case "pairing.cancel":
      exactKeys(request, ["type", "requestId", "pairingId"]);
      requestId(request.requestId);
      assertUuid(request.pairingId);
      break;
    case "consent.set":
      exactKeys(request, ["type", "requestId", "enabled"]);
      requestId(request.requestId);
      if (typeof request.enabled !== "boolean") fail();
      break;
    case "telegram.login.reply":
      exactKeys(request, [
        "type",
        "requestId",
        "loginId",
        "challengeId",
        "challengeType",
        "response",
      ]);
      requestId(request.requestId);
      assertUuid(request.loginId);
      assertUuid(request.challengeId);
      assertEnum(request.challengeType, ["phone", "code", "password"]);
      assertStringBytes(request.response, { min: 1, max: 512 });
      break;
    case "telegram.login.cancel":
      exactKeys(request, ["type", "requestId", "loginId"]);
      requestId(request.requestId);
      assertUuid(request.loginId);
      break;
    case "diagnostics.export":
      exactKeys(request, ["type", "requestId", "categories"]);
      requestId(request.requestId);
      assertUniqueEnumArray(request.categories, IPC_DIAGNOSTIC_CATEGORIES, 3);
      break;
    default:
      fail("unsupported_operation");
  }
  return request;
}

export function parseIpcResponse(response) {
  if (!isRecord(response)) fail();
  requestId(response.requestId);
  switch (response.type) {
    case "status.result":
      exactKeys(response, [
        "type",
        "requestId",
        "pairingStatus",
        "deviceStatus",
        "gameStatus",
        "helperStatus",
        "pauseReasons",
      ]);
      assertEnum(response.pairingStatus, [
        "not_paired",
        "pending",
        "approved",
        "unavailable",
      ]);
      assertEnum(response.deviceStatus, [
        "starting",
        "online",
        "offline",
        "revoked",
        "update_required",
      ]);
      assertEnum(response.gameStatus, [
        "unknown",
        "not_connected",
        "checking",
        "ready",
        "auth_required",
        "paused",
      ]);
      assertEnum(response.helperStatus, ["running", "paused", "stopped"]);
      assertUniqueEnumArray(
        response.pauseReasons,
        [
          "device_offline",
          "auth_required",
          "unknown_attempt",
          "storage_unavailable",
          "draining",
          "user_paused",
          "revoked",
          "update_required",
        ],
        7,
      );
      break;
    case "pairing.result":
      if (response.status === "created") {
        exactKeys(response, [
          "type",
          "requestId",
          "status",
          "pairingId",
          "displayCode",
          "expiresAtMs",
        ]);
        assertUuid(response.pairingId);
        assertStringBytes(response.displayCode, {
          min: 6,
          max: 6,
          pattern: /^[A-Z0-9]{6}$/,
        });
        assertInteger(response.expiresAtMs, { min: 1 });
      } else {
        exactKeys(response, ["type", "requestId", "status", "pairingId"]);
        assertEnum(response.status, ["cancelled", "expired"]);
        assertUuid(response.pairingId);
      }
      break;
    case "pairing.status.result":
      exactKeys(
        response,
        ["type", "requestId", "pairingId", "status"],
        ["deviceGeneration", "displayCode", "expiresAtMs"],
      );
      assertUuid(response.pairingId);
      assertEnum(response.status, [
        "pending",
        "approved",
        "cancelled",
        "expired",
      ]);
      if (response.status === "approved") {
        assertInteger(response.deviceGeneration, { min: 1 });
        if (
          Object.hasOwn(response, "displayCode") ||
          Object.hasOwn(response, "expiresAtMs")
        )
          fail();
      } else if (response.status === "pending") {
        assertStringBytes(response.displayCode, {
          min: 6,
          max: 6,
          pattern: /^[A-Z0-9]{6}$/u,
        });
        assertInteger(response.expiresAtMs, { min: 1 });
        if (Object.hasOwn(response, "deviceGeneration")) fail();
      } else if (
        Object.hasOwn(response, "deviceGeneration") ||
        Object.hasOwn(response, "displayCode") ||
        Object.hasOwn(response, "expiresAtMs")
      )
        fail();
      break;
    case "pairing.cancel.result":
      exactKeys(response, ["type", "requestId", "pairingId", "status"]);
      assertUuid(response.pairingId);
      assertEnum(response.status, [
        "cancelled",
        "already_cancelled",
        "already_approved",
        "expired",
      ]);
      break;
    case "consent.result":
      exactKeys(response, ["type", "requestId", "enabled"]);
      if (typeof response.enabled !== "boolean") fail();
      break;
    case "telegram.login.result":
      exactKeys(
        response,
        ["type", "requestId", "loginId", "status"],
        ["challengeId", "nextStep", "timeoutSeconds", "errorCode", "qrUrl"],
      );
      assertUuid(response.loginId);
      assertEnum(response.status, [
        "idle",
        "awaiting_input",
        "ready",
        "cancelled",
        "failed",
      ]);
      if (Object.hasOwn(response, "nextStep"))
        assertEnum(response.nextStep, ["phone", "code", "password", "qr"]);
      if (Object.hasOwn(response, "challengeId"))
        assertUuid(response.challengeId);
      if (Object.hasOwn(response, "qrUrl"))
        assertStringBytes(response.qrUrl, {
          min: 16,
          max: 4096,
          pattern: /^tg:\/\/login\?token=[A-Za-z0-9_-]+$/u,
        });
      if (Object.hasOwn(response, "timeoutSeconds"))
        assertInteger(response.timeoutSeconds, { min: 0, max: 600 });
      if (Object.hasOwn(response, "errorCode"))
        assertEnum(response.errorCode, IPC_ERROR_CODES);
      if (
        (response.status === "awaiting_input") !==
          Object.hasOwn(response, "nextStep") ||
        (response.status === "awaiting_input") !==
          Object.hasOwn(response, "challengeId") ||
        (response.nextStep === "qr") !== Object.hasOwn(response, "qrUrl") ||
        (response.status === "failed") !== Object.hasOwn(response, "errorCode")
      )
        fail();
      break;
    case "telegram.status.result":
      exactKeys(response, ["type", "requestId", "sessionStatus"]);
      assertEnum(response.sessionStatus, [
        "disconnected",
        "connected",
        "session_only",
        "vault_unavailable",
      ]);
      break;
    case "device.control.result":
      exactKeys(response, ["type", "requestId", "status"]);
      assertEnum(response.status, ["paused", "resumed", "disconnected"]);
      break;
    case "startup.settings.result":
      exactKeys(response, ["type", "requestId", "status"]);
      assertEnum(response.status, [
        "enabled",
        "disabled",
        "approval_required",
        "unsupported",
      ]);
      break;
    case "update.check.result":
      exactKeys(response, ["type", "requestId", "status"], ["version"]);
      assertEnum(response.status, [
        "available",
        "current",
        "unavailable",
        "incompatible",
        "system_managed",
      ]);
      if (response.status === "available")
        assertStringBytes(response.version, {
          min: 5,
          max: 128,
          pattern: /^[0-9A-Za-z.+-]+$/u,
        });
      else if (Object.hasOwn(response, "version")) fail();
      break;
    case "update.install.result":
      exactKeys(response, ["type", "requestId", "status"]);
      assertEnum(response.status, ["handed_off", "unavailable"]);
      break;
    case "game.status.result":
      exactKeys(response, ["type", "requestId", "status"]);
      assertEnum(response.status, [
        "ready",
        "auth_required",
        "paused",
        "unknown",
      ]);
      break;
    case "wiki.open.result":
      exactKeys(response, ["type", "requestId", "status"]);
      assertEnum(response.status, ["opened", "failed"]);
      break;
    case "diagnostics.export.result":
      exactKeys(response, ["type", "requestId", "status"]);
      assertEnum(response.status, ["saved", "unavailable"]);
      break;
    case "error.result":
      exactKeys(response, ["type", "requestId", "code"]);
      assertEnum(response.code, IPC_ERROR_CODES);
      break;
    default:
      fail("unsupported_operation");
  }
  return response;
}
