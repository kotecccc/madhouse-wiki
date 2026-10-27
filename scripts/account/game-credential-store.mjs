import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const MAX_RECORD_BYTES = 32 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const encoder = new TextEncoder();

function credentialError(code) {
  return Object.assign(new Error(code), { code });
}

export function gameCredentialKeyFromEnvironment(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    return null;
  const key = Buffer.from(value, "base64url");
  return key.byteLength === 32 && key.toString("base64url") === value
    ? key
    : null;
}

function normalizeKey(value) {
  if (value instanceof Uint8Array && value.byteLength === 32)
    return Buffer.from(value);
  if (typeof value === "string") {
    const decoded = gameCredentialKeyFromEnvironment(value);
    if (decoded) return decoded;
  }
  throw new TypeError("game_credential_key_invalid");
}

function ownerPath(key, ownerId) {
  const digest = createHmac("sha256", key)
    .update("madhouse-game-credential-path-v1:")
    .update(ownerId)
    .digest("hex");
  return `game-credentials/${digest}.json`;
}

function deriveKey(masterKey, purpose) {
  return createHmac("sha256", masterKey)
    .update(`madhouse-game-credential-${purpose}-v1`)
    .digest();
}

function jwtExpiry(token) {
  const parts = token.split(".");
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (!Number.isSafeInteger(payload?.exp) || payload.exp < 1) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

function validateRecord(record, expectedOwnerId) {
  const required = [
    "schemaVersion",
    "ownerId",
    "playerId",
    "credentialVersion",
    "authOperationId",
    "authGeneration",
    "consentGeneration",
    "routeEpoch",
    "expiresAt",
    "revoked",
    "accessToken",
  ];
  if (
    !record ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(record).length !== required.length ||
    !required.every((key) => Object.hasOwn(record, key)) ||
    record.schemaVersion !== 1 ||
    record.ownerId !== expectedOwnerId ||
    !/^[1-9][0-9]{0,15}$/u.test(record.ownerId) ||
    !Number.isSafeInteger(Number(record.ownerId)) ||
    typeof record.playerId !== "string" ||
    !/^[1-9][0-9]{0,15}$/u.test(record.playerId) ||
    !Number.isSafeInteger(Number(record.playerId)) ||
    !Number.isSafeInteger(record.credentialVersion) ||
    record.credentialVersion < 1 ||
    typeof record.authOperationId !== "string" ||
    !UUID_PATTERN.test(record.authOperationId) ||
    !Number.isSafeInteger(record.authGeneration) ||
    record.authGeneration < 1 ||
    !Number.isSafeInteger(record.consentGeneration) ||
    record.consentGeneration < 1 ||
    !Number.isSafeInteger(record.routeEpoch) ||
    record.routeEpoch < 0 ||
    typeof record.revoked !== "boolean"
  )
    throw credentialError("game_credential_record_invalid");

  if (record.revoked) {
    if (record.accessToken !== null || record.expiresAt !== 0)
      throw credentialError("game_credential_record_invalid");
  } else {
    if (
      typeof record.accessToken !== "string" ||
      record.accessToken.length > 16_384 ||
      !TOKEN_PATTERN.test(record.accessToken) ||
      !Number.isSafeInteger(record.expiresAt) ||
      record.expiresAt < 1 ||
      record.expiresAt > (jwtExpiry(record.accessToken) || 0)
    )
      throw credentialError("game_credential_record_invalid");
  }
  return record;
}

function seal(key, path, record) {
  const plaintext = Buffer.from(JSON.stringify(record));
  if (plaintext.byteLength > MAX_RECORD_BYTES)
    throw credentialError("game_credential_record_too_large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(encoder.encode(path));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64url"),
    data: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

function open(key, path, value) {
  let envelope;
  try {
    envelope = JSON.parse(value);
  } catch {
    throw credentialError("game_credential_record_corrupt");
  }
  if (
    envelope?.v !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.data !== "string" ||
    typeof envelope.tag !== "string"
  )
    throw credentialError("game_credential_record_corrupt");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(encoder.encode(path));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64url")),
      decipher.final(),
    ]);
    if (plaintext.byteLength > MAX_RECORD_BYTES)
      throw credentialError("game_credential_record_corrupt");
    const record = JSON.parse(plaintext.toString("utf8"));
    return record;
  } catch (error) {
    if (error?.code === "game_credential_record_corrupt") throw error;
    throw credentialError("game_credential_record_authentication_failed");
  }
}

export function createGameCredentialStore({ store, encryptionKey } = {}) {
  if (typeof store?.read !== "function" || typeof store?.write !== "function")
    throw new TypeError("game_credential_storage_required");
  const masterKey = normalizeKey(encryptionKey);
  const pathKey = deriveKey(masterKey, "path");
  const payloadKey = deriveKey(masterKey, "payload");

  async function read(ownerId) {
    if (
      typeof ownerId !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(ownerId) ||
      !Number.isSafeInteger(Number(ownerId))
    )
      throw new TypeError("invalid_owner_id");
    const path = ownerPath(pathKey, ownerId);
    let stored;
    try {
      stored = await store.read(path);
    } catch {
      throw credentialError("game_credential_store_unavailable");
    }
    if (!stored) return null;
    if (
      typeof stored.value !== "string" ||
      Buffer.byteLength(stored.value) > MAX_RECORD_BYTES * 2 ||
      typeof stored.etag !== "string" ||
      stored.etag.length < 1 ||
      stored.etag.length > 256
    )
      throw credentialError("game_credential_record_corrupt");
    const record = validateRecord(
      open(payloadKey, path, stored.value),
      ownerId,
    );
    return { record, etag: stored.etag };
  }

  async function compareAndSwap({ ownerId, expectedEtag, record } = {}) {
    if (
      expectedEtag !== null &&
      (typeof expectedEtag !== "string" || expectedEtag.length > 256)
    )
      throw new TypeError("game_credential_etag_invalid");
    validateRecord(record, ownerId);
    const path = ownerPath(pathKey, ownerId);
    let current;
    try {
      current = await store.read(path);
    } catch {
      throw credentialError("game_credential_store_unavailable");
    }
    if ((current?.etag ?? null) !== expectedEtag)
      throw credentialError("game_credential_conflict");
    if (
      current &&
      (typeof current.value !== "string" ||
        Buffer.byteLength(current.value) > MAX_RECORD_BYTES * 2 ||
        typeof current.etag !== "string" ||
        current.etag.length < 1 ||
        current.etag.length > 256)
    )
      throw credentialError("game_credential_record_corrupt");
    const expectedVersion = current
      ? validateRecord(open(payloadKey, path, current.value), ownerId)
          .credentialVersion + 1
      : 1;
    if (record.credentialVersion !== expectedVersion)
      throw credentialError("game_credential_version_conflict");
    let written;
    try {
      written = await store.write(
        path,
        seal(payloadKey, path, record),
        expectedEtag,
      );
    } catch (error) {
      if (
        error?.code === "storage_precondition_failed" ||
        error?.message === "storage_precondition_failed"
      )
        throw credentialError("game_credential_conflict");
      throw credentialError("game_credential_store_unavailable");
    }
    const etag = typeof written?.etag === "string" ? written.etag : null;
    if (!etag) throw credentialError("game_credential_store_unavailable");
    return { etag, credentialVersion: record.credentialVersion };
  }

  return Object.freeze({ read, compareAndSwap });
}
