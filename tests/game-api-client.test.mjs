import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyGameOperation,
  createGameApiClient,
  legacyDirectRouteResolver,
} from "../scripts/bridge/game-api-client.mjs";
import { createProductionApi } from "../scripts/deploy/production-api.mjs";

const deviceId = "00000000-0000-4000-8000-000000000001";
const operation = (method, path) => ({
  method,
  path,
  operationClass: classifyGameOperation({ method, path }),
});

test("a restore gate closing during asynchronous admission prevents bridge dispatch", async () => {
  let permitted = true;
  let release;
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let dispatched = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      assert.fail("direct_transport_used");
    },
    bridgeTransport: async () => {
      dispatched++;
      return Response.json({});
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      activeDeviceId: deviceId,
      routeEpoch: 1,
      playerId: "101",
    }),
    allowOperation: () => permitted,
    admitMutation: async () => {
      markEntered();
      await pending;
      return { attemptId: "fixture" };
    },
  });
  const result = client.request({
    operation: operation("POST", "/api/bosses/battles/{battleId}/attack"),
    path: "/api/bosses/battles/1/attack",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000101",
    }),
  });
  await entered;
  permitted = false;
  release();
  await assert.rejects(result, { code: "game_restore_confirmation_required" });
  assert.equal(dispatched, 0);
});

test("a route changed during admission cannot dispatch on the stale device", async () => {
  let routeEpoch = 1;
  let release;
  let markEntered;
  const entered = new Promise((resolve) => {
    markEntered = resolve;
  });
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let dispatched = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      assert.fail("direct_transport_used");
    },
    bridgeTransport: async () => {
      dispatched++;
      return Response.json({});
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      activeDeviceId: deviceId,
      routeEpoch,
      playerId: "101",
    }),
    admitMutation: async () => {
      markEntered();
      await pending;
      return { attemptId: "fixture" };
    },
  });
  const result = client.request({
    operation: operation("POST", "/api/bosses/battles/{battleId}/attack"),
    path: "/api/bosses/battles/1/attack",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000101",
    }),
  });
  await entered;
  routeEpoch = 2;
  release();
  await assert.rejects(result, { code: "game_route_stale" });
  assert.equal(dispatched, 0);
});

test("route revalidation fails closed on missing, invalid, changed or unreadable state", async () => {
  const cases = [
    { next: null, code: "game_route_unresolved" },
    {
      next: { policy: "direct", routeEpoch: -1 },
      code: "game_route_unavailable",
    },
    {
      next: {
        policy: "bridge_required",
        routeEpoch: 1,
        activeDeviceId: deviceId,
      },
      code: "game_route_stale",
    },
    {
      next: new Error("fixture storage failure"),
      code: "game_route_unavailable",
    },
  ];
  for (const { next, code } of cases) {
    let reads = 0;
    let dispatched = 0;
    const client = createGameApiClient({
      directTransport: async () => {
        dispatched++;
        return Response.json({});
      },
      bridgeTransport: async () => {
        dispatched++;
        return Response.json({});
      },
      resolveRoute: async () => {
        if (++reads === 1) return { policy: "direct", routeEpoch: 0 };
        if (next instanceof Error) throw next;
        return next;
      },
    });
    await assert.rejects(
      client.request({
        operation: operation("GET", "/api/me"),
        path: "/api/me",
      }),
      { code },
    );
    assert.equal(reads, 2);
    assert.equal(dispatched, 0);
  }
});

test("abort, deadline and drain during route revalidation never dispatch later", async () => {
  for (const scenario of ["abort", "deadline", "drain"]) {
    let reads = 0;
    let dispatches = 0;
    let release;
    let markStarted;
    const started = new Promise((resolve) => {
      markStarted = resolve;
    });
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    const controller = new AbortController();
    const client = createGameApiClient({
      directTransport: async () => {
        dispatches++;
        return Response.json({});
      },
      resolveRoute: async () => {
        if (++reads === 2) {
          markStarted();
          await blocked;
        }
        return { policy: "direct", routeEpoch: 0 };
      },
      maxRequestDeadlineMs: scenario === "deadline" ? 30 : 1000,
    });
    const result = client.request({
      operation: operation("GET", "/api/me"),
      path: "/api/me",
      signal: controller.signal,
    });
    const rejected = assert.rejects(result, {
      code:
        scenario === "abort"
          ? "game_request_cancelled"
          : scenario === "deadline"
            ? "game_request_timeout"
            : "game_service_draining",
    });
    await started;
    if (scenario === "abort") controller.abort();
    if (scenario === "drain") await client.drain({ deadlineInMs: 100 });
    if (scenario === "deadline")
      await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await rejected;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(dispatches, 0, scenario);
  }
});

test("direct mode uses only the fixed Cargo origin and registered route", async () => {
  const calls = [];
  const client = createGameApiClient({
    directTransport: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    },
    resolveRoute: legacyDirectRouteResolver,
  });

  const response = await client.request({
    operation: operation("GET", "/api/floors/{code}/info"),
    path: "/api/floors/A/info",
    search: "?locale=ru",
    headers: { Authorization: "Bearer fixture" },
  });
  assert.equal(response.status, 200);
  assert.equal(
    calls[0].url,
    "https://cargohustle.online/api/floors/A/info?locale=ru",
  );
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.cache, "no-store");
});

test("restore gate blocks non-read game operations before either transport", async () => {
  let directCalls = 0;
  let bridgeCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ ok: true });
    },
    bridgeTransport: async () => {
      bridgeCalls += 1;
      return Response.json({ ok: true });
    },
    resolveRoute: async () => ({
      policy: "direct",
      routeEpoch: 0,
      activeDeviceId: null,
    }),
    allowOperation: () => false,
  });

  await assert.rejects(
    () =>
      client.request({
        operation: operation("POST", "/api/bosses/7/battles"),
        path: "/api/bosses/7/battles",
        method: "POST",
        context: { accountId: "101" },
      }),
    (error) => error.code === "game_restore_confirmation_required",
  );
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 0);
});

test("bridge-required reads never fall back to direct transport", async () => {
  let directCalls = 0;
  let bridgeCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 3,
      activeDeviceId: deviceId,
    }),
    bridgeTransport: async ({ route, path }) => {
      bridgeCalls += 1;
      assert.equal(route.routeEpoch, 3);
      assert.equal(path, "/api/me");
      return Response.json({ bridged: true });
    },
  });
  const response = await client.request({
    operation: operation("GET", "/api/me"),
    path: "/api/me",
  });
  assert.equal((await response.json()).bridged, true);
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 1);
});

test("bridge player progress reads are limited to the verified account", async () => {
  let directCalls = 0;
  const paths = [];
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      throw new Error("direct_transport_must_not_be_used");
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      playerId: "41",
      routeEpoch: 3,
      activeDeviceId: deviceId,
    }),
    bridgeTransport: async ({ path }) => {
      paths.push(path);
      return Response.json({ playerId: 41, level: 136 });
    },
  });
  const request = (path) =>
    client.request({
      operation: operation("GET", "/api/players/{playerId}"),
      path,
      context: { accountId: "41" },
    });
  assert.equal((await request("/api/players/41")).status, 200);
  await assert.rejects(request("/api/players/42"), {
    code: "game_operation_invalid",
    status: 400,
  });
  assert.deepEqual(paths, ["/api/players/41"]);
  assert.equal(directCalls, 0);
});

test("GameApiClient bounds a bridge request when the caller omits its deadline", async () => {
  let directCalls = 0;
  let bridgeCalls = 0;
  let transportSignal;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    bridgeTransport: ({ signal }) => {
      bridgeCalls += 1;
      transportSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 9,
      activeDeviceId: deviceId,
    }),
    maxRequestDeadlineMs: 100,
  });

  await assert.rejects(
    client.request({
      operation: operation("GET", "/api/me"),
      path: "/api/me",
    }),
    { code: "game_request_timeout", status: 504 },
  );
  assert.equal(transportSignal.aborted, true);
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 1);
});

test("game auth issuance requires a pending owner-bound operation on the selected bridge route", async () => {
  const launchData = "query_id=fixture&auth_date=2000000000&hash=signature";
  const context = {
    accountId: "987654321",
    ownerId: "7654321",
    playerId: "987654321",
    authOperationId: "00000000-0000-4000-8000-000000000123",
    consentGeneration: 4,
    expectedRouteEpoch: 5,
    expectedDeviceId: deviceId,
  };
  let directCalls = 0;
  const baseOptions = {
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 5,
      activeDeviceId: deviceId,
    }),
  };
  const request = (client, overrides = {}) =>
    client.request({
      operation: operation("POST", "/api/auth/telegram"),
      path: "/api/auth/telegram",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ initData: launchData }),
      context: { ...context, ...overrides },
    });

  let bridgeRequest;
  const admitted = createGameApiClient({
    ...baseOptions,
    bridgeTransport: async (value) => {
      bridgeRequest = value;
      return Response.json({ accessToken: "candidate" });
    },
    admitAuthIssuance: async ({
      route,
      context: current,
      launchData: value,
    }) => {
      assert.equal(route.activeDeviceId, deviceId);
      assert.equal(current.authOperationId, context.authOperationId);
      assert.equal(value, launchData);
      return { operationId: current.authOperationId };
    },
  });
  assert.equal((await request(admitted)).status, 200);
  assert.equal(bridgeRequest.admission.operationId, context.authOperationId);
  assert.equal(bridgeRequest.context.routeEpoch, 5);
  assert.equal(directCalls, 0);

  const uncoordinated = createGameApiClient({
    ...baseOptions,
    bridgeTransport: async () => {
      throw new Error("must_not_dispatch");
    },
  });
  await assert.rejects(request(uncoordinated), {
    code: "game_auth_coordinator_required",
    status: 409,
  });
  await assert.rejects(request(admitted, { expectedRouteEpoch: 4 }), {
    code: "game_route_stale",
    status: 409,
  });

  const direct = createGameApiClient({
    directTransport: baseOptions.directTransport,
    resolveRoute: async () => ({
      policy: "direct",
      routeEpoch: 0,
      activeDeviceId: null,
    }),
  });
  await assert.rejects(
    request(direct, { expectedRouteEpoch: 0, expectedDeviceId: null }),
    {
      code: "game_auth_coordinator_required",
      status: 409,
    },
  );
  assert.equal(directCalls, 0);
});

test("offline bridge, mutation gate, and unresolved effect fail closed", async () => {
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
  });

  await assert.rejects(
    client.request({
      operation: operation("GET", "/api/me"),
      path: "/api/me",
    }),
    { code: "bridge_device_unavailable", status: 503 },
  );
  await assert.rejects(
    client.request({
      operation: operation("POST", "/api/bosses/battles/{battleId}/attack"),
      path: "/api/bosses/battles/direct/attack",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000001",
      }),
    }),
    { code: "bridge_mutation_not_admitted", status: 409 },
  );
  await assert.rejects(
    client.request({
      operation: operation("POST", "/api/works/open"),
      path: "/api/works/open",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    { code: "bridge_effect_policy_unknown", status: 409 },
  );
  assert.equal(directCalls, 0);
});

test("invalid route state and upstream headers stop before direct dispatch", async () => {
  let directCalls = 0;
  const directTransport = async () => {
    directCalls += 1;
    return Response.json({ direct: true });
  };
  const operationDescriptor = operation("GET", "/api/me");
  const invalidRoute = createGameApiClient({
    directTransport,
    resolveRoute: async () => {
      throw new Error("database unavailable");
    },
  });
  await assert.rejects(
    invalidRoute.request({ operation: operationDescriptor, path: "/api/me" }),
    { code: "game_route_unavailable", status: 503 },
  );

  const unsafeHeaders = createGameApiClient({
    directTransport,
    resolveRoute: legacyDirectRouteResolver,
  });
  await assert.rejects(
    unsafeHeaders.request({
      operation: operationDescriptor,
      path: "/api/me",
      headers: { Cookie: "session=secret" },
    }),
    { code: "game_headers_invalid", status: 400 },
  );
  await assert.rejects(
    unsafeHeaders.request({
      operation: operation("POST", "/api/me"),
      path: "/api/me",
      method: "POST",
      body: "x".repeat(64 * 1024 + 1),
    }),
    { code: "game_body_too_large", status: 413 },
  );
  assert.equal(directCalls, 0);
});

test("the Cargo dev key is restricted to the direct dev-userid route", async () => {
  const calls = [];
  const client = createGameApiClient({
    directTransport: async (url, init) => {
      calls.push({ url, init });
      return Response.json({ ok: true });
    },
    resolveRoute: legacyDirectRouteResolver,
  });

  await assert.rejects(
    client.request({
      operation: {
        ...operation("POST", "/api/shop/buy"),
        allowsDevKey: true,
      },
      path: "/api/shop/buy",
      method: "POST",
      headers: { "X-CargoHustle-Dev-Key": "fixture-dev-key" },
      body: "{}",
    }),
    { code: "game_operation_invalid", status: 400 },
  );
  assert.equal(calls.length, 0);

  const response = await client.request({
    operation: {
      ...operation("POST", "/api/auth/dev-userid"),
      allowsDevKey: true,
    },
    path: "/api/auth/dev-userid",
    method: "POST",
    headers: { "X-CargoHustle-Dev-Key": "fixture-dev-key" },
    body: "{}",
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(
    new Headers(calls[0].init.headers).get("x-cargohustle-dev-key"),
    "fixture-dev-key",
  );
});

test("callers cannot weaken a game's operation class", async () => {
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
    resolveRoute: legacyDirectRouteResolver,
  });

  await assert.rejects(
    client.request({
      operation: {
        ...operation("POST", "/api/shop/buy"),
        operationClass: "read",
      },
      path: "/api/shop/buy",
      method: "POST",
    }),
    { code: "game_operation_invalid", status: 400 },
  );
  await assert.rejects(
    client.request({
      operation: {
        ...operation("GET", "/api/me"),
        operationClass: "mutation",
      },
      path: "/api/me",
      method: "GET",
    }),
    { code: "game_operation_invalid", status: 400 },
  );
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 0);
});

test("identity verification is a fresh routed /api/me operation", async () => {
  let directCalls = 0;
  let bridgeCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    bridgeTransport: async ({ operation, path, search }) => {
      bridgeCalls += 1;
      assert.equal(operation.operationClass, "identity_verification");
      assert.equal(path, "/api/me");
      assert.equal(search, "");
      return Response.json({ playerId: 77 });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
  });

  const response = await client.request({
    operation: {
      ...operation("GET", "/api/me"),
      operationClass: "identity_verification",
    },
    path: "/api/me",
  });
  assert.deepEqual(await response.json(), { playerId: 77 });
  await assert.rejects(
    client.request({
      operation: {
        ...operation("GET", "/api/me"),
        operationClass: "identity_verification",
      },
      path: "/api/me",
      search: "?cache=1",
    }),
    { code: "game_operation_invalid", status: 400 },
  );
  await assert.rejects(
    client.request({
      operation: {
        ...operation("GET", "/api/clans/search"),
        operationClass: "identity_verification",
      },
      path: "/api/clans/search",
    }),
    { code: "game_operation_invalid", status: 400 },
  );
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 1);
});

test("unreviewed paths and writes are effect-unknown on bridge routes", async () => {
  assert.equal(
    classifyGameOperation({ method: "GET", path: "/api/me" }),
    "read",
  );
  assert.equal(
    classifyGameOperation({
      method: "GET",
      path: "/api/floors/{code}/info",
    }),
    "read",
  );
  assert.equal(
    classifyGameOperation({ method: "GET", path: "/api/clans/search" }),
    "effect_unknown",
  );
  assert.equal(
    classifyGameOperation({ method: "POST", path: "/api/works/open" }),
    "effect_unknown",
  );
  assert.equal(
    classifyGameOperation({ method: "POST", path: "/api/shop/buy" }),
    "effect_unknown",
  );
  assert.equal(
    classifyGameOperation({ method: "PUT", path: "/api/shop/buy" }),
    "effect_unknown",
  );
  assert.equal(
    classifyGameOperation({
      method: "POST",
      path: "/api/bosses/battles/{battleId}/attack",
    }),
    "mutation",
  );
  assert.equal(
    classifyGameOperation({
      method: "POST",
      path: "/api/bosses/battles/42/attack",
    }),
    "mutation",
  );

  let directCalls = 0;
  let bridgeCalls = 0;
  let mutationAdmissions = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    bridgeTransport: async () => {
      bridgeCalls += 1;
      return Response.json({ bridged: true });
    },
    admitMutation: async () => {
      mutationAdmissions += 1;
      return { action: "unexpected" };
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
  });

  await assert.rejects(
    client.request({
      operation: operation("GET", "/api/clans/search"),
      path: "/api/clans/search",
    }),
    { code: "bridge_effect_policy_unknown", status: 409 },
  );
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 0);
  await assert.rejects(
    client.request({
      operation: operation("POST", "/api/shop/buy"),
      path: "/api/shop/buy",
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    { code: "bridge_effect_policy_unknown", status: 409 },
  );
  assert.equal(mutationAdmissions, 0);
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 0);

  const legacyDirect = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    resolveRoute: legacyDirectRouteResolver,
  });
  const directResponse = await legacyDirect.request({
    operation: operation("GET", "/api/clans/search"),
    path: "/api/clans/search",
  });
  assert.equal((await directResponse.json()).direct, true);
  assert.equal(directCalls, 1);
  const directWriteResponse = await legacyDirect.request({
    operation: operation("POST", "/api/shop/buy"),
    path: "/api/shop/buy",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal((await directWriteResponse.json()).direct, true);
  assert.equal(directCalls, 2);
});

test("bridge read routes reject unregistered or duplicate query arguments", async () => {
  let bridgeCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      throw new Error("direct_transport_must_not_be_used");
    },
    bridgeTransport: async () => {
      bridgeCalls += 1;
      return Response.json({ ok: true });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
  });

  for (const search of ["?workId=4", "?locale=ru&locale=en"]) {
    await assert.rejects(
      client.request({
        operation: operation("GET", "/api/me"),
        path: "/api/me",
        search,
      }),
      { code: "game_operation_invalid", status: 400 },
    );
  }
  await assert.rejects(
    client.request({
      operation: operation("GET", "/api/floors/{code}/info"),
      path: "/api/floors/A/info",
      search: "?locale=fr",
    }),
    { code: "game_operation_invalid", status: 400 },
  );
  await assert.rejects(
    client.request({
      operation: operation("GET", "/api/me"),
      path: "/api/me",
      body: "{}",
    }),
    { code: "game_operation_invalid", status: 400 },
  );
  await assert.rejects(
    client.request({
      operation: {
        ...operation("GET", "/api/me"),
        operationClass: "identity_verification",
      },
      path: "/api/me",
      body: "{}",
    }),
    { code: "game_operation_invalid", status: 400 },
  );
  const valid = await client.request({
    operation: operation("GET", "/api/floors/{code}/info"),
    path: "/api/floors/A/info",
    search: "?locale=ru",
  });
  assert.equal(valid.status, 200);
  const invitations = await client.request({
    operation: operation("GET", "/api/bosses/invitations"),
    path: "/api/bosses/invitations",
    search: "?direction=incoming&status=pending",
  });
  assert.equal(invitations.status, 200);
  assert.equal(bridgeCalls, 2);
});

test("friend reconciliation bridge reads allow only bounded pagination", async () => {
  let calls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      throw new Error("unexpected direct request");
    },
    bridgeTransport: async () => {
      calls++;
      return Response.json({ items: [], nextCursor: null });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
  });
  for (const path of ["/api/friends", "/api/friends/requests/outgoing"]) {
    assert.equal(
      (
        await client.request({
          operation: operation("GET", path),
          path,
          search: "?limit=100&cursor=next",
        })
      ).status,
      200,
    );
    for (const search of [
      "?limit=100&limit=100",
      "?limit=100&extra=x",
      "?limit=500",
      `?limit=100&cursor=${"x".repeat(513)}`,
    ])
      await assert.rejects(
        client.request({ operation: operation("GET", path), path, search }),
        { code: "game_operation_invalid" },
      );
  }
  assert.equal(calls, 2);
});

test("Buddy reconciliation permits reviewed reads with restricted parameters", async () => {
  let calls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      throw new Error("unexpected direct request");
    },
    bridgeTransport: async () => {
      calls++;
      return Response.json({ items: [] });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
  });
  const booster = "/api/player-interactions/booster-requests/incoming";
  const stash = "/api/stash/help-requests/42";
  for (const [path, search] of [
    [booster, "?limit=100"],
    [stash, ""],
  ]) {
    assert.equal(classifyGameOperation({ method: "GET", path }), "read");
    assert.equal(
      (
        await client.request({
          operation: operation("GET", path),
          path,
          search,
        })
      ).status,
      200,
    );
  }
  for (const [path, search] of [
    [booster, "?limit=101"],
    [booster, "?limit=100&limit=100"],
    [stash, "?extra=1"],
  ]) {
    await assert.rejects(
      client.request({ operation: operation("GET", path), path, search }),
      { code: "game_operation_invalid" },
    );
  }
  assert.equal(
    classifyGameOperation({ method: "POST", path: stash }),
    "effect_unknown",
  );
  assert.equal(calls, 2);
});

test("route resolution must be explicit and unknown identities only bootstrap /api/me", async () => {
  const calls = [];
  assert.throws(
    () =>
      createGameApiClient({ directTransport: async () => Response.json({}) }),
    /game_route_resolver_required/u,
  );
  const unresolved = createGameApiClient({
    directTransport: async () => {
      calls.push("unexpected-direct");
      return Response.json({});
    },
    resolveRoute: async () => null,
  });
  await assert.rejects(
    unresolved.request({
      operation: operation("GET", "/api/me"),
      path: "/api/me",
    }),
    { code: "game_route_unresolved", status: 503 },
  );
  assert.deepEqual(calls, []);
  const client = createGameApiClient({
    directTransport: async (url) => {
      calls.push(url);
      return Response.json({ playerId: 4 });
    },
    resolveRoute: async () => ({
      policy: "direct",
      routeEpoch: 0,
      identityBootstrap: true,
    }),
  });
  await client.request({
    operation: operation("GET", "/api/me"),
    path: "/api/me",
    headers: { Authorization: "Bearer unbound" },
  });
  await assert.rejects(
    client.request({
      operation: operation("GET", "/api/me/bag"),
      path: "/api/me/bag",
      headers: { Authorization: "Bearer unbound" },
    }),
    { code: "game_identity_required", status: 401 },
  );
  assert.deepEqual(calls, ["https://cargohustle.online/api/me"]);
});

test("a bridge transport failure does not call the direct adapter", async () => {
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
    bridgeTransport: async () => {
      throw new Error("device offline");
    },
  });
  await assert.rejects(
    client.request({ operation: operation("GET", "/api/me"), path: "/api/me" }),
    /device offline/u,
  );
  assert.equal(directCalls, 0);
});

test("production API applies saved bridge policy before any direct Cargo call", async () => {
  let directCalls = 0;
  const api = createProductionApi(
    [{ path: "/api/me", method: "GET", requiresAuth: true }],
    async () => {
      directCalls += 1;
      return Response.json({ playerId: 10 });
    },
    {
      resolveRoute: async ({ authorization }) => {
        assert.equal(authorization, "Bearer fixture");
        return {
          policy: "bridge_required",
          routeEpoch: 5,
          activeDeviceId: deviceId,
        };
      },
    },
  );
  const response = await api(
    new Request("https://wiki.invalid/api/me", {
      headers: { Authorization: "Bearer fixture" },
    }),
  );
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: "bridge_device_unavailable",
  });
  assert.equal(directCalls, 0);
});

test("production API forwards owner proof only to the delegated Wiki session resolver", async () => {
  const proof = "signed.telegram.init.data";
  let delegatedHeaders;
  const delegated = createProductionApi(
    [{ path: "/api/me", method: "GET", requiresAuth: true }],
    async (_url, init) => {
      delegatedHeaders = new Headers(init.headers);
      return Response.json({ playerId: 10 });
    },
    { routePolicyDelegatedToFetcher: true },
  );
  const response = await delegated(
    new Request("https://wiki.invalid/api/me", {
      headers: { "X-Madhouse-Wiki-Init-Data": proof },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(delegatedHeaders.get("x-madhouse-wiki-init-data"), proof);
  assert.equal(delegatedHeaders.has("authorization"), false);

  let directCalls = 0;
  const direct = createProductionApi(
    [{ path: "/api/me", method: "GET", requiresAuth: true }],
    async () => {
      directCalls++;
      return Response.json({ unexpected: true });
    },
    { allowLegacyDirect: true },
  );
  const rejected = await direct(
    new Request("https://wiki.invalid/api/me", {
      headers: { "X-Madhouse-Wiki-Init-Data": proof },
    }),
  );
  assert.equal(rejected.status, 401);
  assert.equal(directCalls, 0);
});

test("production API construction requires a route resolver or explicit legacy mode", () => {
  assert.throws(
    () =>
      createProductionApi([{ path: "/api/me", method: "GET" }], async () =>
        Response.json({}),
      ),
    /game_route_resolver_required/u,
  );
});

test("bridge-required API mutations require a durable actor admission", async () => {
  let directCalls = 0;
  let bridgeCalls = 0;
  const api = createProductionApi(
    [
      {
        path: "/api/bosses/battles/{battleId}/attack",
        method: "POST",
        requiresAuth: true,
      },
    ],
    async () => {
      directCalls += 1;
      return Response.json({ bought: true });
    },
    {
      resolveRoute: async () => ({
        policy: "bridge_required",
        routeEpoch: 5,
        activeDeviceId: deviceId,
      }),
      bridgeTransport: async () => {
        bridgeCalls += 1;
        return Response.json({ bought: true });
      },
    },
  );
  const response = await api(
    new Request("https://wiki.invalid/api/bosses/battles/42/attack", {
      method: "POST",
      headers: {
        Authorization: "Bearer fixture",
        "Content-Type": "application/json",
        "X-Madhouse-Allow-Mutations": "true",
      },
      body: JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000001",
      }),
    }),
  );
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "bridge_mutation_not_admitted",
  });
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 0);
});

test("bridge boss attacks validate the correlated JSON body before admission", async () => {
  let directCalls = 0;
  let bridgeCalls = 0;
  let admissionCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    bridgeTransport: async ({ admission }) => {
      bridgeCalls += 1;
      assert.equal(admission.action, "boss.attack");
      return Response.json({ bridged: true });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
    admitMutation: async () => {
      admissionCalls += 1;
      return { action: "boss.attack" };
    },
  });
  const path = "/api/bosses/battles/battle-1/attack";
  const descriptor = operation("POST", "/api/bosses/battles/{battleId}/attack");
  for (const request of [
    {
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    },
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: "not-a-uuid" }),
    },
    {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000001",
        damage: 999,
      }),
    },
    {
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify({
        operationId: "00000000-0000-4000-8000-000000000001",
      }),
    },
  ]) {
    await assert.rejects(
      client.request({
        operation: descriptor,
        path,
        method: "POST",
        ...request,
      }),
      { code: "game_operation_invalid", status: 400 },
    );
  }
  assert.equal(admissionCalls, 0);
  assert.equal(bridgeCalls, 0);
  assert.equal(directCalls, 0);

  const valid = await client.request({
    operation: descriptor,
    path,
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000001",
    }),
  });
  assert.equal((await valid.json()).bridged, true);
  assert.equal(admissionCalls, 1);
  assert.equal(bridgeCalls, 1);
  assert.equal(directCalls, 0);
});

test("game API drain blocks a route resolution that has not dispatched yet", async () => {
  let resolveRoute;
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ ok: true });
    },
    resolveRoute: () =>
      new Promise((resolve) => {
        resolveRoute = resolve;
      }),
  });
  const pending = client.request({
    operation: operation("GET", "/api/me"),
    path: "/api/me",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await client.drain({ deadlineInMs: 100 }), true);
  resolveRoute({ policy: "direct", routeEpoch: 0 });
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "game_service_draining");
    return true;
  });
  assert.equal(directCalls, 0);
});

test("game API drain waits for dispatched requests and rejects later requests", async () => {
  let resolveTransport;
  let dispatchStarted;
  const started = new Promise((resolve) => {
    dispatchStarted = resolve;
  });
  const client = createGameApiClient({
    directTransport: () => {
      dispatchStarted();
      return new Promise((resolve) => {
        resolveTransport = resolve;
      });
    },
    resolveRoute: legacyDirectRouteResolver,
  });
  const pending = client.request({
    operation: operation("GET", "/api/me"),
    path: "/api/me",
  });
  await started;
  const drained = client.drain({ deadlineInMs: 1000 });
  await assert.rejects(
    client.request({ operation: operation("GET", "/api/me"), path: "/api/me" }),
    (error) => error.code === "game_service_draining",
  );
  resolveTransport(Response.json({ ok: true }));
  assert.equal((await pending).status, 200);
  assert.equal(await drained, true);
});

test("an aborted request rejects during route resolution and never dispatches", async () => {
  let resolveRoute;
  let notifyRouteResolutionStarted;
  const routeResolutionStarted = new Promise((resolve) => {
    notifyRouteResolutionStarted = resolve;
  });
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ ok: true });
    },
    resolveRoute: () => {
      notifyRouteResolutionStarted();
      return new Promise((resolve) => {
        resolveRoute = resolve;
      });
    },
  });
  const controller = new AbortController();
  const pending = client.request({
    operation: operation("GET", "/api/me"),
    path: "/api/me",
    signal: controller.signal,
  });

  await routeResolutionStarted;
  controller.abort();
  await assert.rejects(pending, {
    code: "game_request_cancelled",
    status: 499,
  });
  resolveRoute({ policy: "direct", routeEpoch: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(directCalls, 0);
});

test("an expired request deadline rejects before route resolution completes", async () => {
  let resolveRoute;
  let notifyRouteResolutionStarted;
  const routeResolutionStarted = new Promise((resolve) => {
    notifyRouteResolutionStarted = resolve;
  });
  let directCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ ok: true });
    },
    resolveRoute: () => {
      notifyRouteResolutionStarted();
      return new Promise((resolve) => {
        resolveRoute = resolve;
      });
    },
  });
  const controller = new AbortController();
  const pending = client.request({
    operation: operation("GET", "/api/me"),
    path: "/api/me",
    signal: controller.signal,
  });

  await routeResolutionStarted;
  controller.abort(new DOMException("The operation timed out", "TimeoutError"));
  await assert.rejects(pending, {
    code: "game_request_timeout",
    status: 504,
  });
  resolveRoute({ policy: "direct", routeEpoch: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(directCalls, 0);
});

test("an aborted mutation rejects during actor admission and never dispatches", async () => {
  let resolveAdmission;
  let notifyAdmissionStarted;
  const admissionStarted = new Promise((resolve) => {
    notifyAdmissionStarted = resolve;
  });
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
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
    admitMutation: () => {
      notifyAdmissionStarted();
      return new Promise((resolve) => {
        resolveAdmission = resolve;
      });
    },
  });
  const controller = new AbortController();
  const pending = client.request({
    operation: operation("POST", "/api/bosses/battles/{battleId}/attack"),
    path: "/api/bosses/battles/1/attack",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: "00000000-0000-4000-8000-000000000001",
    }),
    signal: controller.signal,
  });

  await admissionStarted;
  controller.abort();
  await assert.rejects(pending, {
    code: "game_request_cancelled",
    status: 499,
  });
  resolveAdmission({ admissionId: "fixture" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 0);
});

test("an aborted auth request rejects during owner-bound admission and never dispatches", async () => {
  const context = {
    accountId: "987654321",
    ownerId: "7654321",
    playerId: "987654321",
    authOperationId: "00000000-0000-4000-8000-000000000123",
    consentGeneration: 4,
    expectedRouteEpoch: 1,
    expectedDeviceId: deviceId,
  };
  let resolveAdmission;
  let notifyAdmissionStarted;
  const admissionStarted = new Promise((resolve) => {
    notifyAdmissionStarted = resolve;
  });
  let directCalls = 0;
  let bridgeCalls = 0;
  const client = createGameApiClient({
    directTransport: async () => {
      directCalls += 1;
      return Response.json({ direct: true });
    },
    bridgeTransport: async () => {
      bridgeCalls += 1;
      return Response.json({ accessToken: "candidate" });
    },
    resolveRoute: async () => ({
      policy: "bridge_required",
      routeEpoch: 1,
      activeDeviceId: deviceId,
    }),
    admitAuthIssuance: () => {
      notifyAdmissionStarted();
      return new Promise((resolve) => {
        resolveAdmission = resolve;
      });
    },
  });
  const controller = new AbortController();
  const pending = client.request({
    operation: operation("POST", "/api/auth/telegram"),
    path: "/api/auth/telegram",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: "signed-launch-data-fixture" }),
    signal: controller.signal,
    context,
  });

  await admissionStarted;
  controller.abort();
  await assert.rejects(pending, {
    code: "game_request_cancelled",
    status: 499,
  });
  resolveAdmission({ operationId: context.authOperationId });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(directCalls, 0);
  assert.equal(bridgeCalls, 0);
});
