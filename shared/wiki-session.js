import { webcrypto } from "node:crypto";

const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const utf8 = (value) => encoder.encode(value);
const hex = (value) => Buffer.from(value).toString("hex");
const keyBytes = (value) => {
  if (!/^[a-f0-9]{64}$/i.test(value || ""))
    throw new Error("wiki_session_config_unavailable");
  return Buffer.from(value, "hex");
};
const b64 = (value) => Buffer.from(value).toString("base64url");
const fromB64 = (value) => Buffer.from(value, "base64url");
const sessionPath = (value) => /^accounts\/[a-f0-9]{64}\.json$/i.test(value);

// Untrusted claims are used only to deny sending this credential to the game.
export function isWikiSessionCredential(authorization) {
  if (typeof authorization !== "string" || !authorization.startsWith("Bearer "))
    return false;
  const parts = authorization.slice(7).split(".");
  if (parts.length !== 3 || parts[1].length > 4096) return false;
  try {
    const claims = JSON.parse(fromB64(parts[1]).toString("utf8"));
    return (
      claims?.v === 1 &&
      typeof claims.legacy === "boolean" &&
      sessionPath(claims.accountPath || "")
    );
  } catch {
    return false;
  }
}

async function hmac(key, value) {
  const cryptoKey = await subtle.importKey(
    "raw",
    keyBytes(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", cryptoKey, utf8(value)));
}

export async function readAccountRecord(store, encryptionKey, accountPath) {
  if (!sessionPath(accountPath || "")) return null;
  const stored = await store.read(accountPath);
  if (!stored) return null;
  try {
    const envelope = JSON.parse(stored.value);
    if (envelope.v !== 1) return null;
    const cryptoKey = await subtle.importKey(
      "raw",
      keyBytes(encryptionKey),
      "AES-GCM",
      false,
      ["decrypt"],
    );
    const plain = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromB64(envelope.iv),
        additionalData: utf8(accountPath),
      },
      cryptoKey,
      fromB64(envelope.data),
    );
    return JSON.parse(new TextDecoder().decode(plain));
  } catch {
    return null;
  }
}

export function createWikiSessionAuthority({
  store,
  encryptionKey,
  signingKey,
  now = Date.now,
  ttl = 86400000,
}) {
  if (!store || typeof store.read !== "function")
    throw new TypeError("invalid_wiki_session_store");
  keyBytes(encryptionKey);
  keyBytes(signingKey);

  async function mint(accountPath, record, telegramUserId) {
    const legacy = !!record && !Object.hasOwn(record, "playerId");
    if (
      !sessionPath(accountPath) ||
      record?.revoked !== false ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= 0 ||
      !/^[a-f0-9-]{36}$/i.test(record?.revision || "") ||
      !/^[1-9][0-9]{0,19}$/.test(telegramUserId || "") ||
      (!legacy && record.telegramUserId !== telegramUserId) ||
      (legacy &&
        (typeof record.accessToken !== "string" ||
          record.accessToken.length > 16384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
            record.accessToken,
          )))
    )
      throw new Error("wiki_session_unavailable");
    const issuedAt = now();
    const claims = {
      v: 1,
      accountPath,
      legacy,
      ...(legacy ? {} : { playerId: record.playerId }),
      telegramUserId,
      revision: record.revision,
      iat: Math.floor(issuedAt / 1000),
      exp: Math.floor((issuedAt + ttl) / 1000),
    };
    const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const payload = b64(JSON.stringify(claims));
    const message = `${header}.${payload}`;
    return `${message}.${b64(await hmac(signingKey, message))}`;
  }

  async function verify(credential) {
    if (typeof credential !== "string" || credential.length > 2048) return null;
    const [headerPart, payload, signature, extra] = credential.split(".");
    if (!headerPart || !payload || !signature || extra !== undefined)
      return null;
    let claims;
    try {
      const header = JSON.parse(fromB64(headerPart).toString("utf8"));
      if (
        header?.alg !== "HS256" ||
        header?.typ !== "JWT" ||
        Object.keys(header).length !== 2
      )
        return null;
      const cryptoKey = await subtle.importKey(
        "raw",
        keyBytes(signingKey),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"],
      );
      if (
        !(await subtle.verify(
          "HMAC",
          cryptoKey,
          fromB64(signature),
          utf8(`${headerPart}.${payload}`),
        ))
      )
        return null;
      claims = JSON.parse(fromB64(payload).toString("utf8"));
    } catch {
      return null;
    }
    const timestamp = now();
    const accountDigest = hex(
      await hmac(encryptionKey, `account:${claims?.telegramUserId || ""}`),
    );
    if (
      claims?.v !== 1 ||
      typeof claims.legacy !== "boolean" ||
      !sessionPath(claims.accountPath) ||
      !/^[1-9][0-9]{0,19}$/.test(claims.telegramUserId || "") ||
      claims.accountPath !== `accounts/${accountDigest}.json` ||
      (claims.legacy === true
        ? Object.hasOwn(claims, "playerId")
        : !Number.isSafeInteger(claims.playerId) || claims.playerId <= 0) ||
      !/^[a-f0-9-]{36}$/i.test(claims.revision || "") ||
      !Number.isSafeInteger(claims.iat) ||
      claims.iat * 1000 > timestamp + 30000 ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp * 1000 <= timestamp ||
      claims.exp * 1000 - claims.iat * 1000 > ttl
    )
      return null;

    const record = await readAccountRecord(
      store,
      encryptionKey,
      claims.accountPath,
    );
    const legacy = claims.legacy === true;
    if (
      !record ||
      record.revoked !== false ||
      !Number.isFinite(record.expiresAt) ||
      record.expiresAt <= 0 ||
      record.revision !== claims.revision ||
      (record.telegramUserId &&
        record.telegramUserId !== claims.telegramUserId) ||
      (legacy
        ? Object.hasOwn(record, "playerId") ||
          typeof record.accessToken !== "string" ||
          record.accessToken.length > 16384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
            record.accessToken,
          )
        : record.playerId !== claims.playerId)
    )
      return null;
    return {
      ...(legacy
        ? { legacyAuthorization: `Bearer ${record.accessToken}` }
        : { playerId: claims.playerId }),
      telegramUserId: claims.telegramUserId,
      expiresAt: claims.exp * 1000,
    };
  }

  return { mint, verify };
}
