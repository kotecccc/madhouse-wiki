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
  fetcher = fetch,
  now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  async function cryptoKey() {
    return subtle.importKey("raw", keyBytes(encryptionKey), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
  }
  async function seal(record, id) {
    const iv = webcrypto.getRandomValues(new Uint8Array(12));
    const cipher = await subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: utf8(id) },
      await cryptoKey(),
      utf8(JSON.stringify(record)),
    );
    return JSON.stringify({
      v: 1,
      iv: Buffer.from(iv).toString("base64url"),
      data: Buffer.from(cipher).toString("base64url"),
    });
  }
  async function read(id) {
    const stored = await store.read(id);
    if (!stored) return null;
    const envelope = JSON.parse(stored.value);
    if (envelope.v !== 1) throw new Error("invalid_session_record");
    const plain = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(envelope.iv, "base64url"),
        additionalData: utf8(id),
      },
      await cryptoKey(),
      Buffer.from(envelope.data, "base64url"),
    );
    return {
      record: JSON.parse(new TextDecoder().decode(plain)),
      etag: stored.etag,
    };
  }
  async function write(id, record, etag) {
    await store.write(id, await seal(record, id), etag);
  }
  async function ticket(id, revision) {
    return (
      revision +
      "." +
      hex(await mac(keyBytes(encryptionKey), id + ":" + revision))
    );
  }
  const revision = () => webcrypto.randomUUID();
  async function current(id) {
    let found = await read(id);
    if (found) return found;
    try {
      await write(
        id,
        {
          revision: revision(),
          revoked: false,
          expiresAt: 0,
          accessToken: null,
        },
        null,
      );
    } catch {
      /* Another authenticated request may have created it first. */
    }
    found = await read(id);
    if (!found) throw new Error("session_store_unavailable");
    return found;
  }
  return async function accountSession(data) {
    if (!!data.wikiProof === !!data.wikiInitData)
      throw new Error("invalid_request");
    let userId,
      wikiProof = data.wikiProof;
    if (wikiProof) {
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
          !/^\d+$/.test(identity.userId) ||
          !Number.isFinite(identity.expiresAt) ||
          identity.expiresAt <= now()
        )
          throw new Error();
        userId = identity.userId;
      } catch {
        throw new Error("invalid_wiki_identity");
      }
    } else {
      userId = await verifyWikiIdentity(
        data.wikiInitData,
        verificationKey,
        now(),
      );
      wikiProof = Buffer.from(
        await seal({ userId, expiresAt: now() + 86400000 }, "identity-proof"),
      ).toString("base64url");
    }
    const reply = (result) => ({ ...result, wikiProof });
    const id =
      "accounts/" +
      hex(await mac(keyBytes(encryptionKey), "account:" + userId)) +
      ".json";
    if (!["restore", "save", "logout"].includes(data.action))
      throw new Error("invalid_request");
    let found = await current(id);
    if (data.action === "logout") {
      // CAS and a new revision stop a save started before logout resurrecting it.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await write(
            id,
            {
              revision: revision(),
              revoked: true,
              expiresAt: 0,
              accessToken: null,
            },
            found.etag,
          );
          return reply({ status: "disconnected" });
        } catch {
          found = await current(id);
        }
      }
      throw new Error("session_store_unavailable");
    }
    if (data.action === "save") {
      if (
        Object.hasOwn(data, "playerLevel") &&
        (!Number.isSafeInteger(data.playerLevel) || data.playerLevel < 1)
      )
        throw new Error("invalid_request");
      if (
        Object.hasOwn(data, "currentExp") &&
        (!Number.isSafeInteger(data.currentExp) || data.currentExp < 0)
      )
        throw new Error("invalid_request");
      if (
        Object.hasOwn(data, "expToNextLevel") &&
        (!Number.isSafeInteger(data.expToNextLevel) || data.expToNextLevel < 1)
      )
        throw new Error("invalid_request");
      if (
        typeof data.ticket !== "string" ||
        data.ticket !== (await ticket(id, found.record.revision))
      )
        throw new Error("session_changed");
      const token = data.accessToken;
      if (
        typeof token !== "string" ||
        token.length > 16384 ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
      )
        throw new Error("invalid_request");
      const payload = JSON.parse(
        Buffer.from(token.split(".")[1], "base64url").toString(),
      );
      if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now())
        throw new Error("invalid_game_session");
      // Decoding alone isn't verification. The game authenticates this exact JWT;
      // its own Telegram identity field must match signed Wiki launch identity.
      const verificationSignal = AbortSignal.timeout(15000);
      const verificationOptions = {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        credentials: "omit",
        redirect: "error",
        signal: verificationSignal,
      };
      let me;
      let profile;
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          verificationSignal.throwIfAborted();
          me = await fetcher(
            "https://cargohustle.online/api/me",
            verificationOptions,
          );
          if (![500, 502, 503, 504].includes(me.status)) break;
          await me.body?.cancel();
          if (attempt === 2) throw new Error("game_unavailable");
          await pause(1100 * (attempt + 1));
        }
        if (me.status === 429) throw new Error("game_unavailable");
        if (me.ok) profile = await me.json();
      } catch {
        throw new Error("game_unavailable");
      }
      if (!me.ok) throw new Error("invalid_game_session");
      const telegramId =
        typeof profile?.telegramId === "number" &&
        Number.isSafeInteger(profile.telegramId)
          ? String(profile.telegramId)
          : typeof profile?.telegramId === "string" &&
              /^[1-9][0-9]{0,19}$/.test(profile.telegramId)
            ? profile.telegramId
            : null;
      if (telegramId !== userId) throw new Error("game_account_mismatch");
      await write(
        id,
        {
          revision: revision(),
          revoked: false,
          expiresAt: Math.min(payload.exp * 1000, now() + 86400000),
          accessToken: token,
          ...(Number.isSafeInteger(data.playerLevel) && data.playerLevel > 0
            ? { playerLevel: data.playerLevel }
            : {}),
          ...(Number.isSafeInteger(data.currentExp) &&
          data.currentExp >= 0 &&
          Number.isSafeInteger(data.expToNextLevel) &&
          data.expToNextLevel > 0
            ? {
                currentExp: data.currentExp,
                expToNextLevel: data.expToNextLevel,
              }
            : {}),
        },
        found.etag,
      );
      return reply({ status: "saved" });
    }
    const record = found.record;
    if (record.accessToken && record.expiresAt > now()) {
      const hasExperience =
        Number.isSafeInteger(record.currentExp) &&
        record.currentExp >= 0 &&
        Number.isSafeInteger(record.expToNextLevel) &&
        record.expToNextLevel > 0;
      const hasLevel =
        Number.isSafeInteger(record.playerLevel) && record.playerLevel > 0;
      return reply({
        status: "connected",
        accessToken: record.accessToken,
        ...(hasLevel ? { playerLevel: record.playerLevel } : {}),
        ...(hasExperience
          ? {
              currentExp: record.currentExp,
              expToNextLevel: record.expToNextLevel,
            }
          : {}),
        ...(!hasLevel || !hasExperience
          ? { ticket: await ticket(id, record.revision) }
          : {}),
      });
    }
    return reply({
      status: "login-required",
      revoked: record.revoked === true,
      ticket: await ticket(id, record.revision),
    });
  };
}
