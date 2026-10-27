import {
  assertEnum,
  assertInteger,
  assertProtocolVersion,
  assertStringBytes,
  assertUuid,
  exactKeys,
  fail,
  isRecord,
} from "./common.mjs";

export const INTERNAL_OPERATIONS = Object.freeze([
  "device.pair.start",
  "device.pair.status",
  "device.pair.cancel",
  "device.list",
  "game_auth.start",
  "game_auth.status",
  "game_auth.cancel",
  "game_auth.logout",
  "game_auth.bootstrap",
  "game_auth.bootstrap.status",
  "account_session.verify",
  "device.pair.approve",
  "device.revoke",
  "route.select",
  "game_account.bind",
  "device.session.challenge",
  "device.session.prove",
]);

const AUTH_STATES = Object.freeze([
  "created",
  "launch_requested",
  "exchange_pending",
  "verification_pending",
  "credential_stored",
  "ready",
  "auth_outcome_unknown",
  "failed",
  "cancelled",
  "logout_pending",
  "logged_out",
]);
const SAFE_REASONS = Object.freeze([
  "auth_required",
  "device_offline",
  "invalid_game_session",
  "game_unavailable",
  "consent_required",
  "route_stale",
  "credential_unavailable",
  "storage_unavailable",
  "unknown_outcome",
]);
const OWNER_PROOF_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function assertBase64urlBytes(value, byteLength) {
  const charLength = Math.ceil((byteLength * 8) / 6);
  assertStringBytes(value, {
    min: charLength,
    max: charLength,
    pattern: /^[A-Za-z0-9_-]+$/u,
  });
  const remainingBits = (byteLength * 8) % 6;
  if (
    remainingBits &&
    BASE64URL.indexOf(value.at(-1)) % 2 ** (6 - remainingBits) !== 0
  )
    fail();
  return value;
}

export function validateOwnerProofClaims(claims, expectedOperation) {
  exactKeys(claims, [
    "issuer",
    "audience",
    "subject",
    "operation",
    "issuedAtSeconds",
    "expiresAtSeconds",
    "jti",
    "identityGeneration",
  ]);
  if (claims.issuer !== "madhouse-wiki") fail();
  if (claims.audience !== "madhouse-wiki-bridge-internal") fail();
  assertStringBytes(claims.subject, {
    min: 1,
    max: 16,
    pattern: /^[1-9][0-9]{0,15}$/u,
  });
  if (!Number.isSafeInteger(Number(claims.subject))) fail();
  assertEnum(claims.operation, INTERNAL_OPERATIONS);
  if (expectedOperation && claims.operation !== expectedOperation)
    fail("not_authorized");
  assertInteger(claims.issuedAtSeconds, { min: 1 });
  assertInteger(claims.expiresAtSeconds, { min: 1 });
  assertUuid(claims.jti);
  assertInteger(claims.identityGeneration, { min: 1 });
  if (
    claims.expiresAtSeconds <= claims.issuedAtSeconds ||
    claims.expiresAtSeconds - claims.issuedAtSeconds > 60
  )
    fail();
  return claims;
}

function ownerProof(value) {
  assertStringBytes(value, {
    min: 40,
    max: 4096,
    pattern: OWNER_PROOF_PATTERN,
  });
}

function checkRequestId(value) {
  assertUuid(value);
}

export function parseInternalRequest(request) {
  if (!isRecord(request)) fail();
  assertEnum(request.operation, INTERNAL_OPERATIONS);
  switch (request.operation) {
    case "device.list":
      exactKeys(request, ["operation", "requestId", "ownerProof"]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      break;
    case "device.pair.start":
      exactKeys(request, [
        "operation",
        "requestId",
        "idempotencyKey",
        "deviceId",
        "publicKey",
        "deviceName",
        "platform",
      ]);
      checkRequestId(request.requestId);
      assertUuid(request.idempotencyKey);
      assertUuid(request.deviceId);
      assertBase64urlBytes(request.publicKey, 32);
      assertStringBytes(request.deviceName, { min: 1, max: 80 });
      assertEnum(request.platform, ["macos", "windows", "linux"]);
      break;
    case "device.pair.status":
    case "device.pair.cancel":
      exactKeys(request, [
        "operation",
        "requestId",
        "pairingId",
        "retrievalSecret",
      ]);
      checkRequestId(request.requestId);
      assertUuid(request.pairingId);
      assertBase64urlBytes(request.retrievalSecret, 32);
      break;
    case "device.session.challenge":
      exactKeys(request, ["operation", "requestId", "deviceId"]);
      checkRequestId(request.requestId);
      assertUuid(request.deviceId);
      break;
    case "device.session.prove":
      exactKeys(request, [
        "operation",
        "requestId",
        "deviceId",
        "challengeId",
        "signature",
      ]);
      checkRequestId(request.requestId);
      assertUuid(request.deviceId);
      assertUuid(request.challengeId);
      assertBase64urlBytes(request.signature, 64);
      break;
    case "game_auth.start":
      exactKeys(request, [
        "operation",
        "requestId",
        "ownerProof",
        "consentGeneration",
        "routeEpoch",
      ]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      assertInteger(request.consentGeneration, { min: 1 });
      assertInteger(request.routeEpoch, { min: 1 });
      break;
    case "game_auth.bootstrap":
      exactKeys(request, [
        "operation",
        "requestId",
        "ownerProof",
        "cargoLaunchData",
      ]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      assertStringBytes(request.cargoLaunchData, { min: 1, max: 8192 });
      break;
    case "game_auth.logout":
      exactKeys(request, ["operation", "requestId", "ownerProof"]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      break;
    case "game_auth.status":
    case "game_auth.cancel":
      exactKeys(request, [
        "operation",
        "requestId",
        "ownerProof",
        "operationId",
      ]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      assertUuid(request.operationId);
      break;
    case "game_auth.bootstrap.status":
      exactKeys(request, ["operation", "requestId", "ownerProof"]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      break;
    case "account_session.verify":
      exactKeys(request, [
        "operation",
        "requestId",
        "ownerProof",
        "operationId",
        "credentialVersion",
      ]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      assertUuid(request.operationId);
      assertInteger(request.credentialVersion, { min: 1 });
      break;
    case "device.pair.approve":
      exactKeys(request, [
        "operation",
        "requestId",
        "ownerProof",
        "pairingId",
        "matchingCode",
      ]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      assertUuid(request.pairingId);
      assertStringBytes(request.matchingCode, {
        min: 6,
        max: 6,
        pattern: /^[A-Z0-9]{6}$/,
      });
      break;
    case "device.revoke":
      exactKeys(request, [
        "operation",
        "requestId",
        "ownerProof",
        "deviceId",
        "expectedGeneration",
      ]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      assertUuid(request.deviceId);
      assertInteger(request.expectedGeneration, { min: 1 });
      break;
    case "route.select":
      exactKeys(request, [
        "operation",
        "requestId",
        "ownerProof",
        "policy",
        "activeDeviceId",
        "expectedRouteEpoch",
      ]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      assertEnum(request.policy, ["direct", "bridge_required"]);
      if (request.policy === "bridge_required")
        assertUuid(request.activeDeviceId);
      else if (request.activeDeviceId !== null) fail();
      assertInteger(request.expectedRouteEpoch, { min: 0 });
      break;
    case "game_account.bind":
      exactKeys(request, [
        "operation",
        "requestId",
        "ownerProof",
        "authorization",
      ]);
      checkRequestId(request.requestId);
      ownerProof(request.ownerProof);
      assertStringBytes(request.authorization, {
        min: 8,
        max: 16_384,
        pattern: /^Bearer [A-Za-z0-9._~-]+$/u,
      });
      break;
    default:
      fail("unsupported_operation");
  }
  return request;
}

export function parseInternalResponse(response) {
  if (!isRecord(response)) fail();
  assertUuid(response.requestId);
  assertEnum(response.operation, INTERNAL_OPERATIONS);
  if (response.operation === "device.list") {
    exactKeys(response, ["requestId", "operation", "devices", "routePolicy"]);
    if (response.routePolicy !== null) {
      exactKeys(response.routePolicy, [
        "policy",
        "activeDeviceId",
        "routeEpoch",
      ]);
      assertEnum(response.routePolicy.policy, ["direct", "bridge_required"]);
      if (response.routePolicy.policy === "direct") {
        if (response.routePolicy.activeDeviceId !== null) fail();
        assertInteger(response.routePolicy.routeEpoch, { min: 0 });
      } else {
        assertUuid(response.routePolicy.activeDeviceId);
        assertInteger(response.routePolicy.routeEpoch, { min: 1 });
      }
    }
    if (!Array.isArray(response.devices) || response.devices.length > 32)
      fail();
    const deviceIds = new Set();
    for (const device of response.devices) {
      exactKeys(device, [
        "deviceId",
        "deviceName",
        "platform",
        "status",
        "generation",
        "createdAtMs",
        "approvedAtMs",
        "revokedAtMs",
      ]);
      assertUuid(device.deviceId);
      if (deviceIds.has(device.deviceId)) fail();
      deviceIds.add(device.deviceId);
      assertStringBytes(device.deviceName, { min: 1, max: 80 });
      assertEnum(device.platform, ["macos", "windows", "linux"]);
      assertEnum(device.status, ["active", "revoked"]);
      assertInteger(device.generation, { min: 1 });
      assertInteger(device.createdAtMs, { min: 1 });
      assertInteger(device.approvedAtMs, { min: 1 });
      if (device.revokedAtMs !== null)
        assertInteger(device.revokedAtMs, { min: 1 });
      if ((device.status === "active") !== (device.revokedAtMs === null))
        fail();
    }
  } else if (response.operation === "device.pair.start") {
    exactKeys(response, [
      "requestId",
      "operation",
      "status",
      "pairingId",
      "displayCode",
      "retrievalSecret",
      "expiresAtMs",
    ]);
    assertEnum(response.status, ["created"]);
    assertUuid(response.pairingId);
    assertStringBytes(response.displayCode, {
      min: 6,
      max: 6,
      pattern: /^[A-Z0-9]{6}$/u,
    });
    assertBase64urlBytes(response.retrievalSecret, 32);
    assertInteger(response.expiresAtMs, { min: 1 });
  } else if (response.operation === "device.pair.status") {
    exactKeys(
      response,
      ["requestId", "operation", "pairingId", "status"],
      ["deviceId", "deviceGeneration", "expectedTelegramOwnerId"],
    );
    assertUuid(response.pairingId);
    assertEnum(response.status, [
      "pending",
      "approved",
      "cancelled",
      "expired",
    ]);
    if (response.status === "approved") {
      assertUuid(response.deviceId);
      assertInteger(response.deviceGeneration, { min: 1 });
      assertStringBytes(response.expectedTelegramOwnerId, {
        min: 1,
        max: 16,
        pattern: /^[1-9][0-9]{0,15}$/u,
      });
      if (!Number.isSafeInteger(Number(response.expectedTelegramOwnerId)))
        fail();
    } else if (
      Object.hasOwn(response, "deviceId") ||
      Object.hasOwn(response, "deviceGeneration") ||
      Object.hasOwn(response, "expectedTelegramOwnerId")
    )
      fail();
  } else if (response.operation === "device.pair.cancel") {
    exactKeys(response, ["requestId", "operation", "pairingId", "status"]);
    assertUuid(response.pairingId);
    assertEnum(response.status, [
      "cancelled",
      "already_cancelled",
      "already_approved",
      "expired",
    ]);
  } else if (response.operation.startsWith("game_auth.")) {
    exactKeys(
      response,
      ["requestId", "operation", "operationId", "status"],
      ["reason"],
    );
    assertUuid(response.operationId);
    assertEnum(response.status, AUTH_STATES);
    if (Object.hasOwn(response, "reason"))
      assertEnum(response.reason, SAFE_REASONS);
  } else if (response.operation === "device.pair.approve") {
    exactKeys(response, [
      "requestId",
      "operation",
      "status",
      "deviceId",
      "deviceGeneration",
    ]);
    assertEnum(response.status, ["approved", "already_approved"]);
    assertUuid(response.deviceId);
    assertInteger(response.deviceGeneration, { min: 1 });
  } else if (response.operation === "device.revoke") {
    exactKeys(response, [
      "requestId",
      "operation",
      "status",
      "deviceId",
      "deviceGeneration",
    ]);
    assertEnum(response.status, ["revoked", "already_revoked"]);
    assertUuid(response.deviceId);
    assertInteger(response.deviceGeneration, { min: 1 });
  } else if (response.operation === "route.select") {
    exactKeys(response, [
      "requestId",
      "operation",
      "status",
      "routeEpoch",
      "policy",
    ]);
    assertEnum(response.status, ["selected", "unchanged"]);
    assertEnum(response.policy, ["direct", "bridge_required"]);
    assertInteger(response.routeEpoch, { min: 0 });
    if (
      (response.status === "selected" && response.routeEpoch < 1) ||
      (response.routeEpoch === 0 && response.policy !== "direct")
    )
      fail();
  } else if (response.operation === "account_session.verify") {
    exactKeys(response, [
      "requestId",
      "operation",
      "operationId",
      "status",
      "credentialVersion",
    ]);
    assertUuid(response.operationId);
    assertEnum(response.status, ["verified", "already_verified"]);
    assertInteger(response.credentialVersion, { min: 1 });
  } else if (response.operation === "game_account.bind") {
    exactKeys(response, ["requestId", "operation", "status"]);
    assertEnum(response.status, ["bound", "already_bound"]);
  } else if (response.operation === "device.session.challenge") {
    exactKeys(response, [
      "requestId",
      "operation",
      "challengeId",
      "protocolMajor",
      "protocolMinor",
      "purpose",
      "deviceId",
      "connectionId",
      "nonce",
      "expiresAtMs",
      "deviceGeneration",
      "routeEpoch",
    ]);
    assertProtocolVersion(response.protocolMajor, response.protocolMinor);
    assertEnum(response.purpose, ["gateway-session"]);
    assertUuid(response.challengeId);
    assertUuid(response.deviceId);
    assertUuid(response.connectionId);
    assertBase64urlBytes(response.nonce, 32);
    assertInteger(response.expiresAtMs, { min: 1 });
    assertInteger(response.deviceGeneration, { min: 1 });
    assertInteger(response.routeEpoch, { min: 1 });
  } else if (response.operation === "device.session.prove") {
    exactKeys(response, [
      "requestId",
      "operation",
      "status",
      "deviceId",
      "connectionId",
      "deviceGeneration",
      "routeEpoch",
      "expiresAtMs",
      "sessionCredential",
    ]);
    assertEnum(response.status, ["issued"]);
    assertUuid(response.deviceId);
    assertUuid(response.connectionId);
    assertInteger(response.deviceGeneration, { min: 1 });
    assertInteger(response.routeEpoch, { min: 1 });
    assertInteger(response.expiresAtMs, { min: 1 });
    assertStringBytes(response.sessionCredential, {
      min: 40,
      max: 2048,
      pattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    });
  } else {
    fail("unsupported_operation");
  }
  return response;
}
