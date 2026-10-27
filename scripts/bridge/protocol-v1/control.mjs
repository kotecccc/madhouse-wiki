import {
  assertCompactSignedToken,
  assertBase64UrlBytes,
  assertEnum,
  assertInteger,
  assertProtocolVersion,
  assertStringBytes,
  assertUniqueEnumArray,
  assertUuid,
  exactKeys,
  fail,
  isRecord,
} from "./common.mjs";

export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
export const MAX_CONTROL_FRAME_BYTES = 32 * 1024;
export const MAX_LAUNCH_DATA_BYTES = 16 * 1024;

export const CONTROL_CAPABILITIES = Object.freeze([
  "cargo-byte-tunnel-v1",
  "official-game-launch-v1",
  "helper-pause-v1",
  "device-update-drain-v1",
  "game-status-v1",
]);
export const TRANSPORT_ERRORS = Object.freeze([
  "bridge_offline",
  "tcp_connect_failed",
  "connect_timeout",
  "socket_error",
  "socket_closed",
  "backpressure_limit",
  "data_channel_closed",
  "helper_paused",
]);
export const CLOSE_REASONS = Object.freeze([
  "completed",
  "cancelled",
  "paused",
  "revoked",
  "route_changed",
  "timeout",
  "transport_error",
]);
export const PAUSE_REASONS = Object.freeze([
  "device_offline",
  "auth_required",
  "unknown_attempt",
  "storage_unavailable",
  "route_changed",
  "revoked",
  "user_paused",
  "update_required",
]);
export const UPDATE_REASONS = Object.freeze([
  "client_incompatible",
  "protocol_incompatible",
  "mandatory_security_update",
]);

const UUID = (value) => assertUuid(value);
const semverPattern =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const MAX_VERSION_BYTES = 48;

function checkVersion(message) {
  assertProtocolVersion(message.protocolMajor, message.protocolMinor);
}

function checkPing(message) {
  exactKeys(message, ["type", "nonce"]);
  assertBase64UrlBytes(message.nonce, 32);
}

function checkHello(message) {
  exactKeys(message, [
    "type",
    "protocolMajor",
    "protocolMinor",
    "clientVersion",
    "capabilities",
  ]);
  checkVersion(message);
  assertStringBytes(message.clientVersion, {
    min: 5,
    max: MAX_VERSION_BYTES,
    pattern: semverPattern,
  });
  assertUniqueEnumArray(message.capabilities, CONTROL_CAPABILITIES, 16);
}

function checkHelloOk(message) {
  exactKeys(message, [
    "type",
    "protocolMajor",
    "protocolMinor",
    "connectionId",
    "heartbeatSeconds",
    "capabilities",
  ]);
  checkVersion(message);
  UUID(message.connectionId);
  assertInteger(message.heartbeatSeconds, { min: 5, max: 60 });
  assertUniqueEnumArray(message.capabilities, CONTROL_CAPABILITIES, 16);
}

function checkStreamOpen(message) {
  exactKeys(message, [
    "type",
    "requestId",
    "streamId",
    "target",
    "streamTicket",
    "routeEpoch",
  ]);
  UUID(message.requestId);
  UUID(message.streamId);
  if (message.target !== "cargo-main") fail();
  assertCompactSignedToken(message.streamTicket, { min: 32, max: 512 });
  assertInteger(message.routeEpoch, { min: 1 });
}

function checkStreamStatus(message) {
  exactKeys(message, ["type", "requestId", "streamId"]);
  UUID(message.requestId);
  UUID(message.streamId);
}

function checkStreamFailed(message) {
  exactKeys(message, ["type", "requestId", "streamId", "transportError"]);
  UUID(message.requestId);
  UUID(message.streamId);
  assertEnum(message.transportError, TRANSPORT_ERRORS);
}

function checkCloseStream(message) {
  exactKeys(message, ["type", "streamId"], ["reason"]);
  UUID(message.streamId);
  if (Object.hasOwn(message, "reason"))
    assertEnum(message.reason, CLOSE_REASONS);
}

function checkLaunchRequest(message) {
  exactKeys(message, [
    "type",
    "requestId",
    "operationId",
    "consentGeneration",
    "purpose",
  ]);
  UUID(message.requestId);
  UUID(message.operationId);
  assertInteger(message.consentGeneration);
  if (message.purpose !== "official-game-auth") fail();
}

function checkLaunchResult(message) {
  if (!isRecord(message)) fail();
  assertEnum(message.status, ["ready", "cancelled", "unavailable"]);
  const common = [
    "type",
    "requestId",
    "operationId",
    "consentGeneration",
    "status",
  ];
  exactKeys(
    message,
    message.status === "ready" ? [...common, "launchData"] : common,
  );
  UUID(message.requestId);
  UUID(message.operationId);
  assertInteger(message.consentGeneration);
  if (message.status === "ready")
    assertStringBytes(message.launchData, {
      min: 1,
      max: MAX_LAUNCH_DATA_BYTES,
    });
}

function checkPause(message) {
  exactKeys(message, ["type", "routeEpoch", "reason"]);
  assertInteger(message.routeEpoch, { min: 1 });
  assertEnum(message.reason, PAUSE_REASONS);
}

function checkHelperControl(message) {
  exactKeys(message, ["type", "requestId", "action"]);
  UUID(message.requestId);
  assertEnum(message.action, ["pause", "resume"]);
}

function checkHelperState(message) {
  exactKeys(message, ["type", "paused"]);
  if (typeof message.paused !== "boolean") fail();
}

function checkHelperControlResult(message) {
  exactKeys(message, ["type", "requestId", "paused"]);
  UUID(message.requestId);
  if (typeof message.paused !== "boolean") fail();
}

function checkDrain(message) {
  exactKeys(message, ["type", "drainId", "routeEpoch", "deadlineInMs"]);
  UUID(message.drainId);
  assertInteger(message.routeEpoch, { min: 1 });
  assertInteger(message.deadlineInMs, { min: 1, max: 35_000 });
}

function checkDeviceUpdateDrain(message) {
  exactKeys(message, ["type", "requestId"]);
  UUID(message.requestId);
}

function checkGameStatusRequest(message) {
  exactKeys(message, ["type", "requestId"]);
  UUID(message.requestId);
}

function checkGameStatusResult(message) {
  exactKeys(message, ["type", "requestId", "status"]);
  UUID(message.requestId);
  assertEnum(message.status, ["ready", "auth_required", "paused", "unknown"]);
}

function checkRevoked(message) {
  exactKeys(message, ["type", "deviceGeneration"]);
  assertInteger(message.deviceGeneration, { min: 1 });
}

function checkUpdateRequired(message) {
  exactKeys(message, [
    "type",
    "minimumClientVersion",
    "minimumProtocolMajor",
    "minimumProtocolMinor",
    "reason",
  ]);
  assertStringBytes(message.minimumClientVersion, {
    min: 5,
    max: MAX_VERSION_BYTES,
    pattern: semverPattern,
  });
  assertInteger(message.minimumProtocolMajor, { min: 0, max: 65535 });
  assertInteger(message.minimumProtocolMinor, { min: 0, max: 65535 });
  assertEnum(message.reason, UPDATE_REASONS);
}

const validators = Object.freeze({
  hello: checkHello,
  hello_ok: checkHelloOk,
  ping: checkPing,
  pong: checkPing,
  open_stream: checkStreamOpen,
  stream_ready: checkStreamStatus,
  stream_failed: checkStreamFailed,
  close_stream: checkCloseStream,
  request_game_launch: checkLaunchRequest,
  game_launch_result: checkLaunchResult,
  pause: checkPause,
  helper_control: checkHelperControl,
  helper_state: checkHelperState,
  helper_control_result: checkHelperControlResult,
  drain: checkDrain,
  device_update_drain: checkDeviceUpdateDrain,
  device_update_drained: checkDeviceUpdateDrain,
  game_status_check: checkGameStatusRequest,
  game_status_result: checkGameStatusResult,
  revoked: checkRevoked,
  update_required: checkUpdateRequired,
});

export function validateControlMessage(message) {
  if (!isRecord(message) || typeof message.type !== "string") fail();
  const validate = validators[message.type];
  if (!validate) fail("unsupported_message");
  validate(message);
  return message;
}

export function parseControlFrame(frame) {
  if (typeof frame !== "string") fail();
  if (new TextEncoder().encode(frame).byteLength > MAX_CONTROL_FRAME_BYTES)
    fail("message_too_large");
  let message;
  try {
    message = JSON.parse(frame);
  } catch {
    fail();
  }
  return validateControlMessage(message);
}
