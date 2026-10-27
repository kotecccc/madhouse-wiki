import { webcrypto } from "node:crypto";
const subtle = webcrypto.subtle;
const encoder = new TextEncoder();
const utf8 = (s) => encoder.encode(s);
const hex = (data) => Buffer.from(data).toString("hex");
const keyBytes = (value) => {
  if (!/^[a-f0-9]{64}$/i.test(value || ""))
    throw new Error("session_config_unavailable");
  return Buffer.from(value, "hex");
};
async function mac(key, value) {
  const cryptoKey = await subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await subtle.sign("HMAC", cryptoKey, utf8(value)));
}
export async function verifyWikiIdentity(
  initData,
  verificationKey,
  now = Date.now(),
) {
  if (typeof initData !== "string" || initData.length > 8192)
    throw new Error("invalid_wiki_identity");
  const params = new URLSearchParams(initData);
  const fields = [...params.keys()];
  if (new Set(fields).size !== fields.length)
    throw new Error("invalid_wiki_identity");
  const hash = params.get("hash");
  const issued = Number(params.get("auth_date"));
  if (
    !/^[a-f0-9]{64}$/i.test(hash || "") ||
    !Number.isInteger(issued) ||
    issued * 1000 > now + 30000 ||
    now - issued * 1000 > 300000
  )
    throw new Error("invalid_wiki_identity");
  params.delete("hash");
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  const cryptoKey = await subtle.importKey(
    "raw",
    keyBytes(verificationKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (
    !(await subtle.verify(
      "HMAC",
      cryptoKey,
      Buffer.from(hash, "hex"),
      utf8(check),
    ))
  )
    throw new Error("invalid_wiki_identity");
  let user;
  try {
    user = JSON.parse(params.get("user"));
  } catch {
    throw new Error("invalid_wiki_identity");
  }
  if (!Number.isSafeInteger(user?.id) || user.id <= 0)
    throw new Error("invalid_wiki_identity");
  return String(user.id);
}
export function createAccountSessions({
  store,
  verificationKey,
  encryptionKey,
  now = Date.now,
}) {
  async function cryptoKey() {
    return subtle.importKey("raw", keyBytes(encryptionKey), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }
  async function sealIdentity(identity) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const cipher = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv,
        additionalData: utf8("identity-proof"),
      },
      await cryptoKey(),
      utf8(JSON.stringify(identity)),
    );
    return Buffer.from(
      JSON.stringify({
        v: 1,
        iv: Buffer.from(iv).toString("base64url"),
        data: Buffer.from(cipher).toString("base64url"),
      }),
    ).toString("base64url");
  }
  async function unsealIdentity(wikiProof) {
    try {
      const envelope = JSON.parse(
        Buffer.from(wikiProof, "base64url").toString(),
      );
      const plain = await subtle.decrypt(
        {
          name: "AES-GCM",
          iv: Buffer.from(envelope.iv, "base64url"),
          additionalData: utf8("identity-proof"),
        },
        await cryptoKey(),
        Buffer.from(envelope.data, "base64url"),
      );
      const identity = JSON.parse(new TextDecoder().decode(plain));
      if (
        typeof identity.userId !== "string" ||
        !/^[1-9][0-9]{0,15}$/.test(identity.userId) ||
        !Number.isFinite(identity.expiresAt) ||
        identity.expiresAt <= now()
      )
        throw new Error();
      return identity.userId;
    } catch {
      throw new Error("invalid_wiki_identity");
    }
  }
  async function replaceLegacySessionWithTombstone(userId) {
    const id =
      "accounts/" +
      hex(await mac(keyBytes(encryptionKey), "account:" + userId)) +
      ".json";
    for (let attempt = 0; attempt < 3; attempt++) {
      const stored = await store.read(id);
      try {
        const iv = webcrypto.getRandomValues(new Uint8Array(12));
        const cipher = await subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: utf8(id) },
          await cryptoKey(),
          utf8(
            JSON.stringify({
              revision: webcrypto.randomUUID(),
              revoked: true,
              expiresAt: 0,
              accessToken: null,
            }),
          ),
        );
        const envelope = JSON.stringify({
          v: 1,
          iv: Buffer.from(iv).toString("base64url"),
          data: Buffer.from(cipher).toString("base64url"),
        });
        await store.write(id, envelope, stored?.etag ?? null);
        return;
      } catch {
        if (attempt === 2) throw new Error("session_store_unavailable");
      }
    }
  }
  return async function accountSession(data) {
    if (data.action !== "logout")
      throw new Error("game_auth_server_managed_required");
    if (!data.wikiProof && !data.wikiInitData)
      throw new Error("invalid_wiki_identity");
    let userId = data.wikiProof ? await unsealIdentity(data.wikiProof) : null;
    if (data.wikiInitData) {
      const launchUserId = await verifyWikiIdentity(
        data.wikiInitData,
        verificationKey,
        now(),
      );
      if (userId && userId !== launchUserId)
        throw new Error("invalid_wiki_identity");
      userId ??= launchUserId;
    }
    const wikiProof =
      data.wikiProof ||
      (await sealIdentity({ userId, expiresAt: now() + 86400000 }));
    await replaceLegacySessionWithTombstone(userId);
    return { status: "disconnected", wikiProof };
  };
}
