import {
  assertEnum,
  assertInteger,
  assertProtocolVersion,
  assertUniqueEnumArray,
  assertUuid,
  exactKeys,
  fail,
} from "./common.mjs";

export const MAX_STREAM_TICKET_TTL_MS = 15_000;
export const MAX_DEVICE_SESSION_TTL_MS = 15 * 60_000;
export const DEVICE_SESSION_SCOPES = Object.freeze(["control", "data"]);

/** Validate decoded claims only. Callers must verify signature, revocation, and one-use state separately. */
export function validateStreamTicketClaims(claims) {
  exactKeys(claims, [
    "protocolMajor",
    "protocolMinor",
    "ticketId",
    "purpose",
    "ownerRef",
    "deviceId",
    "connectionId",
    "streamId",
    "routeEpoch",
    "issuedAtMs",
    "expiresAtMs",
    "target",
  ]);
  assertProtocolVersion(claims.protocolMajor, claims.protocolMinor);
  assertUuid(claims.ticketId);
  assertEnum(claims.purpose, ["cargo-stream"]);
  assertUuid(claims.ownerRef);
  assertUuid(claims.deviceId);
  assertUuid(claims.connectionId);
  assertUuid(claims.streamId);
  assertInteger(claims.routeEpoch, { min: 1 });
  assertInteger(claims.issuedAtMs, { min: 1 });
  assertInteger(claims.expiresAtMs, { min: 1 });
  if (
    claims.expiresAtMs <= claims.issuedAtMs ||
    claims.expiresAtMs - claims.issuedAtMs > MAX_STREAM_TICKET_TTL_MS ||
    claims.target !== "cargo-main"
  )
    fail();
  return claims;
}

export function validateDeviceSessionClaims(claims) {
  exactKeys(claims, [
    "protocolMajor",
    "protocolMinor",
    "purpose",
    "deviceId",
    "deviceGeneration",
    "connectionId",
    "routeEpoch",
    "issuedAtMs",
    "expiresAtMs",
    "scopes",
  ]);
  assertProtocolVersion(claims.protocolMajor, claims.protocolMinor);
  assertEnum(claims.purpose, ["device-session"]);
  assertUuid(claims.deviceId);
  assertInteger(claims.deviceGeneration, { min: 1 });
  assertUuid(claims.connectionId);
  assertInteger(claims.routeEpoch, { min: 1 });
  assertInteger(claims.issuedAtMs, { min: 1 });
  assertInteger(claims.expiresAtMs, { min: 1 });
  if (
    claims.expiresAtMs <= claims.issuedAtMs ||
    claims.expiresAtMs - claims.issuedAtMs > MAX_DEVICE_SESSION_TTL_MS
  )
    fail();
  assertUniqueEnumArray(claims.scopes, DEVICE_SESSION_SCOPES, 2);
  if (claims.scopes.length === 0) fail();
  return claims;
}
