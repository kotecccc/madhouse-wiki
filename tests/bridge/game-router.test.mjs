import assert from "node:assert/strict";
import { test } from "node:test";
import { createGameRouter } from "../../scripts/bridge/game-router.mjs";

const identity = Object.freeze({ verifiedPlayer: "101" });
const url = "https://cargohustle.online/api/me";

test("work task is passed only to the guarded bridge action", async () => {
  let captured;
  const router = createGameRouter({
    resolveRoute: async () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
    }),
    directFetch: () => assert.fail("direct fallback"),
    bridgeProfile: () => assert.fail("unexpected profile"),
    bridgeAction: async (owner, method, path, options) => {
      captured = { owner, method, path, body: options.body };
      throw Object.assign(new Error("denied"), { code: "denied" });
    },
  });
  const body = JSON.stringify({
    workId: 7,
    taskId: 2,
    locale: "ru",
    operationId: "op",
  });
  await assert.rejects(
    router.fetchGame({
      url: "https://cargohustle.online/api/works/tasks/perform",
      init: { method: "POST", body },
      verifiedIdentity: identity,
    }),
    { code: "denied" },
  );
  assert.deepEqual(captured, {
    owner: "101",
    method: "POST",
    path: "/api/works/tasks/perform",
    body,
  });
});

test("only the fixed work-view POST is routed as a bridge read", async () => {
  let observed;
  const router = createGameRouter({
    resolveRoute: async () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
    }),
    directFetch: () => assert.fail("direct fallback"),
    bridgeProfile: () => assert.fail("unexpected profile"),
    bridgeRead: async (_owner, path, options) => {
      observed = { path, ...options };
      return new Response("{}");
    },
  });
  const body = JSON.stringify({ workId: 7, locale: "ru" });
  await router.fetchGame({
    url: "https://cargohustle.online/api/works/open",
    init: { method: "POST", body },
    verifiedIdentity: identity,
  });
  assert.equal(observed.body, body);
  assert.equal(observed.method, "POST");
  await assert.rejects(
    router.fetchGame({
      url: "https://cargohustle.online/api/works/open",
      init: {
        method: "POST",
        body: '{"workId":7,"locale":"ru","action":true}',
      },
      verifiedIdentity: identity,
    }),
    { code: "bridge_operation_not_supported" },
  );
});

test("bridge profile never falls back to direct on outage", async () => {
  let direct = 0;
  const router = createGameRouter({
    resolveRoute: async () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
    }),
    directFetch: () => {
      direct += 1;
    },
    bridgeProfile: async () => {
      throw Object.assign(new Error("offline"), { code: "bridge_offline" });
    },
  });
  await assert.rejects(router.fetchGame({ url, verifiedIdentity: identity }), {
    code: "bridge_offline",
  });
  assert.equal(direct, 0);
});

test("unsupported operations, unknown identity and unrelated destinations fail closed", async () => {
  let calls = 0;
  const router = createGameRouter({
    resolveRoute: async () => ({
      policy: "bridge_required",
      owner: "101",
      epoch: 1,
    }),
    directFetch: () => {
      calls += 1;
    },
    bridgeProfile: () => {
      calls += 1;
    },
  });
  await assert.rejects(router.fetchGame({ url }), {
    code: "game_identity_unverified",
  });
  await assert.rejects(
    router.fetchGame({
      url: "https://other.example/api/me",
      verifiedIdentity: identity,
    }),
    { code: "game_target_forbidden" },
  );
  await assert.rejects(
    router.fetchGame({
      url,
      init: { method: "POST" },
      verifiedIdentity: identity,
    }),
    { code: "bridge_operation_not_supported" },
  );
  await assert.rejects(
    router.fetchGame({ url: `${url}?extra=1`, verifiedIdentity: identity }),
    { code: "bridge_operation_not_supported" },
  );
  await assert.rejects(
    router.fetchGame({
      url: "https://cargohustle.online/api/friends",
      verifiedIdentity: identity,
    }),
    { code: "bridge_operation_not_supported" },
  );
  assert.equal(calls, 0);
});

test("rejects a profile response when the route changes while awaiting it", async () => {
  let epoch = 1;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const router = createGameRouter({
    resolveRoute: async () => ({
      policy: "bridge_required",
      owner: "101",
      epoch,
    }),
    directFetch: () => assert.fail("must not access direct"),
    bridgeProfile: () => pending,
  });
  const inFlight = router.fetchGame({ url, verifiedIdentity: identity });
  await new Promise((resolve) => setImmediate(resolve));
  epoch = 2;
  release({ profile: {} });
  await assert.rejects(inFlight, { code: "game_route_changed" });
});

test("direct network access requires an explicit valid direct policy", async () => {
  let route = null;
  let calls = 0;
  const router = createGameRouter({
    resolveRoute: async () => route,
    withDirectLease: async (_identity, _epoch, run) => run(() => {}),
    directFetch: (_url, init) => {
      calls += 1;
      assert.equal(init.redirect, "manual");
      return new Response("ok");
    },
    bridgeProfile: () => assert.fail("unexpected bridge"),
  });
  await assert.rejects(router.fetchGame({ url, verifiedIdentity: identity }), {
    code: "game_route_unavailable",
  });
  route = { policy: "direct", epoch: 1 };
  assert.equal(
    await (await router.fetchGame({ url, verifiedIdentity: identity })).text(),
    "ok",
  );
  assert.equal(calls, 1);
});

test("unverified or unregistered accounts never default to direct", async () => {
  const { createVerifiedRouteResolver } =
    await import("../../scripts/bridge/verified-route-resolver.mjs");
  let direct = 0;
  const router = createGameRouter({
    resolveRoute: createVerifiedRouteResolver({
      accounts: { resolveVerifiedPlayer: () => null },
    }),
    directFetch: () => {
      direct += 1;
    },
    bridgeProfile: () => assert.fail("unexpected bridge"),
  });
  await assert.rejects(
    router.fetchGame({ url, verifiedIdentity: { playerId: "999" } }),
    { code: "game_route_unavailable" },
  );
  assert.equal(direct, 0);
});

test("direct request cannot start without a lease or after the route changes", async () => {
  let calls = 0;
  let route = { policy: "direct", epoch: 1 };
  const dependencies = {
    resolveRoute: async () => route,
    directFetch: () => {
      calls += 1;
    },
    bridgeProfile: () => assert.fail("unexpected bridge"),
  };
  const noLease = createGameRouter(dependencies);
  await assert.rejects(noLease.fetchGame({ url, verifiedIdentity: identity }), {
    code: "game_route_unavailable",
  });
  const changed = createGameRouter({
    ...dependencies,
    withDirectLease: async (_identity, _epoch, run) => {
      route = { policy: "bridge_required", owner: "101", epoch: 2 };
      return run(() => {});
    },
  });
  await assert.rejects(changed.fetchGame({ url, verifiedIdentity: identity }), {
    code: "game_route_changed",
  });
  assert.equal(calls, 0);
});

test("an old bridge credential is denied and cannot fall back to direct", async () => {
  const { createCredentialRouteResolver } =
    await import("../../scripts/bridge/verified-route-resolver.mjs");
  let calls = 0;
  const router = createGameRouter({
    resolveRoute: createCredentialRouteResolver({
      accounts: {
        resolveCredential: () => ({
          policy: "bridge_required",
          owner: "101",
          epoch: 2,
          credentialCurrent: false,
        }),
      },
    }),
    directFetch: () => {
      calls += 1;
    },
    bridgeProfile: () => {
      calls += 1;
    },
  });
  await assert.rejects(
    router.fetchGame({
      url,
      verifiedIdentity: { authorization: "Bearer old" },
    }),
    { code: "game_credentials_stale" },
  );
  assert.equal(calls, 0);
});
