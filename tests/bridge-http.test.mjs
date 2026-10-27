import assert from "node:assert/strict";
import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  sign as signEd25519,
} from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Readable } from "node:stream";
import { join } from "node:path";
import test from "node:test";
import {
  createBridgeHttp,
  createRestoredDirectSelectionGuard,
  nodeBridgeHandler,
  ownerProofKeyFromEnvironment,
  sessionCredentialKeyFromEnvironment,
} from "../scripts/bridge/bridge-http.mjs";
import { createDeviceRegistry } from "../scripts/bridge/device-registry.mjs";
import { encodeDeviceChallenge } from "../scripts/bridge/protocol-v1/challenge.mjs";
import { verifyDeviceSessionCredential } from "../scripts/bridge/protocol-v1/session-credential.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

const botToken = "123456:bridge-test-token";
const ownerProofKey = randomBytes(32);
const uuid = (tail) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;

function signedInitData(userId, nowMs) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(nowMs / 1000)),
    user: JSON.stringify({ id: Number(userId), first_name: "Test" }),
    query_id: "bridge-test",
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

async function withBridge(
  run,
  { verifyGameAccount, sessionSigningKey, routeEnabled = false } = {},
) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-http-"));
  const store = createAutomationStateStore({ directory });
  try {
    await run({
      store,
      registry: createDeviceRegistry({
        store,
        ownerProofKey,
        now: () => nowMs,
        verifyGameAccount,
        sessionSigningKey,
        resolveDeviceRoute: routeEnabled
          ? (ownerId) => {
              const binding = store.readGameAccountBinding(ownerId);
              return binding ? store.readRoutePolicy(binding.playerId) : null;
            }
          : undefined,
      }),
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

let nowMs = Date.now();

function makeStartRequest(index = 1) {
  return {
    operation: "device.pair.start",
    requestId: uuid(String(index * 10 + 1)),
    idempotencyKey: uuid(String(index * 10 + 2)),
    deviceId: uuid(String(index * 10 + 3)),
    publicKey: Buffer.alloc(32, index).toString("base64url"),
    deviceName: "Test desktop",
    platform: "linux",
  };
}

function makeApi(
  registry,
  {
    at = nowMs,
    routeSelectionEnabled = false,
    authCoordinator = null,
    bootstrapCoordinator = null,
    allowRestoredDirectSelection = null,
    confirmRestoreOwner = null,
    issueRestoreOwnerChallenge = null,
    readRestoreOwnerStatus = null,
  } = {},
) {
  return createBridgeHttp({
    registry,
    botToken,
    ownerProofKey,
    routeSelectionEnabled,
    allowRestoredDirectSelection,
    authCoordinator,
    bootstrapCoordinator,
    confirmRestoreOwner,
    issueRestoreOwnerChallenge,
    readRestoreOwnerStatus,
    now: () => at,
  });
}

test("restore status exposes only the signed owner's bounded state", async () => {
  await withBridge(async ({ store, registry }) => {
    store.activateRestoreGuard({ activatedAt: nowMs - 1000 });
    const api = makeApi(registry, {
      readRestoreOwnerStatus: (owner) => store.readRestoreOwnerStatus(owner),
    });
    const body = {
      operation: "restore.status",
      requestId: uuid("910"),
      initData: signedInitData("54321", nowMs),
    };
    assert.equal((await send(api, body)).status, 403);
    const response = await send(api, body, {
      origin: "https://madhouse-wiki.ru",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      operation: "restore.status",
      requestId: body.requestId,
      status: "reauthorization_required",
    });
  });
});

test("restore exchange requires a signed owner and uses one request identity throughout", async () => {
  await withBridge(async ({ registry }) => {
    const calls = [];
    const coordinator = {
      prepareRestore: async (input, id) => {
        calls.push(["prepare", input, id]);
        return { status: "prepared" };
      },
      exchangeRestore: async (input, id) => {
        calls.push(["exchange", input, id]);
        return { status: "credential_stored", accessToken: "never-public" };
      },
      stageRestore: async (input, id) => {
        calls.push(["stage", input, id]);
      },
      authorizeRestoreReads: async (input, id) => {
        calls.push(["authorize", input, id]);
      },
      bootstrapStatus: async () => ({ status: "ready" }),
    };
    const api = makeApi(registry, { bootstrapCoordinator: coordinator });
    const body = {
      operation: "restore.exchange",
      requestId: uuid("901"),
      cargoLaunchData: "synthetic",
      initData: signedInitData("54321", nowMs),
    };
    assert.equal((await send(api, body)).status, 403);
    assert.equal(
      (
        await send(
          api,
          { ...body, initData: signedInitData("54321", nowMs - 360000) },
          { origin: "https://madhouse-wiki.ru" },
        )
      ).status,
      401,
    );
    assert.equal(calls.length, 0);
    const result = await send(api, body, {
      origin: "https://madhouse-wiki.ru",
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      operation: "restore.exchange",
      requestId: body.requestId,
      status: "review_required",
    });
    assert.deepEqual(
      calls.map(([step, , id]) => [step, id]),
      [
        ["prepare", body.requestId],
        ["exchange", body.requestId],
        ["stage", body.requestId],
        ["authorize", body.requestId],
      ],
    );
    assert.ok(calls.every(([, input]) => input.ownerId === "54321"));
  });
});

test("restore confirmation requires a fresh signed owner request and explicit direct route", async () => {
  await withBridge(async ({ store, registry }) => {
    store.activateRestoreGuard({ activatedAt: nowMs - 1000 });
    const api = makeApi(registry, {
      confirmRestoreOwner: (input) => store.recordRestoreOwnerConsent(input),
      issueRestoreOwnerChallenge: (input) =>
        store.issueRestoreOwnerChallenge(input),
    });
    const challengeResponse = await send(
      api,
      {
        operation: "restore.challenge",
        requestId: uuid("899"),
        initData: signedInitData("54321", nowMs),
      },
      { origin: "https://madhouse-wiki.ru" },
    );
    assert.equal(challengeResponse.status, 200);
    const { challenge } = await challengeResponse.json();
    const request = {
      operation: "restore.confirm",
      requestId: uuid("900"),
      routePolicy: "direct",
      challenge,
      initData: signedInitData("54321", nowMs),
    };
    assert.equal((await send(api, request)).status, 403);
    assert.equal(
      (
        await send(
          api,
          { ...request, routePolicy: "bridge_required" },
          { origin: "https://madhouse-wiki.ru" },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await send(
          api,
          { ...request, initData: signedInitData("54321", nowMs - 360_000) },
          { origin: "https://madhouse-wiki.ru" },
        )
      ).status,
      401,
    );
    assert.equal(store.readRestoreOwnerConsent("54321"), null);
    assert.equal(
      (
        await send(
          api,
          { ...request, initData: signedInitData("54321", nowMs - 2000) },
          { origin: "https://madhouse-wiki.ru" },
        )
      ).status,
      409,
    );
    assert.equal(store.readRestoreOwnerConsent("54321"), null);
    const result = await send(api, request, {
      origin: "https://madhouse-wiki.ru",
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), {
      operation: "restore.confirm",
      requestId: request.requestId,
      status: "confirmed",
    });
    assert.equal(
      store.readRestoreOwnerConsent("54321").requestId,
      request.requestId,
    );
    assert.equal(store.readRestoreOwnerConsent("54322"), null);
    assert.equal(store.isRestoreRequired("101"), true);
    assert.equal(
      (await send(api, request, { origin: "https://madhouse-wiki.ru" })).status,
      409,
    );
  });
});

async function send(
  api,
  body,
  { origin, authorization, clientIp = "198.51.100.10" } = {},
) {
  const headers = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  if (authorization) headers.authorization = authorization;
  return api(
    new Request("https://madhouse-wiki.ru/api/bridge", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
    { clientIp },
  );
}

test("bridge HTTP binds owner operations to fresh Telegram identity and bounded schemas", async () => {
  nowMs = Date.now();
  await withBridge(
    async ({ registry, store }) => {
      const api = makeApi(registry);
      const startRequest = makeStartRequest();
      const started = await send(api, startRequest);
      assert.equal(started.status, 200);
      assert.match(started.headers.get("cache-control"), /no-store/u);
      const pairing = await started.json();
      assert.equal(pairing.operation, "device.pair.start");
      assert.equal(typeof pairing.retrievalSecret, "string");

      const approve = {
        operation: "device.pair.approve",
        requestId: uuid("51"),
        pairingId: pairing.pairingId,
        matchingCode: pairing.displayCode,
        initData: signedInitData("54321", nowMs),
      };
      assert.equal(
        (
          await send(api, approve, {
            origin: "https://attacker.invalid",
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await send(
            api,
            { ...approve, initData: "not-signed" },
            {
              origin: "https://madhouse-wiki.ru",
            },
          )
        ).status,
        401,
      );
      assert.equal(
        (
          await send(
            api,
            {
              ...approve,
              initData: signedInitData("54321", nowMs - 6 * 60_000),
            },
            { origin: "https://madhouse-wiki.ru" },
          )
        ).status,
        401,
      );

      const approved = await send(api, approve, {
        origin: "https://madhouse-wiki.ru",
      });
      assert.equal(approved.status, 200);
      const approval = await approved.json();
      assert.equal(approval.status, "approved");
      assert.equal(approval.deviceId, startRequest.deviceId);
      assert.equal(Object.hasOwn(approval, "ownerId"), false);

      const unregisteredChallenge = await send(api, {
        operation: "device.session.challenge",
        requestId: uuid("57"),
        deviceId: uuid("58"),
      });
      assert.equal(unregisteredChallenge.status, 404);
      assert.deepEqual(await unregisteredChallenge.json(), {
        error: "device_not_found",
      });

      store.bindVerifiedGameAccount("54321", 41, nowMs);
      const routeApi = makeApi(registry, { routeSelectionEnabled: true });
      const selectedRoute = await send(
        routeApi,
        {
          operation: "route.select",
          requestId: uuid("55"),
          policy: "bridge_required",
          activeDeviceId: approval.deviceId,
          expectedRouteEpoch: 0,
          initData: signedInitData("54321", nowMs),
        },
        { origin: "https://madhouse-wiki.ru" },
      );
      assert.equal(selectedRoute.status, 200);
      assert.deepEqual(await selectedRoute.json(), {
        requestId: uuid("55"),
        operation: "route.select",
        status: "selected",
        routeEpoch: 1,
        policy: "bridge_required",
      });

      const list = await send(
        api,
        {
          operation: "device.list",
          requestId: uuid("52"),
          initData: signedInitData("54321", nowMs),
        },
        { origin: "https://madhouse-wiki.ru" },
      );
      assert.equal(list.status, 200);
      const devices = await list.json();
      assert.equal(devices.devices.length, 1);
      assert.equal(devices.devices[0].deviceId, approval.deviceId);
      assert.equal(Object.hasOwn(devices.devices[0], "publicKey"), false);
      assert.deepEqual(devices.routePolicy, {
        policy: "bridge_required",
        activeDeviceId: approval.deviceId,
        routeEpoch: 1,
      });

      const foreignRevoke = await send(
        api,
        {
          operation: "device.revoke",
          requestId: uuid("53"),
          deviceId: approval.deviceId,
          expectedGeneration: 1,
          initData: signedInitData("54322", nowMs),
        },
        { origin: "https://madhouse-wiki.ru" },
      );
      assert.equal(foreignRevoke.status, 404);

      const revoked = await send(
        api,
        {
          operation: "device.revoke",
          requestId: uuid("54"),
          deviceId: approval.deviceId,
          expectedGeneration: 1,
          initData: signedInitData("54321", nowMs),
        },
        { origin: "https://madhouse-wiki.ru" },
      );
      assert.equal(revoked.status, 200);
      assert.equal((await revoked.json()).status, "revoked");

      const staleDeviceChallenge = await send(api, {
        operation: "device.session.challenge",
        requestId: uuid("56"),
        deviceId: approval.deviceId,
      });
      assert.equal(staleDeviceChallenge.status, 410);
      assert.deepEqual(await staleDeviceChallenge.json(), {
        error: "device_revoked",
      });
    },
    { sessionSigningKey: new Uint8Array(32).fill(9) },
  );
});

test("game auth owner operations require fresh Wiki identity and return only safe operation state", async () => {
  nowMs = Date.now();
  await withBridge(async ({ registry }) => {
    const calls = [];
    const authCoordinator = {
      async start(input, requestId) {
        calls.push({ method: "start", input, requestId });
        return {
          requestId,
          operation: "game_auth.start",
          operationId: uuid("501"),
          status: "created",
        };
      },
      status(input, requestId) {
        calls.push({ method: "status", input, requestId });
        return {
          requestId,
          operation: "game_auth.status",
          operationId: input.operationId,
          status: "auth_outcome_unknown",
          reason: "unknown_outcome",
        };
      },
      async cancel(input, requestId) {
        calls.push({ method: "cancel", input, requestId });
        return {
          requestId,
          operation: "game_auth.cancel",
          operationId: input.operationId,
          status: "cancelled",
        };
      },
      async logout(input, requestId) {
        calls.push({ method: "logout", input, requestId });
        return {
          requestId,
          operation: "game_auth.logout",
          operationId: uuid("505"),
          status: "logged_out",
        };
      },
    };
    const api = makeApi(registry, { authCoordinator });
    const start = {
      operation: "game_auth.start",
      requestId: uuid("502"),
      consentGeneration: 4,
      routeEpoch: 7,
      initData: signedInitData("54321", nowMs),
    };
    assert.equal(
      (
        await send(api, start, {
          origin: "https://attacker.invalid",
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await send(
          api,
          { ...start, initData: "not-signed" },
          {
            origin: "https://madhouse-wiki.ru",
          },
        )
      ).status,
      401,
    );
    const started = await send(api, start, {
      origin: "https://madhouse-wiki.ru",
    });
    assert.equal(started.status, 200);
    assert.deepEqual(await started.json(), {
      requestId: start.requestId,
      operation: "game_auth.start",
      operationId: uuid("501"),
      status: "created",
    });
    assert.deepEqual(calls[0], {
      method: "start",
      input: { ownerId: "54321", consentGeneration: 4, routeEpoch: 7 },
      requestId: start.requestId,
    });

    const statusBody = {
      operation: "game_auth.status",
      requestId: uuid("503"),
      operationId: uuid("501"),
      initData: signedInitData("54321", nowMs),
    };
    const status = await send(api, statusBody, {
      origin: "https://madhouse-wiki.ru",
    });
    assert.deepEqual(await status.json(), {
      requestId: statusBody.requestId,
      operation: "game_auth.status",
      operationId: uuid("501"),
      status: "auth_outcome_unknown",
      reason: "unknown_outcome",
    });

    const cancelBody = {
      operation: "game_auth.cancel",
      requestId: uuid("504"),
      operationId: uuid("501"),
      initData: signedInitData("54321", nowMs),
    };
    const cancelled = await send(api, cancelBody, {
      origin: "https://madhouse-wiki.ru",
    });
    assert.deepEqual(await cancelled.json(), {
      requestId: cancelBody.requestId,
      operation: "game_auth.cancel",
      operationId: uuid("501"),
      status: "cancelled",
    });
    const logoutBody = {
      operation: "game_auth.logout",
      requestId: uuid("506"),
      initData: signedInitData("54321", nowMs),
    };
    const loggedOut = await send(api, logoutBody, {
      origin: "https://madhouse-wiki.ru",
    });
    assert.deepEqual(await loggedOut.json(), {
      requestId: logoutBody.requestId,
      operation: "game_auth.logout",
      operationId: uuid("505"),
      status: "logged_out",
    });
    assert.equal(calls.length, 4);
    assert.equal(calls[1].input.ownerId, "54321");
    assert.equal(calls[2].input.ownerId, "54321");
    assert.deepEqual(calls[3], {
      method: "logout",
      input: { ownerId: "54321" },
      requestId: logoutBody.requestId,
    });
  });
});

test("route selection is unavailable until the route-readiness gate opens", async () => {
  nowMs = Date.now();
  await withBridge(async ({ registry }) => {
    const api = makeApi(registry);
    const response = await send(
      api,
      {
        operation: "route.select",
        requestId: uuid("95"),
        policy: "bridge_required",
        activeDeviceId: uuid("96"),
        expectedRouteEpoch: 0,
        initData: signedInitData("54321", nowMs),
      },
      { origin: "https://madhouse-wiki.ru" },
    );
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "route_selection_unavailable",
    });
  });
});

test("disabled route gate permits only a freshly reauthorized restored owner's initial direct choice", async () => {
  nowMs = Date.now();
  await withBridge(
    async ({ registry, store }) => {
      const api = makeApi(registry, {
        allowRestoredDirectSelection: createRestoredDirectSelectionGuard(store),
      });
      const request = (
        userId,
        policy = "direct",
        initData = signedInitData(userId, nowMs),
      ) =>
        send(
          api,
          {
            operation: "route.select",
            requestId: uuid("900"),
            policy,
            activeDeviceId: policy === "direct" ? null : uuid("901"),
            expectedRouteEpoch: 0,
            initData,
          },
          { origin: "https://madhouse-wiki.ru" },
        );
      store.activateRestoreGuard({ activatedAt: nowMs });
      store.bindVerifiedGameAccount("54321", "101", nowMs);
      assert.equal((await request("54321")).status, 409);
      assert.equal((await request("54321", "direct", "invalid")).status, 401);
      store.confirmRestoredAccount({
        ownerId: "54321",
        playerId: "101",
        verifiedAt: nowMs,
      });
      assert.equal((await request("54322")).status, 409);
      assert.equal((await request("54321", "bridge_required")).status, 409);
      const selected = await request("54321");
      assert.equal(selected.status, 200);
      assert.equal((await selected.json()).routeEpoch, 1);
      assert.equal(store.hasExplicitRoutePolicy("101"), true);
      assert.equal((await request("54321")).status, 409);
    },
    { routeEnabled: true },
  );
});

test("game account bind uses a fresh game identity and never accepts a body token", async () => {
  nowMs = Date.now();
  await withBridge(
    async ({ registry, store }) => {
      const api = makeApi(registry);
      const body = {
        operation: "game_account.bind",
        requestId: uuid("97"),
        initData: signedInitData("54321", nowMs),
      };
      const missingSession = await send(api, body, {
        origin: "https://madhouse-wiki.ru",
      });
      assert.equal(missingSession.status, 401);
      assert.deepEqual(await missingSession.json(), {
        error: "invalid_game_session",
      });

      const invalidBodyToken = await send(
        api,
        { ...body, authorization: "Bearer game.token.value" },
        {
          origin: "https://madhouse-wiki.ru",
          authorization: "Bearer game.token.value",
        },
      );
      assert.equal(invalidBodyToken.status, 400);

      const response = await send(api, body, {
        origin: "https://madhouse-wiki.ru",
        authorization: "Bearer verified.game.token",
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        requestId: uuid("97"),
        operation: "game_account.bind",
        status: "bound",
      });
      assert.deepEqual(store.readGameAccountBinding("54321"), {
        schemaVersion: 1,
        ownerId: "54321",
        playerId: "41",
        verifiedAt: nowMs,
      });
    },
    {
      verifyGameAccount: async (authorization) => {
        assert.equal(authorization, "Bearer verified.game.token");
        return { telegramId: "54321", playerId: 41 };
      },
    },
  );
});

test("device session HTTP operations issue credentials only after device proof", async () => {
  nowMs = Date.now();
  const sessionSigningKey = randomBytes(32);
  await withBridge(
    async ({ registry, store }) => {
      const api = makeApi(registry);
      const keyPair = generateKeyPairSync("ed25519");
      const deviceId = uuid("351");
      const publicKey = keyPair.publicKey
        .export({ type: "spki", format: "der" })
        .subarray(-32)
        .toString("base64url");
      store.bindVerifiedGameAccount("54321", 41, nowMs);
      store.selectRoutePolicy("41", {
        policy: "bridge_required",
        activeDeviceId: deviceId,
        expectedRouteEpoch: 0,
        updatedAt: nowMs,
      });

      const start = {
        ...makeStartRequest(36),
        deviceId,
        publicKey,
      };
      const started = await send(api, start);
      assert.equal(started.status, 200);
      const pairing = await started.json();
      const approved = await send(
        api,
        {
          operation: "device.pair.approve",
          requestId: uuid("352"),
          pairingId: pairing.pairingId,
          matchingCode: pairing.displayCode,
          initData: signedInitData("54321", nowMs),
        },
        { origin: "https://madhouse-wiki.ru" },
      );
      assert.equal(approved.status, 200);

      const challengeResponse = await send(api, {
        operation: "device.session.challenge",
        requestId: uuid("353"),
        deviceId,
      });
      assert.equal(challengeResponse.status, 200);
      const challenge = await challengeResponse.json();
      const signature = signEd25519(
        null,
        encodeDeviceChallenge({
          protocolMajor: challenge.protocolMajor,
          protocolMinor: challenge.protocolMinor,
          purpose: challenge.purpose,
          deviceId: challenge.deviceId,
          connectionId: challenge.connectionId,
          nonce: Buffer.from(challenge.nonce, "base64url"),
          expiresAtMs: challenge.expiresAtMs,
          deviceGeneration: challenge.deviceGeneration,
          routeEpoch: challenge.routeEpoch,
        }),
        keyPair.privateKey,
      ).toString("base64url");
      const proved = await send(api, {
        operation: "device.session.prove",
        requestId: uuid("354"),
        deviceId,
        challengeId: challenge.challengeId,
        signature,
      });
      assert.equal(proved.status, 200);
      const session = await proved.json();
      const claims = await verifyDeviceSessionCredential(
        session.sessionCredential,
        sessionSigningKey,
        { nowMs: nowMs + 1 },
      );
      assert.equal(claims.deviceId, deviceId);
      assert.equal(claims.connectionId, challenge.connectionId);
      assert.equal(claims.routeEpoch, 1);
      assert.equal(claims.expiresAtMs, session.expiresAtMs);
      assert.equal(Object.hasOwn(session, "authorization"), false);
    },
    { sessionSigningKey, routeEnabled: true },
  );
});

test("device session challenge fails closed without a stable signing key", async () => {
  nowMs = Date.now();
  await withBridge(async ({ registry }) => {
    const api = makeApi(registry);
    const response = await send(api, {
      operation: "device.session.challenge",
      requestId: uuid("355"),
      deviceId: uuid("356"),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "device_session_unavailable",
    });
  });
});

test("node bridge adapter forwards only the authorization header needed for binding", async () => {
  const requestBody = JSON.stringify({
    operation: "game_account.bind",
    requestId: uuid("98"),
    initData: "signed-init-data",
  });
  let forwarded;
  const handler = nodeBridgeHandler(async (request) => {
    forwarded = request;
    return Response.json({ ok: true });
  });
  const request = Object.assign(Readable.from([Buffer.from(requestBody)]), {
    method: "POST",
    url: "/api/bridge",
    headers: {
      host: "madhouse-wiki.ru",
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(requestBody)),
      origin: "https://madhouse-wiki.ru",
      authorization: "Bearer secret.test.token",
      cookie: "ignored=1",
    },
    socket: { remoteAddress: "198.51.100.10" },
  });
  let status;
  let body;
  await handler(request, {
    writeHead(value) {
      status = value;
    },
    end(value) {
      body = Buffer.from(value).toString("utf8");
    },
  });
  assert.equal(status, 200);
  assert.deepEqual(await forwarded.json(), {
    operation: "game_account.bind",
    requestId: uuid("98"),
    initData: "signed-init-data",
  });
  assert.equal(
    forwarded.headers.get("authorization"),
    "Bearer secret.test.token",
  );
  assert.equal(forwarded.headers.get("cookie"), null);
  assert.equal(body, JSON.stringify({ ok: true }));
});

test("pairing retrieval secrets stay in POST bodies and create requests are rate limited", async () => {
  nowMs = Date.now();
  await withBridge(async ({ registry }) => {
    const api = makeApi(registry);
    for (let index = 1; index <= 6; index += 1) {
      const response = await send(api, makeStartRequest(index));
      assert.equal(response.status, 200);
    }
    const limited = await send(api, makeStartRequest(7));
    assert.equal(limited.status, 429);
    assert.deepEqual(await limited.json(), { error: "rate_limited" });

    const pairingResponse = await send(
      createBridgeHttp({
        registry,
        botToken,
        ownerProofKey,
        now: () => nowMs + 11 * 60_000,
      }),
      makeStartRequest(8),
    );
    const pairing = await pairingResponse.json();
    const statusResponse = await send(
      makeApi(registry, { at: nowMs + 11 * 60_000 }),
      {
        operation: "device.pair.status",
        requestId: uuid("81"),
        pairingId: pairing.pairingId,
        retrievalSecret: pairing.retrievalSecret,
      },
    );
    assert.equal(statusResponse.status, 200);
    assert.equal((await statusResponse.json()).status, "pending");
  });
});

test("owner endpoints require Wiki origin and unknown fields are rejected", async () => {
  nowMs = Date.now();
  await withBridge(async ({ registry }) => {
    const api = makeApi(registry);
    const ownerRequest = {
      operation: "device.list",
      requestId: uuid("91"),
      initData: signedInitData("54321", nowMs),
    };
    assert.equal((await send(api, ownerRequest)).status, 403);
    assert.equal(
      (
        await send(
          api,
          { ...ownerRequest, deviceId: uuid("92") },
          { origin: "https://madhouse-wiki.ru" },
        )
      ).status,
      400,
    );
  });
});

test("owner proof keys use canonical 32-byte base64url and fail closed when absent", async () => {
  const encoded = ownerProofKey.toString("base64url");
  assert.deepEqual(ownerProofKeyFromEnvironment(encoded), ownerProofKey);
  assert.deepEqual(sessionCredentialKeyFromEnvironment(encoded), ownerProofKey);
  assert.equal(ownerProofKeyFromEnvironment(`${encoded}=`), null);
  assert.equal(sessionCredentialKeyFromEnvironment(`${encoded}=`), null);
  assert.equal(ownerProofKeyFromEnvironment("short"), null);

  nowMs = Date.now();
  await withBridge(async ({ registry }) => {
    const api = createBridgeHttp({ registry, botToken, now: () => nowMs });
    const response = await send(
      api,
      {
        operation: "device.list",
        requestId: uuid("101"),
        initData: signedInitData("54321", nowMs),
      },
      { origin: "https://madhouse-wiki.ru" },
    );
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "bridge_owner_auth_unavailable",
    });
  });
});
