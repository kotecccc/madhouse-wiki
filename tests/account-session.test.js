import test from "node:test";
import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import {
  createAccountSessions,
  verifyWikiIdentity,
} from "../connector/account-session.js";
const verificationKey = "11".repeat(32);
const encryptionKey = "22".repeat(32);
const now = 1900000000000;
const signed = (id = 42, time = now, key = verificationKey) => {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(time / 1000)),
    user: JSON.stringify({ id }),
    signature: "signed-public-field",
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  params.set(
    "hash",
    createHmac("sha256", Buffer.from(key, "hex")).update(check).digest("hex"),
  );
  return params.toString();
};
const accountId = (id) =>
  "accounts/" +
  createHmac("sha256", Buffer.from(encryptionKey, "hex"))
    .update("account:" + id)
    .digest("hex") +
  ".json";
async function sealRecord(id, record) {
  const iv = webcrypto.getRandomValues(new Uint8Array(12));
  const key = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(encryptionKey, "hex"),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const cipher = await webcrypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
    key,
    new TextEncoder().encode(JSON.stringify(record)),
  );
  return JSON.stringify({
    v: 1,
    iv: Buffer.from(iv).toString("base64url"),
    data: Buffer.from(cipher).toString("base64url"),
  });
}
async function openRecord(id, value) {
  const envelope = JSON.parse(value);
  const key = await webcrypto.subtle.importKey(
    "raw",
    Buffer.from(encryptionKey, "hex"),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const plain = await webcrypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: Buffer.from(envelope.iv, "base64url"),
      additionalData: new TextEncoder().encode(id),
    },
    key,
    Buffer.from(envelope.data, "base64url"),
  );
  return JSON.parse(new TextDecoder().decode(plain));
}
function setup() {
  const records = new Map();
  let serial = 0;
  let clock = now;
  const store = {
    async read(key) {
      return records.get(key) || null;
    },
    async write(key, value, etag) {
      const old = records.get(key);
      if ((etag === null && old) || (etag !== null && old?.etag !== etag))
        throw new Error("cas_conflict");
      records.set(key, { value, etag: String(++serial) });
    },
  };
  const api = createAccountSessions({
    store,
    verificationKey,
    encryptionKey,
    now: () => clock,
  });
  const call = (action, extra = {}, id = 42) =>
    api({ action, wikiInitData: signed(id, clock), ...extra });
  return {
    api,
    call,
    records,
    store,
    setTime: (value) => (clock = value),
  };
}
test("signed Wiki identity rejects tampering, duplicate keys, wrong bot keys and stale or future launches", async () => {
  assert.equal(await verifyWikiIdentity(signed(), verificationKey, now), "42");
  for (const data of [
    signed().replace("42", "99"),
    signed() + "&user=%7B%22id%22%3A99%7D",
    signed(42, now, "33".repeat(32)),
    signed(42, now - 301000),
    signed(42, now + 31000),
  ])
    await assert.rejects(
      verifyWikiIdentity(data, verificationKey, now),
      /invalid_wiki_identity/,
    );
});
test("logout overwrites a legacy Connector JWT record with an encrypted tombstone", async () => {
  const s = setup();
  const id = accountId(42);
  const legacyToken = [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString(
      "base64url",
    ),
    "legacy-game-signature",
  ].join(".");
  s.records.set(id, {
    value: await sealRecord(id, {
      revision: "legacy-revision",
      revoked: false,
      expiresAt: now + 3600000,
      accessToken: legacyToken,
      playerLevel: 17,
    }),
    etag: "legacy-etag",
  });

  const result = await s.call("logout");

  assert.equal(result.status, "disconnected");
  assert.equal(typeof result.wikiProof, "string");
  assert.equal(Object.hasOwn(result, "accessToken"), false);
  assert.equal(s.records.size, 1);
  assert.equal(id.includes("42"), false);
  const tombstone = await openRecord(id, s.records.get(id).value);
  assert.equal(tombstone.revoked, true);
  assert.equal(tombstone.expiresAt, 0);
  assert.equal(tombstone.accessToken, null);
  assert.equal(Object.hasOwn(tombstone, "playerLevel"), false);
  assert.notEqual(tombstone.revision, "legacy-revision");
});
test("Connector account-session no longer exposes legacy restore or save", async () => {
  const s = setup();
  for (const action of ["restore", "save"])
    await assert.rejects(s.call(action), /game_auth_server_managed_required/);
  assert.equal(s.records.size, 0);
});
test("sealed Wiki identity proofs remain owner-bound and expire", async () => {
  const s = setup();
  const initial = await s.call("logout");
  const sameOwner = await s.api({
    action: "logout",
    wikiProof: initial.wikiProof,
    wikiInitData: signed(42, now),
  });
  assert.equal(sameOwner.status, "disconnected");
  await assert.rejects(
    s.api({
      action: "logout",
      wikiProof: initial.wikiProof,
      wikiInitData: signed(99, now),
    }),
    /invalid_wiki_identity/,
  );
  s.setTime(now + 86400001);
  await assert.rejects(
    s.api({ action: "logout", wikiProof: initial.wikiProof }),
    /invalid_wiki_identity/,
  );
  await assert.rejects(
    s.api({
      action: "logout",
      wikiProof: initial.wikiProof.slice(0, -4) + "bad",
    }),
    /invalid_wiki_identity/,
  );
});
test("legacy Connector tombstones remain account-isolated", async () => {
  const s = setup();
  await s.call("logout", {}, 42);
  await s.call("logout", {}, 99);
  assert.equal(s.records.size, 2);
  assert.equal(
    [...s.records.keys()].some((key) => key.includes("42")),
    false,
  );
  assert.equal(
    [...s.records.keys()].some((key) => key.includes("99")),
    false,
  );
  for (const [id, stored] of s.records)
    assert.equal((await openRecord(id, stored.value)).accessToken, null);
});
