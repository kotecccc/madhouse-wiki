import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeAwareAccountFetch } from "../../scripts/bridge/bridge-aware-fetch.mjs";
import { createAccountSnapshots } from "../../scripts/account/snapshots.mjs";
import { createAccountDataService } from "../../scripts/account/data-service.mjs";
import { createProxy } from "../../api/[...path].js";
import {
  createBridgeBrowserSessions,
  resolveBridgeBrowserSession,
} from "../../scripts/bridge/browser-session.mjs";

const url = "https://cargohustle.online/api/me";

test("expired bridge credentials cannot join another account read", async () => {
  const expired = `Bearer header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  const rows = new Map();
  const store = {
    readSnapshots: () => [...rows.values()],
    writeSnapshot: (id, value) => rows.set(String(id), structuredClone(value)),
    list: () => [],
  };
  const snapshots = createAccountSnapshots({ store, now: () => 2000 });
  snapshots.saveBridgeProfile(expired, { playerId: 42 });
  const boundary = createBridgeAwareAccountFetch({
    snapshots,
    accounts: {
      resolveCredential: () => ({
        policy: "bridge_required",
        owner: "101",
        epoch: 1,
        credentialCurrent: true,
      }),
      read: () => ({ playerId: "42", revision: 1 }),
    },
    directRoutes: {
      resolve: () => null,
      registerVerifiedDirect() {},
      withDirectLease() {},
    },
    accountService: {
      profile: async () => {
        throw new Error("unexpected game request");
      },
    },
  });
  await assert.rejects(boundary.shareScope(expired, "/api/me"), {
    code: "game_credentials_stale",
  });
});

test("strict proxy reads use the verified bridge session offline and never dispatch to a transport", async () => {
  const records = new Map();
  const store = {
    readSnapshots: () => [...records.values()],
    writeSnapshot: (id, value) =>
      records.set(String(id), structuredClone(value)),
    list: () => [],
  };
  const token = `Bearer x.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.x`;
  const snapshots = createAccountSnapshots({
    store,
    now: () => 5000,
    fetcher: () => assert.fail("game fetch"),
  });
  snapshots.saveBridgeProfile(token, { playerId: 42, nickname: "Saved" });
  let active = true;
  let deviceCalls = 0;
  const sessions = createBridgeBrowserSessions({
    key: Buffer.alloc(32, 7),
    now: () => 5000,
  });
  const device = { deviceId: "device", generation: 1 };
  const wikiToken = sessions.issue("101", 2, device);
  const resolve = (auth) =>
    resolveBridgeBrowserSession(auth?.slice(7), {
      sessions,
      accounts: {
        read: () => (active ? { revision: 2, authorization: token } : null),
      },
      devices: { listDevice: () => device },
    });
  const boundary = createBridgeAwareAccountFetch({
    snapshots,
    accounts: {
      resolveCredential: (auth) =>
        resolve(auth)
          ? {
              policy: "bridge_required",
              owner: "101",
              epoch: 2,
              credentialCurrent: true,
            }
          : null,
    },
    directRoutes: {
      resolve: () => null,
      registerVerifiedDirect() {},
      withDirectLease: () => assert.fail("direct"),
    },
    accountService: {
      profile: () => {
        deviceCalls++;
        throw Error("offline");
      },
    },
    canonicalCredential: (auth) => resolve(auth)?.authorization || auth,
  });
  const proxy = createProxy(() => assert.fail("game fetch"), {
    storedFetch: boundary.readStored,
  });
  const call = async (path) => {
    const response = {
      headers: {},
      setHeader(k, v) {
        this.headers[k] = v;
      },
      end(body) {
        this.body = body;
      },
    };
    await proxy(
      {
        method: "GET",
        url: path,
        headers: {
          authorization: `Bearer ${wikiToken}`,
          "x-madhouse-stored-only": "1",
        },
      },
      response,
    );
    return response;
  };
  assert.equal((await call("/api/me")).statusCode, 200);
  assert.equal((await call("/api/rooms")).statusCode, 404);
  active = false;
  assert.equal((await call("/api/me")).statusCode, 401);
  assert.equal(deviceCalls, 0);
});
const options = (token = "valid") => ({
  headers: { Authorization: `Bearer ${token}` },
});
function setup({
  lookup = () => null,
  identity = () => null,
  route = () => null,
  profile = async () => ({ profile: { playerId: 42 } }),
  read,
  direct = async () => new Response("direct"),
} = {}) {
  let calls = 0;
  const snapshots = {
    identity,
    fetch: async (...args) => {
      calls += 1;
      return direct(...args);
    },
    liveFetch: async (...args) => {
      calls += 1;
      return direct(...args);
    },
  };
  const accounts = { resolveCredential: lookup };
  const directRoutes = {
    resolve: route,
    registerVerifiedDirect: () => {},
    withDirectLease: async (_identity, _epoch, run) => run(() => {}),
  };
  return {
    boundary: createBridgeAwareAccountFetch({
      snapshots,
      accounts,
      directRoutes,
      accountService: { profile, ...(read ? { read } : {}) },
    }),
    calls: () => calls,
  };
}

test("selected reads use the bridge and never fall back on failure", async () => {
  let calls = 0;
  const f = setup({
    lookup: () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
      credentialCurrent: true,
    }),
    read: async (owner, path) => {
      assert.equal(owner, "101");
      assert.equal(path, "/api/friends?limit=2");
      if (calls++) throw new Error("offline");
      return { status: 200, body: Buffer.from("[]") };
    },
  });
  const target = "https://cargohustle.online/api/friends?limit=2";
  assert.deepEqual(
    await (await f.boundary.fetch(target, options())).json(),
    [],
  );
  await assert.rejects(f.boundary.fetch(target, options()), {
    message: "offline",
  });
  await assert.rejects(
    f.boundary.fetch("https://cargohustle.online/api/me?extra=1", options()),
    { code: "bridge_operation_not_supported" },
  );
  assert.equal(f.calls(), 0);
});

test("registered bridge token reads only through bridge even if snapshot exists", async () => {
  const fixture = setup({
    lookup: () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
      credentialCurrent: true,
    }),
    identity: () => ({ playerId: 42 }),
  });
  assert.deepEqual(
    await (await fixture.boundary.fetch(url, options())).json(),
    { playerId: 42 },
  );
  assert.equal(fixture.calls(), 0);
});

test("offline, stale or unrecognized bridge credentials cannot invoke the direct transport", async () => {
  const offline = setup({
    lookup: () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
      credentialCurrent: true,
    }),
    profile: async () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(offline.boundary.fetch(url, options()));
  assert.equal(offline.calls(), 0);
  const stale = setup({
    lookup: () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 2,
      credentialCurrent: false,
    }),
  });
  await assert.rejects(stale.boundary.fetch(url, options()), {
    code: "game_credentials_stale",
  });
  const unknown = setup({
    identity: () => ({ playerId: 42 }),
    route: () => ({ policy: "bridge_required", owner: "101", epoch: 1 }),
  });
  await assert.rejects(unknown.boundary.fetch(url, options()), {
    code: "game_credentials_stale",
  });
  assert.equal(unknown.calls(), 0);
});

test("unknown credentials and unsupported bridge actions fail closed", async () => {
  const unknown = setup();
  await assert.rejects(unknown.boundary.fetch(url, options()), {
    code: "game_route_unavailable",
  });
  assert.equal(unknown.calls(), 0);
  const bridge = setup({
    lookup: () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
      credentialCurrent: true,
    }),
  });
  await assert.rejects(
    bridge.boundary.liveFetch(
      "https://cargohustle.online/api/friends",
      options(),
    ),
    { code: "bridge_operation_not_supported" },
  );
  await assert.rejects(
    bridge.boundary.liveFetch(url, { ...options(), method: "POST" }),
    { code: "bridge_operation_not_supported" },
  );
  assert.equal(bridge.calls(), 0);
});

test("verified direct identity cannot change between lease and dispatch", async () => {
  let count = 0;
  const fixture = setup({
    identity: () => ({ playerId: ++count === 1 ? 42 : 43 }),
    route: () => ({ policy: "direct", epoch: 1 }),
  });
  await assert.rejects(fixture.boundary.fetch(url, options()), {
    code: "game_route_unavailable",
  });
  assert.equal(fixture.calls(), 0);
});

test("explicitly admitted direct account uses existing transport", async () => {
  const fixture = setup({
    identity: () => ({ playerId: 42 }),
    route: () => ({ policy: "direct", epoch: 1 }),
  });
  assert.equal(
    await (await fixture.boundary.fetch(url, options())).text(),
    "direct",
  );
  assert.equal(fixture.calls(), 1);
});

test("real snapshot identities cannot send an old bridge token directly", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } =
    await import("../../scripts/automation/state-store.mjs");
  const { createAccountSnapshots } =
    await import("../../scripts/account/snapshots.mjs");
  const { createBridgeStorage } =
    await import("../../scripts/bridge/device-storage.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const root = mkdtempSync(join(tmpdir(), "bridge-real-snapshot-"));
  const store = createAutomationStateStore({
    directory: join(root, "automation"),
  });
  const bridge = createBridgeStorage({ directory: join(root, "bridge") });
  let calls = 0;
  const snapshots = createAccountSnapshots({
    store,
    fetcher: async (_url, init) => {
      calls += 1;
      const token = new Headers(init.headers).get("authorization");
      return new Response(
        JSON.stringify({
          playerId: token === "Bearer old" ? 42 : 43,
          telegramId: token === "Bearer old" ? 101 : 102,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    },
  });
  try {
    await snapshots.read(url, options("old"));
    await snapshots.read(url, options("other"));
    assert.equal(calls, 2);
    const device = bridge.registry.redeemInvitation(
      bridge.registry.issueInvitation("101").invitation,
    );
    bridge.accounts.saveVerified({
      owner: "101",
      playerId: "42",
      authorization: "Bearer new",
      expectedRevision: 0,
      deviceId: device.deviceId,
      generation: 1,
    });
    const boundary = createBridgeAwareAccountFetch({
      snapshots,
      accounts: bridge.accounts,
      directRoutes: bridge.directRoutes,
      accountService: { profile: async () => ({ profile: { playerId: 42 } }) },
    });
    await assert.rejects(boundary.fetch(url, options("old")), {
      code: "game_credentials_stale",
    });
    assert.deepEqual(await (await boundary.fetch(url, options("new"))).json(), {
      playerId: 42,
      telegramId: 101,
    });
    assert.equal(snapshots.credentialPlayerId("Bearer new"), 42);
    assert.ok(snapshots.resourceVersions("Bearer new")?.sections["/api/me"]);
    assert.equal(calls, 2);
    assert.deepEqual(await boundary.verifyLocal("Bearer other"), {
      policy: "direct",
    });
    const data = createAccountDataService({ transport: boundary, snapshots });
    assert.equal(
      (await (await data.fetch(url, options("other"))).json()).playerId,
      43,
    );
    assert.deepEqual(
      bridge.directRoutes.resolve({ playerId: "43", owner: "102" }),
      {
        policy: "direct",
        epoch: 1,
      },
    );
    assert.equal((await boundary.liveFetch(url, options("other"))).status, 200);
    assert.equal(calls, 3);
    const db = new DatabaseSync(join(root, "bridge", "devices.sqlite"));
    try {
      db.exec("DELETE FROM mobile_bridge_accounts");
    } finally {
      db.close();
    }
    await assert.rejects(boundary.fetch(url, options("old")), {
      code: "game_route_unavailable",
    });
    assert.equal(calls, 3);
  } finally {
    bridge.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("catalogue sync uses the same boundary and cannot bypass an offline bridge", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { CatalogueStore } = await import("../../scripts/catalogue/store.mjs");
  const { createCatalogueSyncApi } =
    await import("../../scripts/catalogue/sync-api.mjs");
  const dir = mkdtempSync(join(tmpdir(), "bridge-catalogue-"));
  const file = join(dir, "catalogue.sqlite");
  const store = new CatalogueStore(process.cwd(), file);
  store.capture("/api/bosses/49", 200, { id: 49, name: "fake" });
  store.close();
  let direct = 0;
  const fixture = setup({
    lookup: () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
      credentialCurrent: true,
    }),
    direct: () => {
      direct += 1;
      return new Response();
    },
  });
  try {
    const api = createCatalogueSyncApi({
      root: process.cwd(),
      storeBlob: { download: async () => ({ file, mutable: true }) },
      fetcher: fixture.boundary.fetch,
    });
    const request = new Request("http://localhost/api/catalogue", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${"x".repeat(24)}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bossId: "49" }),
    });
    const response = await api(request);
    assert.equal(response.status, 503);
    assert.equal(direct, 0);
    assert.equal(fixture.calls(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("profile reads with independent cancellation do not share a bridge request", async () => {
  let calls = 0;
  let release;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const fixture = setup({
    lookup: () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
      credentialCurrent: true,
    }),
    profile: async (_owner, { signal }) => {
      calls += 1;
      await waiting;
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      return { profile: { playerId: 42 } };
    },
  });
  const controller = new AbortController();
  const first = fixture.boundary.fetch(url, {
    ...options(),
    signal: controller.signal,
  });
  const second = fixture.boundary.liveFetch(url, options());
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(first, { name: "AbortError" });
  release();
  assert.deepEqual(await (await second).json(), { playerId: 42 });
  assert.equal(calls, 2);
  await fixture.boundary.fetch(url, options());
  assert.equal(calls, 3);
});

test("shared profile reads do not cross credentials", async () => {
  let calls = 0;
  const fixture = setup({
    lookup: () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
      credentialCurrent: true,
    }),
    profile: async () => {
      calls += 1;
      await new Promise((resolve) => setImmediate(resolve));
      return { profile: { playerId: 42 } };
    },
  });
  await Promise.all([
    fixture.boundary.fetch(url, options("one")),
    fixture.boundary.fetch(url, options("two")),
  ]);
  assert.equal(calls, 2);
});

test("bridge profile display uses the saved snapshot only within its TTL", async () => {
  const { createAccountSnapshots } =
    await import("../../scripts/account/snapshots.mjs");
  let clock = 1000;
  const records = new Map();
  const store = {
    readSnapshots: () =>
      [...records.values()].map((value) => structuredClone(value)),
    writeSnapshot: (id, value) => records.set(id, structuredClone(value)),
    list: () => [],
  };
  let calls = 0;
  const make = () => {
    const snapshots = createAccountSnapshots({
      store,
      now: () => clock,
      ttl: 100,
    });
    return createBridgeAwareAccountFetch({
      snapshots,
      accounts: {
        read: () => ({ playerId: "42" }),
        resolveCredential: () => ({
          policy: "bridge_required",
          owner: "101",
          epoch: 1,
          credentialCurrent: true,
        }),
      },
      directRoutes: {
        resolve: () => null,
        registerVerifiedDirect() {},
        withDirectLease() {},
      },
      accountService: {
        profile: async () => ({
          profile: { playerId: 42, nickname: `read-${++calls}` },
        }),
      },
    });
  };
  const boundary = make();
  const snapshotOnly = {
    headers: { Authorization: "Bearer valid", "X-Madhouse-Snapshot-Only": "1" },
  };
  assert.equal((await boundary.fetch(url, snapshotOnly)).status, 404);
  assert.equal(calls, 0);
  await boundary.liveFetch(url, options());
  assert.equal(
    (await (await boundary.fetch(url, snapshotOnly)).json()).nickname,
    "read-1",
  );
  clock += 200;
  const restarted = make();
  const refreshed = await restarted.fetch(url, options());
  assert.equal((await refreshed.json()).nickname, "read-2");
  assert.equal(calls, 2);
  const manual = {
    headers: {
      Authorization: "Bearer valid",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  };
  assert.equal(
    (await (await restarted.fetch(url, manual)).json()).nickname,
    "read-3",
  );
  const limited = await restarted.fetch(url, manual);
  assert.equal((await limited.json()).nickname, "read-3");
  assert.equal(limited.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(calls, 3);
  const refresh = {
    headers: {
      Authorization: "Bearer valid",
      "X-Madhouse-Snapshot-Refresh": "live",
    },
  };
  assert.equal(
    (await (await restarted.fetch(url, refresh)).json()).nickname,
    "read-4",
  );
  assert.equal(calls, 4);
});
