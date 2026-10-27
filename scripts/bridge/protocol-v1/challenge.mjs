import {
  assertEnum,
  assertInteger,
  assertProtocolVersion,
  assertUuid,
  exactKeys,
  fail,
} from "./common.mjs";

const PREFIX = new TextEncoder().encode("MHC-DEVICE-CHALLENGE\0");
const MESSAGE_BYTES = PREFIX.byteLength + 5 + 16 + 16 + 32 + 8 + 8 + 8;
const PURPOSES = Object.freeze({ "gateway-session": 1 });

function uuidBytes(uuid) {
  assertUuid(uuid);
  const hex = uuid.replaceAll("-", "");
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

function nonceBytes(nonce) {
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== 32) fail();
  return nonce;
}

function setU64(view, offset, value) {
  assertInteger(value, { min: 1 });
  view.setBigUint64(offset, BigInt(value), false);
}

/**
 * Encode a server-issued challenge for Ed25519 signing. The server must verify
 * registry binding, generation, expiry, and one-use nonce independently.
 */
export function encodeDeviceChallenge(challenge) {
  exactKeys(challenge, [
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
  const {
    protocolMajor,
    protocolMinor,
    purpose,
    deviceId,
    connectionId,
    nonce,
    expiresAtMs,
    deviceGeneration,
    routeEpoch,
  } = challenge;
  assertProtocolVersion(protocolMajor, protocolMinor);
  assertEnum(purpose, Object.keys(PURPOSES));
  const device = uuidBytes(deviceId);
  const connection = uuidBytes(connectionId);
  const nonceData = nonceBytes(nonce);
  const bytes = new Uint8Array(MESSAGE_BYTES);
  bytes.set(PREFIX, 0);
  const view = new DataView(bytes.buffer);
  let offset = PREFIX.byteLength;
  view.setUint16(offset, protocolMajor, false);
  offset += 2;
  view.setUint16(offset, protocolMinor, false);
  offset += 2;
  view.setUint8(offset, PURPOSES[purpose]);
  offset += 1;
  bytes.set(device, offset);
  offset += device.byteLength;
  bytes.set(connection, offset);
  offset += connection.byteLength;
  bytes.set(nonceData, offset);
  offset += nonceData.byteLength;
  setU64(view, offset, expiresAtMs);
  offset += 8;
  setU64(view, offset, deviceGeneration);
  offset += 8;
  setU64(view, offset, routeEpoch);
  return bytes;
}
