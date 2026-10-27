import { fail } from "./common.mjs";
import { validateDeviceSessionClaims } from "./tickets.mjs";

const HEADER = Object.freeze({ alg: "HS256", typ: "MHDS1" });
const CLAIM_FIELDS = Object.freeze([
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
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

function cryptoSubtle() {
  if (!globalThis.crypto?.subtle) fail("crypto_unavailable");
  return globalThis.crypto.subtle;
}

function encodeBase64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value))
    fail("not_authorized");
  let binary;
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  } catch {
    fail("not_authorized");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (encodeBase64url(bytes) !== value) fail("not_authorized");
  return bytes;
}

async function importHmacKey(bytes, usages) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32)
    fail("not_authorized");
  return cryptoSubtle().importKey(
    "raw",
    bytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    usages,
  );
}

function orderedClaims(claims) {
  return Object.fromEntries(
    CLAIM_FIELDS.map((field) => [field, claims[field]]),
  );
}

export async function signDeviceSessionCredential(claims, keyBytes) {
  validateDeviceSessionClaims(claims);
  const key = await importHmacKey(keyBytes, ["sign"]);
  const header = encodeBase64url(encoder.encode(JSON.stringify(HEADER)));
  const payload = encodeBase64url(
    encoder.encode(JSON.stringify(orderedClaims(claims))),
  );
  const input = `${header}.${payload}`;
  const signature = await cryptoSubtle().sign(
    "HMAC",
    key,
    encoder.encode(input),
  );
  return `${input}.${encodeBase64url(new Uint8Array(signature))}`;
}

export async function verifyDeviceSessionCredential(
  value,
  keyBytes,
  { nowMs = Date.now() } = {},
) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 1
  )
    fail("not_authorized");
  const [headerPart, claimsPart, signaturePart] = value.split(".");
  let header;
  let claims;
  try {
    header = JSON.parse(decoder.decode(decodeBase64url(headerPart)));
    claims = JSON.parse(decoder.decode(decodeBase64url(claimsPart)));
    if (
      !header ||
      typeof header !== "object" ||
      Array.isArray(header) ||
      Object.keys(header).length !== 2 ||
      header.alg !== HEADER.alg ||
      header.typ !== HEADER.typ
    )
      fail("not_authorized");
    validateDeviceSessionClaims(claims);
  } catch {
    fail("not_authorized");
  }
  const signature = decodeBase64url(signaturePart);
  const key = await importHmacKey(keyBytes, ["verify"]);
  const valid = await cryptoSubtle().verify(
    "HMAC",
    key,
    signature,
    encoder.encode(`${headerPart}.${claimsPart}`),
  );
  if (!valid || claims.issuedAtMs > nowMs + 5000 || claims.expiresAtMs <= nowMs)
    fail("not_authorized");
  return claims;
}
