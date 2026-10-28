import assert from "node:assert/strict";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConnectorApi } from "../../connector/game-auth-api.js";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";
import { createConnectorLeaseIpcHandler } from "../../scripts/bridge/connector-lease-ipc.mjs";
import { createRemoteConnectorGuard } from "../../scripts/bridge/remote-connector-guard.mjs";

const now = 1_800_000_000_000;
const verificationKey = "11".repeat(32);
function signedOwner(id) {
  const data = new URLSearchParams({
    auth_date: String(now / 1000),
    user: JSON.stringify({ id }),
  });
  const text = [...data.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  data.set(
    "hash",
    createHmac("sha256", Buffer.from(verificationKey, "hex"))
      .update(text)
      .digest("hex"),
  );
  return data.toString();
}
function gameLaunch(id) {
  return new URLSearchParams({
    auth_date: "1",
    hash: "a".repeat(64),
    user: JSON.stringify({ id }),
  }).toString();
}
function request(id, owner = id) {
  return new Request("https://connect.example/api/game-session", {
    method: "POST",
    headers: {
      Origin: "https://connect.example",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      initData: gameLaunch(id),
      wikiInitData: signedOwner(owner),
    }),
  });
}

test("remote Connector fence honors signed owner, game identity and bound bridge route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "remote-connector-"));
  const storage = createBridgeStorage({ directory: dir });
  const ipcKey = randomBytes(32);
  const handler = createConnectorLeaseIpcHandler({
    leases: storage.connectorLeases,
    directCredentials: storage.directCredentials,
    consumeNonce: storage.consumeConnectorNonce,
    key: ipcKey,
    now: () => now,
  });
  const guard = createRemoteConnectorGuard({
    endpoint: "http://wiki:9094/internal/bridge/connector-lease",
    key: ipcKey,
    verificationKey,
    now: () => now,
    fetcher: (url, init) => handler(new Request(url, init), true),
  });
  let calls = 0;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: [],
    withGameSessionLease: guard.withGameSessionLease,
    fetcher: async (url) => {
      calls += 1;
      return url.endsWith("/api/me")
        ? Response.json({ telegramId: 102, playerId: 43 })
        : new Response('{"accessToken":"header.payload.signature"}');
    },
  });
  try {
    const device = storage.registry.redeemInvitation(
      storage.registry.issueInvitation("101").invitation,
    );
    storage.accounts.saveVerified({
      owner: "101",
      playerId: "42",
      authorization: "Bearer token",
      expectedRevision: 0,
      deviceId: device.deviceId,
      generation: 1,
    });
    assert.equal((await api(request(101))).status, 409);
    assert.equal((await api(request(101, 102))).status, 401);
    assert.equal(calls, 0);
    assert.equal((await api(request(102))).status, 200);
    assert.equal(calls, 2);
    assert.deepEqual(
      storage.directCredentials.resolve("Bearer header.payload.signature"),
      { owner: "102", playerId: "43" },
    );
    assert.deepEqual(storage.connectorLeases.pending("102"), []);
    // A game profile that belongs to another Telegram user cannot enroll.
    assert.equal((await api(request(103))).status, 502);
    assert.deepEqual(
      storage.directCredentials.resolve("Bearer header.payload.signature"),
      {
        owner: "102",
        playerId: "43",
      },
    );
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote Connector uses the dedicated private HTTP listener", async () => {
  const { createBridgeRuntime } =
    await import("../../scripts/bridge/runtime.mjs");
  const { createConnectorPrivateServer } =
    await import("../../scripts/bridge/connector-private-server.mjs");
  const dir = mkdtempSync(join(tmpdir(), "remote-ipc-tcp-"));
  const key = randomBytes(32);
  const runtime = createBridgeRuntime({
    directory: dir,
    botToken: "fake-bot",
    origin: "https://wiki.example",
    now: () => now,
    consume: () => true,
    connectorIpcKey: key,
  });
  const server = createConnectorPrivateServer({
    handle: runtime.connectorLease,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const target = `http://127.0.0.1:${server.address().port}`;
  const guard = createRemoteConnectorGuard({
    endpoint: "http://wiki:9094/internal/bridge/connector-lease",
    key,
    verificationKey,
    now: () => now,
    fetcher: (url, init) => fetch(target + new URL(url).pathname, init),
  });
  let calls = 0;
  const api = createConnectorApi({
    appParams: async () => ({}),
    wikiOrigins: [],
    withGameSessionLease: guard.withGameSessionLease,
    fetcher: async (url) => {
      calls += 1;
      return url.endsWith("/api/me")
        ? Response.json({ telegramId: 102, playerId: 43 })
        : new Response('{"accessToken":"header.payload.signature"}');
    },
  });
  try {
    const response = await api(request(102));
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
    const notFound = await fetch(`${target}/anything`);
    assert.equal(notFound.status, 404);
  } finally {
    runtime.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Connector account-session verification uses the same remote owner fence", async () => {
  const { createAccountSessions } =
    await import("../../connector/account-session.js");
  const dir = mkdtempSync(join(tmpdir(), "remote-connector-session-"));
  const storage = createBridgeStorage({ directory: dir });
  const key = randomBytes(32);
  const handler = createConnectorLeaseIpcHandler({
    leases: storage.connectorLeases,
    directCredentials: storage.directCredentials,
    consumeNonce: storage.consumeConnectorNonce,
    key,
    now: () => now,
  });
  const guard = createRemoteConnectorGuard({
    endpoint: "http://wiki:9094/internal/bridge/connector-lease",
    key,
    verificationKey,
    now: () => now,
    fetcher: (url, init) => handler(new Request(url, init), true),
  });
  const rows = new Map();
  let revision = 0;
  const store = {
    async read(id) {
      return rows.get(id) || null;
    },
    async write(id, value, etag) {
      const old = rows.get(id);
      if ((etag === null && old) || (etag !== null && old?.etag !== etag))
        throw new Error("cas_conflict");
      rows.set(id, { value, etag: String(++revision) });
    },
  };
  const jwt = [
    Buffer.from('{"alg":"HS256"}').toString("base64url"),
    Buffer.from(JSON.stringify({ exp: now / 1000 + 3600 })).toString(
      "base64url",
    ),
    "signature",
  ].join(".");
  let calls = 0;
  const sessions = createAccountSessions({
    store,
    verificationKey,
    encryptionKey: "22".repeat(32),
    now: () => now,
    withOwnerLease: guard.withOwnerLease,
    fetcher: async () => {
      calls += 1;
      return Response.json({ telegramId: 102, playerId: 43 });
    },
  });
  try {
    const device = storage.registry.redeemInvitation(
      storage.registry.issueInvitation("101").invitation,
    );
    storage.accounts.saveVerified({
      owner: "101",
      playerId: "42",
      authorization: "Bearer token",
      expectedRevision: 0,
      deviceId: device.deviceId,
      generation: 1,
    });
    const restore = await sessions({
      action: "restore",
      wikiInitData: signedOwner(101),
    });
    await assert.rejects(
      sessions({
        action: "save",
        wikiInitData: signedOwner(101),
        ticket: restore.ticket,
        accessToken: jwt,
      }),
      { message: "bridge_route_required" },
    );
    assert.equal(calls, 0);
    const other = await sessions({
      action: "restore",
      wikiInitData: signedOwner(102),
    });
    const result = await sessions({
      action: "save",
      wikiInitData: signedOwner(102),
      ticket: other.ticket,
      accessToken: jwt,
    });
    assert.equal(result.status, "saved");
    assert.equal(calls, 1);
    assert.deepEqual(storage.connectorLeases.pending("102"), []);
    assert.deepEqual(storage.directCredentials.resolve(`Bearer ${jwt}`), {
      owner: "102",
      playerId: "43",
    });
    const { createBridgeAwareAccountFetch } =
      await import("../../scripts/bridge/bridge-aware-fetch.mjs");
    let directCalls = 0;
    let finishBody, started;
    const dispatched = new Promise((resolve) => {
      started = resolve;
    });
    const boundary = createBridgeAwareAccountFetch({
      snapshots: {
        identity: () => null,
        fetch: async () => {
          directCalls++;
          started();
          return new Response(
            new ReadableStream({
              start(controller) {
                finishBody = () => {
                  controller.enqueue(
                    new TextEncoder().encode('{"playerId":43}'),
                  );
                  controller.close();
                };
              },
            }),
          );
        },
        liveFetch: async () => assert.fail("unexpected live request"),
      },
      accounts: storage.accounts,
      directRoutes: storage.directRoutes,
      directCredentials: storage.directCredentials,
      accountService: {
        profile: async () => assert.fail("unexpected bridge request"),
      },
    });
    const request = () =>
      boundary.fetch("https://cargohustle.online/api/me", {
        headers: { Authorization: `Bearer ${jwt}` },
      });
    const pending = request();
    await dispatched;
    const otherDevice = storage.registry.redeemInvitation(
      storage.registry.issueInvitation("102").invitation,
    );
    const bind = () =>
      storage.accounts.saveVerified({
        owner: "102",
        playerId: "44",
        authorization: "Bearer bridge-other",
        expectedRevision: 0,
        deviceId: otherDevice.deviceId,
        generation: 1,
      });
    assert.throws(bind, { code: "direct_requests_in_flight" });
    finishBody();
    assert.equal((await pending).status, 200);
    assert.equal(directCalls, 1);
    bind();
    await assert.rejects(request());
    assert.equal(directCalls, 1);
  } finally {
    storage.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid guard configuration cannot silently re-enable direct traffic", async () => {
  const { createAccountSessions } =
    await import("../../connector/account-session.js");
  assert.throws(
    () =>
      createConnectorApi({
        appParams: () => ({}),
        wikiOrigins: [],
        withGameSessionLease: false,
      }),
    { message: "invalid_connector_session_guard" },
  );
  assert.throws(() => createAccountSessions({ withOwnerLease: null }), {
    message: "invalid_connector_owner_guard",
  });
});
