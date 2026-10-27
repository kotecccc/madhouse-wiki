import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createStorageServer } from "../scripts/storage/server.mjs";
import { createBlobSessionStore } from "../connector/blob-session-store.js";
import { createGameCredentialStore } from "../scripts/account/game-credential-store.mjs";

test("encrypted game credentials round-trip through the actual storage HTTP adapter and CAS", async () => {
  const directory = mkdtempSync(join(tmpdir(), "game-credential-storage-"));
  const storageToken = "fixture-storage-token-at-least-thirty-two-bytes";
  const server = createStorageServer({
    root: directory,
    token: storageToken,
    port: 0,
  });
  const previousOrigin = process.env.MADHOUSE_STORAGE_ORIGIN;
  const previousToken = process.env.MADHOUSE_STORAGE_TOKEN;
  await once(server, "listening");
  process.env.MADHOUSE_STORAGE_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  process.env.MADHOUSE_STORAGE_TOKEN = storageToken;
  const key = randomBytes(32);
  const token = `e30.${Buffer.from(JSON.stringify({ exp: 2000000000 })).toString("base64url")}.fixture`;
  const record = {
    schemaVersion: 1,
    ownerId: "54321",
    playerId: "101",
    credentialVersion: 1,
    authOperationId: "00000000-0000-4000-8000-000000000001",
    authGeneration: 1,
    consentGeneration: 1,
    routeEpoch: 1,
    expiresAt: 1900000000000,
    revoked: false,
    accessToken: token,
  };
  try {
    const credentials = createGameCredentialStore({
      store: createBlobSessionStore(),
      encryptionKey: key,
    });
    const result = await credentials.compareAndSwap({
      ownerId: record.ownerId,
      expectedEtag: null,
      record,
    });
    assert.equal(result.credentialVersion, 1);
    const saved = await credentials.read(record.ownerId);
    assert.deepEqual(saved.record, record);
    assert.equal(saved.etag, result.etag);
    const files = readdirSync(join(directory, "game-credentials"));
    assert.equal(files.length, 1);
    assert.match(files[0], /^[a-f0-9]{64}\.json$/u);
    const envelope = readFileSync(
      join(directory, "game-credentials", files[0]),
      "utf8",
    );
    assert.doesNotMatch(envelope, /54321|fixture|accessToken/u);
    await assert.rejects(
      () =>
        credentials.compareAndSwap({
          ownerId: record.ownerId,
          expectedEtag: '"stale"',
          record: { ...record, credentialVersion: 2 },
        }),
      /game_credential_conflict/u,
    );
    assert.deepEqual((await credentials.read(record.ownerId)).record, record);
    const invalid = await fetch(
      `${process.env.MADHOUSE_STORAGE_ORIGIN}/v1/objects/game-credentials%2F${"g".repeat(64)}.json`,
      { headers: { authorization: `Bearer ${storageToken}` } },
    );
    assert.equal(invalid.status, 404);
  } finally {
    server.close();
    await once(server, "close");
    if (previousOrigin === undefined)
      delete process.env.MADHOUSE_STORAGE_ORIGIN;
    else process.env.MADHOUSE_STORAGE_ORIGIN = previousOrigin;
    if (previousToken === undefined) delete process.env.MADHOUSE_STORAGE_TOKEN;
    else process.env.MADHOUSE_STORAGE_TOKEN = previousToken;
    rmSync(directory, { recursive: true, force: true });
  }
});
