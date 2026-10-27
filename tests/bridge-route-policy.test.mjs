import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createProxy } from "../api/[...path].js";
import { createGameApiClient } from "../scripts/bridge/game-api-client.mjs";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import { createPlayerProgressReader } from "../scripts/account/player-progress.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

function proxyResponse() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(body) {
      this.body = body;
    },
  };
}

test("a persisted bridge-required route blocks snapshot live fetches without direct fallback", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-route-policy-"));
  const store = createAutomationStateStore({ directory });
  let directCalls = 0;
  try {
    const snapshots = createAccountSnapshots({
      store,
      fetcher: async (url, init) => {
        directCalls += 1;
        assert.equal(url, "https://cargohustle.online/api/me");
        assert.equal(init.headers.Authorization, "Bearer known-token");
        return Response.json({ playerId: 77, nickname: "Fixture" });
      },
    });

    const verified = await snapshots.verifyIdentity("Bearer known-token");
    assert.equal(verified.status, 200);
    assert.equal(
      snapshots.routeForAuthorization("Bearer known-token").policy,
      "direct",
    );

    store.selectRoutePolicy(77, {
      policy: "bridge_required",
      activeDeviceId: "00000000-0000-4000-8000-000000000001",
      expectedRouteEpoch: 0,
      updatedAt: 100,
    });
    const route = snapshots.routeForAuthorization("Bearer known-token");
    assert.equal(route.policy, "bridge_required");
    assert.equal(route.routeEpoch, 1);

    const response = await snapshots.liveFetch(
      "https://cargohustle.online/api/me",
      { headers: { Authorization: "Bearer known-token" } },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "game_unavailable" });
    assert.equal(directCalls, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test(
  "live profile progress uses the selected bridge for the verified player",
  { timeout: 5000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "bridge-profile-progress-"));
    const store = createAutomationStateStore({ directory });
    const paths = [];
    let directCalls = 0;
    let snapshots;
    try {
      snapshots = createAccountSnapshots({
        store,
        fetcher: async () => {
          directCalls += 1;
          throw new Error("direct_transport_must_not_be_used");
        },
        bridgeTransport: async ({ path }) => {
          paths.push(path);
          return Response.json(
            path === "/api/me"
              ? { playerId: 77, nickname: "Bridge fixture" }
              : { playerId: 77, level: 136 },
          );
        },
        refreshProfileProgress: createPlayerProgressReader({
          fetcher: (url, init) => snapshots.liveFetch(url, init),
        }),
      });
      snapshots.registerVerifiedCredential("Bearer known-token", 77);
      store.selectRoutePolicy(77, {
        policy: "bridge_required",
        activeDeviceId: "00000000-0000-4000-8000-000000000001",
        expectedRouteEpoch: 0,
        updatedAt: 100,
      });
      const response = await snapshots.read(
        "https://cargohustle.online/api/me",
        {
          headers: {
            Authorization: "Bearer known-token",
            "X-Madhouse-Snapshot-Refresh": "live",
          },
        },
      );
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).exp, { level: 136 });
      assert.deepEqual(paths, ["/api/me", "/api/players/77"]);
      assert.equal(directCalls, 0);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test("friend-list reads use the bridge while unsupported Buddy and friend mutations fail closed", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-buddy-policy-"));
  const store = createAutomationStateStore({ directory });
  let directCalls = 0;
  let bridgeCalls = 0;
  try {
    const snapshots = createAccountSnapshots({
      store,
      fetcher: async () => {
        directCalls += 1;
        return Response.json({});
      },
      bridgeTransport: async () => {
        bridgeCalls += 1;
        return Response.json({});
      },
    });
    snapshots.registerVerifiedCredential("Bearer known-token", 77);
    store.selectRoutePolicy(77, {
      policy: "bridge_required",
      activeDeviceId: "00000000-0000-4000-8000-000000000001",
      expectedRouteEpoch: 0,
      updatedAt: 100,
    });
    const friends = await snapshots.liveFetch(
      "https://cargohustle.online/api/friends?limit=100",
      {
        method: "GET",
        headers: { Authorization: "Bearer known-token" },
      },
    );
    assert.equal(friends.status, 200);
    for (const [method, path] of [
      ["POST", "/api/stash/help-gifts"],
      ["POST", "/api/player-interactions/booster-requests/request-1/fulfill"],
      ["DELETE", "/api/friends/42"],
    ]) {
      const response = await snapshots.liveFetch(
        `https://cargohustle.online${path}`,
        {
          method,
          headers: { Authorization: "Bearer known-token" },
        },
      );
      assert.equal(response.status, 503, `${method} ${path}`);
    }
    assert.equal(directCalls, 0);
    assert.equal(bridgeCalls, 1);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("runtime game proxy delegates route selection to its snapshot transport", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-proxy-route-"));
  const store = createAutomationStateStore({ directory });
  const deviceId = "00000000-0000-4000-8000-000000000001";
  let directCalls = 0;
  let bridgeCalls = 0;
  try {
    const snapshots = createAccountSnapshots({
      store,
      fetcher: async () => {
        directCalls += 1;
        throw new Error("direct_transport_must_not_be_used");
      },
      bridgeTransport: async ({ route, operation, path, method }) => {
        bridgeCalls += 1;
        assert.equal(route.activeDeviceId, deviceId);
        assert.equal(route.routeEpoch, 1);
        assert.equal(operation.operationClass, "read");
        assert.equal(path, "/api/me");
        assert.equal(method, "GET");
        return Response.json({ playerId: 77, nickname: "Bridge fixture" });
      },
    });
    snapshots.registerVerifiedCredential("Bearer known-token", 77);
    store.selectRoutePolicy(77, {
      policy: "bridge_required",
      activeDeviceId: deviceId,
      expectedRouteEpoch: 0,
      updatedAt: 100,
    });

    const proxy = createProxy(snapshots.fetch, {
      routePolicyDelegatedToFetcher: true,
    });
    const response = proxyResponse();
    await proxy(
      {
        method: "GET",
        url: "/api/me",
        headers: { authorization: "Bearer known-token" },
      },
      response,
    );

    assert.equal(response.statusCode, 200);
    assert.deepEqual(JSON.parse(response.body.toString()), {
      playerId: 77,
      nickname: "Bridge fixture",
    });
    assert.equal(bridgeCalls, 1);
    assert.equal(directCalls, 0);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a persisted helper pause blocks reads before either game transport", async () => {
  let directCalls = 0;
  let bridgeCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    bridgeTransport: async () => {
      bridgeCalls += 1;
      return Response.json({ bridged: true });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      playerId: "77",
      routeEpoch: 1,
      activeDeviceId: "00000000-0000-4000-8000-000000000001",
    }),
    allowOperation: ({ accountId }) =>
      accountId === "77" ? "helper_paused" : true,
  });

  await assert.rejects(
    client.request({
      operation: {
        method: "GET",
        path: "/api/me",
        operationClass: "read",
      },
      path: "/api/me",
      headers: { Authorization: "Bearer fixture.token.signature" },
    }),
    { code: "game_helper_paused" },
  );
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 0);
});
