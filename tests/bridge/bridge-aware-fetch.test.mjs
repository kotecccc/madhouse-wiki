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
      accountService: { profile },
    }),
    calls: () => calls,
  };
}

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
