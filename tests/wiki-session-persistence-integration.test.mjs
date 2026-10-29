import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createAccountSessions } from "../connector/account-session.js";
import { createBlobSessionStore } from "../connector/blob-session-store.js";
import { createAutomationRuntime } from "../scripts/automation/runtime.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createStorageServer } from "../scripts/storage/server.mjs";

const verificationKey = "11".repeat(32);
const encryptionKey = "22".repeat(32);
const signingKey = "33".repeat(32);
const storageToken = "temporary-test-storage-token-at-least-32-bytes";

function wikiInitData(userId, now) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(now / 1000)),
    user: JSON.stringify({ id: userId }),
    signature: "signed-public-field",
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  params.set(
    "hash",
    createHmac("sha256", Buffer.from(verificationKey, "hex"))
      .update(check)
      .digest("hex"),
  );
  return params.toString();
}

async function wikiProxy(runtime, path, credential) {
  const response = {
    setHeader() {},
    end(body) {
      this.body = body;
    },
  };
  await runtime.proxy(
    {
      method: "GET",
      url: path,
      headers: {
        authorization: `Bearer ${credential}`,
        "x-madhouse-stored-only": "1",
      },
    },
    response,
  );
  return response;
}

test("independent Connector and Wiki runtimes share durable sessions and snapshots across restart and revocation without game traffic", async (t) => {
  const storageRoot = mkdtempSync(join(tmpdir(), "wiki-session-storage-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "wiki-session-state-"));
  const previousOrigin = process.env.MADHOUSE_STORAGE_ORIGIN;
  const previousToken = process.env.MADHOUSE_STORAGE_TOKEN;
  const server = createStorageServer({
    root: storageRoot,
    token: storageToken,
    port: 0,
  });
  await once(server, "listening");
  process.env.MADHOUSE_STORAGE_ORIGIN = `http://127.0.0.1:${server.address().port}`;
  process.env.MADHOUSE_STORAGE_TOKEN = storageToken;

  let runtime;
  t.after(async () => {
    runtime?.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(storageRoot, { recursive: true, force: true });
    rmSync(stateDirectory, { recursive: true, force: true });
    if (previousOrigin === undefined)
      delete process.env.MADHOUSE_STORAGE_ORIGIN;
    else process.env.MADHOUSE_STORAGE_ORIGIN = previousOrigin;
    if (previousToken === undefined) delete process.env.MADHOUSE_STORAGE_TOKEN;
    else process.env.MADHOUSE_STORAGE_TOKEN = previousToken;
  });

  const now = Date.now();
  let connectorGameCalls = 0;
  const connector = createAccountSessions({
    store: createBlobSessionStore(),
    verificationKey,
    encryptionKey,
    wikiSessionKey: signingKey,
    now: () => now,
    fetcher: async () => {
      connectorGameCalls++;
      return Response.json({ telegramId: 42, playerId: 2042 });
    },
  });
  const login = await connector({
    action: "restore",
    wikiInitData: wikiInitData(42, now),
  });
  const gameJwt = [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString(
      "base64url",
    ),
    "game-signature",
  ].join(".");
  const saved = await connector({
    action: "save",
    wikiProof: login.wikiProof,
    ticket: login.ticket,
    accessToken: gameJwt,
  });
  assert.equal(saved.status, "saved");
  assert.equal(
    connectorGameCalls,
    1,
    "issuance uses only its fake profile response",
  );

  // Seed one durable snapshot in the normal encrypted automation state store.
  const snapshotSeed = createAutomationStateStore({
    directory: stateDirectory,
  });
  snapshotSeed.writeSnapshot("2042", {
    schemaVersion: 1,
    playerId: "2042",
    sections: {
      "/api/me": {
        data: { playerId: 2042, nickname: "Saved profile" },
        updatedAt: now,
      },
    },
    credentialHashes: [],
    health: { status: "available", failedSections: [] },
  });
  snapshotSeed.close();

  let gameFetchCalls = 0;
  const makeRuntime = () =>
    createAutomationRuntime({
      env: {
        MADHOUSE_AUTOMATION_STATE_DIR: stateDirectory,
        MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
        ACCOUNT_SESSION_KEY: encryptionKey,
        WIKI_SESSION_KEY: signingKey,
      },
      gameFetcher: async () => {
        gameFetchCalls++;
        throw new Error("unexpected game request");
      },
    });

  runtime = await makeRuntime();
  const issued = await wikiProxy(runtime, "/api/me", saved.wikiSession);
  assert.equal(issued.statusCode, 200);
  assert.deepEqual(JSON.parse(issued.body), {
    playerId: 2042,
    nickname: "Saved profile",
  });

  // A new runtime reads the same encrypted snapshot and independently verifies the shared session.
  runtime.close();
  runtime = await makeRuntime();
  const afterRestart = await wikiProxy(runtime, "/api/me", saved.wikiSession);
  assert.equal(afterRestart.statusCode, 200);
  assert.deepEqual(JSON.parse(afterRestart.body), JSON.parse(issued.body));

  const logout = await createAccountSessions({
    store: createBlobSessionStore(),
    verificationKey,
    encryptionKey,
    wikiSessionKey: signingKey,
    now: () => now,
    fetcher: async () => {
      connectorGameCalls++;
      throw new Error("unexpected game request");
    },
  })({ action: "logout", wikiProof: login.wikiProof });
  assert.equal(logout.status, "disconnected");
  assert.equal(
    (await wikiProxy(runtime, "/api/me", saved.wikiSession)).statusCode,
    401,
  );

  runtime.close();
  runtime = await makeRuntime();
  const revoked = await wikiProxy(runtime, "/api/me", saved.wikiSession);
  assert.equal(revoked.statusCode, 401);
  assert.equal(connectorGameCalls, 1);
  assert.equal(gameFetchCalls, 0);
});
