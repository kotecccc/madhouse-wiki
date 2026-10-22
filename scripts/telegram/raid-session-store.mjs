import { webcrypto } from "node:crypto";
import { get, put } from "../storage/client.mjs";
import { strongBlobEtag } from "./raid-blob-etag.mjs";

const BLOB_PATH = "madhouse-raids/telegram-session.enc.json";
const MAX_BLOB_SIZE = 16 * 1024;
const encoder = new TextEncoder();

function encryptionKey(
  value = process.env.TELEGRAM_RAIDS_SESSION_ENCRYPTION_KEY,
) {
  if (!/^[a-f0-9]{64}$/i.test(value || ""))
    throw new Error("raid_session_config_unavailable");
  return Buffer.from(value, "hex");
}

async function cryptoKey(value) {
  return webcrypto.subtle.importKey("raw", value, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

async function seal(session, key) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const cipher = await webcrypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(BLOB_PATH),
    },
    await cryptoKey(key),
    encoder.encode(session),
  );
  return JSON.stringify({
    version: 1,
    iv: Buffer.from(iv).toString("base64url"),
    ciphertext: Buffer.from(cipher).toString("base64url"),
  });
}

async function unseal(envelopeText, key) {
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new Error("raid_session_store_unavailable");
  }
  if (
    envelope?.version !== 1 ||
    !/^[A-Za-z0-9_-]{16}$/.test(envelope.iv || "") ||
    typeof envelope.ciphertext !== "string" ||
    !/^[A-Za-z0-9_-]+$/.test(envelope.ciphertext)
  )
    throw new Error("raid_session_store_unavailable");
  try {
    const plain = await webcrypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(envelope.iv, "base64url"),
        additionalData: encoder.encode(BLOB_PATH),
      },
      await cryptoKey(key),
      Buffer.from(envelope.ciphertext, "base64url"),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new Error("raid_session_store_unavailable");
  }
}

export function createRaidSessionStore({
  getBlob = get,
  putBlob = put,
  key = () => encryptionKey(),
} = {}) {
  async function readEnvelope() {
    const result = await getBlob(BLOB_PATH, {
      access: "private",
      useCache: false,
    });
    if (!result) return null;
    if (result.statusCode !== 200 || result.blob.size > MAX_BLOB_SIZE)
      throw new Error("raid_session_store_unavailable");
    return {
      value: await new Response(result.stream).text(),
      etag: strongBlobEtag(result.blob.etag),
    };
  }

  return {
    async exists() {
      return Boolean(await readEnvelope());
    },
    async read() {
      const current = await readEnvelope();
      if (!current) throw new Error("raid_session_not_configured");
      const session = await unseal(current.value, key());
      if (!session || session.length > 4096)
        throw new Error("raid_session_store_unavailable");
      return session;
    },
    async save(session, { replace = false } = {}) {
      if (
        typeof session !== "string" ||
        session.length < 100 ||
        session.length > 4096
      )
        throw new Error("invalid_raid_session");
      const current = await readEnvelope();
      if (current && !replace)
        throw new Error("raid_session_already_configured");
      await putBlob(BLOB_PATH, await seal(session, key()), {
        access: "private",
        contentType: "application/json",
        addRandomSuffix: false,
        allowOverwrite: Boolean(current),
        ...(current ? { ifMatch: current.etag } : {}),
        cacheControlMaxAge: 60,
      });
    },
  };
}
