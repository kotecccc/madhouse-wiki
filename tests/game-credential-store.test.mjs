import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import {
  createGameCredentialStore,
  gameCredentialKeyFromEnvironment,
} from "../scripts/account/game-credential-store.mjs";

function fakePrivateStorage() {
  const records = new Map();
  let nextEtag = 1;
  return {
    records,
    async read(path) {
      return records.get(path) || null;
    },
    async write(path, value, expectedEtag) {
      const current = records.get(path) || null;
      if ((current?.etag ?? null) !== expectedEtag)
        throw new Error("storage_precondition_failed");
      const result = { value, etag: `etag-${nextEtag++}` };
      records.set(path, result);
      return { etag: result.etag };
    },
  };
}

function tokenWithExpiry(exp = 2_000_000_000) {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function record({
  ownerId = "7654321",
  playerId = "987654321",
  credentialVersion = 1,
  authGeneration = 1,
  consentGeneration = 4,
  routeEpoch = 5,
  revoked = false,
  accessToken = tokenWithExpiry(),
  expiresAt = 1_900_000_000_000,
} = {}) {
  return {
    schemaVersion: 1,
    ownerId,
    playerId,
    credentialVersion,
    authOperationId: "00000000-0000-4000-8000-000000000123",
    authGeneration,
    consentGeneration,
    routeEpoch,
    expiresAt: revoked ? 0 : expiresAt,
    revoked,
    accessToken: revoked ? null : accessToken,
  };
}

test("game credential records use a private HMAC path and AES-GCM envelope", async () => {
  const privateStorage = fakePrivateStorage();
  const encryptionKey = randomBytes(32);
  const credentials = createGameCredentialStore({
    store: privateStorage,
    encryptionKey,
  });
  const first = record();
  const committed = await credentials.compareAndSwap({
    ownerId: first.ownerId,
    expectedEtag: null,
    record: first,
  });
  assert.equal(committed.credentialVersion, 1);
  assert.equal(
    await credentials.read(first.ownerId).then((value) => value.etag),
    committed.etag,
  );
  const [path, encrypted] = [...privateStorage.records.entries()][0];
  assert.equal(path.includes(first.ownerId), false);
  assert.equal(encrypted.value.includes(first.accessToken), false);
  assert.deepEqual(await credentials.read(first.ownerId), {
    record: first,
    etag: committed.etag,
  });

  const restored = createGameCredentialStore({
    store: privateStorage,
    encryptionKey,
  });
  assert.deepEqual(await restored.read(first.ownerId), {
    record: first,
    etag: committed.etag,
  });
});

test("credential CAS prevents stale writers and requires consecutive versions", async () => {
  const privateStorage = fakePrivateStorage();
  const credentials = createGameCredentialStore({
    store: privateStorage,
    encryptionKey: randomBytes(32),
  });
  const first = record();
  const initial = await credentials.compareAndSwap({
    ownerId: first.ownerId,
    expectedEtag: null,
    record: first,
  });
  const next = record({
    credentialVersion: 2,
    authGeneration: 2,
    consentGeneration: 5,
    accessToken: tokenWithExpiry(2_100_000_000),
    expiresAt: 2_000_000_000_000,
  });
  const updated = await credentials.compareAndSwap({
    ownerId: first.ownerId,
    expectedEtag: initial.etag,
    record: next,
  });
  assert.equal(updated.credentialVersion, 2);
  await assert.rejects(
    credentials.compareAndSwap({
      ownerId: first.ownerId,
      expectedEtag: initial.etag,
      record: record({ credentialVersion: 2 }),
    }),
    { code: "game_credential_conflict" },
  );
  await assert.rejects(
    credentials.compareAndSwap({
      ownerId: first.ownerId,
      expectedEtag: updated.etag,
      record: record({
        credentialVersion: 4,
        authGeneration: 3,
        consentGeneration: 6,
      }),
    }),
    { code: "game_credential_version_conflict" },
  );
});

test("credential tombstone removes the token and still advances its version", async () => {
  const privateStorage = fakePrivateStorage();
  const credentials = createGameCredentialStore({
    store: privateStorage,
    encryptionKey: randomBytes(32),
  });
  const live = record();
  const first = await credentials.compareAndSwap({
    ownerId: live.ownerId,
    expectedEtag: null,
    record: live,
  });
  const tombstone = record({
    credentialVersion: 2,
    authGeneration: 2,
    consentGeneration: 5,
    revoked: true,
    accessToken: null,
  });
  const second = await credentials.compareAndSwap({
    ownerId: live.ownerId,
    expectedEtag: first.etag,
    record: tombstone,
  });
  assert.equal(second.credentialVersion, 2);
  assert.deepEqual(await credentials.read(live.ownerId), {
    record: tombstone,
    etag: second.etag,
  });
});

test("credential store rejects malformed keys, records, and ciphertext", async () => {
  assert.equal(gameCredentialKeyFromEnvironment("a".repeat(43)), null);
  assert.throws(
    () =>
      createGameCredentialStore({
        store: fakePrivateStorage(),
        encryptionKey: "invalid",
      }),
    /game_credential_key_invalid/u,
  );
  const privateStorage = fakePrivateStorage();
  const key = randomBytes(32);
  const credentials = createGameCredentialStore({
    store: privateStorage,
    encryptionKey: key,
  });
  const first = record();
  await assert.rejects(
    credentials.compareAndSwap({
      ownerId: first.ownerId,
      expectedEtag: null,
      record: { ...first, playerId: "01" },
    }),
    { code: "game_credential_record_invalid" },
  );
  await credentials.compareAndSwap({
    ownerId: first.ownerId,
    expectedEtag: null,
    record: first,
  });
  const [path, stored] = [...privateStorage.records.entries()][0];
  const envelope = JSON.parse(stored.value);
  envelope.data = `${envelope.data[0] === "A" ? "B" : "A"}${envelope.data.slice(1)}`;
  privateStorage.records.set(path, {
    value: JSON.stringify(envelope),
    etag: "tampered-etag",
  });
  await assert.rejects(credentials.read(first.ownerId), {
    code: "game_credential_record_authentication_failed",
  });
});
