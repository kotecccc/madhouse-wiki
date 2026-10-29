import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeAwareAccountFetch } from "../../scripts/bridge/bridge-aware-fetch.mjs";

const url = "https://cargohustle.online/api/me";
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
    });
    assert.equal(calls, 2);
    assert.deepEqual(await boundary.verifyLocal("Bearer other"), {
      policy: "direct",
    });
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

test("concurrent login profile reads share one bridge request and cancellation is independent", async () => {
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
      assert.equal(signal.aborted, false);
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
  assert.equal(calls, 1);
  await fixture.boundary.fetch(url, options());
  assert.equal(calls, 2);
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

test("login reuses a persisted bridge profile until an explicit refresh", async () => {
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
  assert.equal(
    (await (await boundary.fetch(url, snapshotOnly)).json()).nickname,
    "read-1",
  );
  clock += 200;
  const restarted = make();
  const stale = await restarted.fetch(url, options());
  assert.equal((await stale.json()).nickname, "read-1");
  assert.equal(stale.headers.get("X-Madhouse-Section-Updated"), "1000");
  assert.equal(calls, 1);
  const refresh = {
    headers: {
      Authorization: "Bearer valid",
      "X-Madhouse-Snapshot-Refresh": "live",
    },
  };
  assert.equal(
    (await (await restarted.fetch(url, refresh)).json()).nickname,
    "read-2",
  );
  assert.equal(calls, 2);
});
