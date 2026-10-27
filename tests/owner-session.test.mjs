import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { createOwnerGameSessionResolver } from "../scripts/account/owner-session.mjs";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";

const botToken = "123456:owner-session-test-token";
const now = Date.parse("2026-10-27T12:00:00.000Z");
const playerId = "319";
const ownerId = "42";
const accessToken = "header.payload.signature";
const authOperationId = "00000000-0000-4000-8000-000000000123";

function signedInitData(userId = Number(ownerId), issuedAt = now) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(issuedAt / 1000)),
    user: JSON.stringify({ id: userId }),
    query_id: "AAE-owner-test",
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

function createResolver({
  binding = { ownerId, playerId },
  recovery = null,
  bootstrap = {
    state: "ready",
    ownerId,
    playerId,
    operationId: authOperationId,
    authGeneration: 1,
    consentGeneration: 1,
    routeEpoch: 0,
    credentialVersion: 1,
  },
  route = { policy: "direct", routeEpoch: 0, activeDeviceId: null },
  credential = {
    ownerId,
    playerId,
    accessToken,
    authOperationId,
    authGeneration: 1,
    consentGeneration: 1,
    credentialVersion: 1,
    routeEpoch: 0,
    expiresAt: now + 60_000,
    revoked: false,
  },
} = {}) {
  return createOwnerGameSessionResolver({
    store: {
      readGameAccountBinding: () => binding,
      readGameAuthRecovery: () => recovery,
      readGameAuthBootstrap: () => bootstrap,
      readRoutePolicy: () => route,
    },
    credentialStore: { read: async () => ({ record: credential }) },
    botToken,
    now: () => now,
  });
}

test("owner game session derives authorization from signed Telegram identity and private credential", async () => {
  const resolve = createResolver();
  const result = await resolve(signedInitData());

  assert.deepEqual(result, {
    ownerId,
    playerId,
    authorization: `Bearer ${accessToken}`,
    credentialVersion: 1,
    routeEpoch: 0,
    routePolicy: "direct",
  });
  assert.equal(Object.hasOwn(result, "accessToken"), false);
});

test("a newer direct bootstrap supersedes only the completed logout generation", async () => {
  const bootstrap = {
    state: "ready",
    ownerId,
    playerId,
    operationId: "00000000-0000-4000-8000-000000000124",
    authGeneration: 3,
    consentGeneration: 3,
    routeEpoch: 0,
    credentialVersion: 3,
  };
  const recovery = {
    state: "logged_out",
    ownerId,
    playerId,
    operationId: "00000000-0000-4000-8000-000000000125",
    authGeneration: 2,
    consentGeneration: 2,
    routeEpoch: 1,
    expectedCredentialVersion: 1,
    credentialVersion: 2,
  };
  const credential = {
    ownerId,
    playerId,
    accessToken,
    authOperationId: bootstrap.operationId,
    authGeneration: bootstrap.authGeneration,
    consentGeneration: bootstrap.consentGeneration,
    credentialVersion: bootstrap.credentialVersion,
    routeEpoch: 0,
    expiresAt: now + 60_000,
    revoked: false,
  };
  const resolve = createResolver({ bootstrap, recovery, credential });
  const result = await resolve(signedInitData());
  assert.equal(result.authorization, `Bearer ${accessToken}`);
  assert.equal(result.credentialVersion, 3);

  await assert.rejects(
    createResolver({
      bootstrap: { ...bootstrap, authGeneration: 2, consentGeneration: 2 },
      recovery,
      credential: {
        ...credential,
        authGeneration: 2,
        consentGeneration: 2,
        credentialVersion: 1,
      },
    })(signedInitData()),
    { code: "game_session_required", status: 401 },
  );
});

test("owner game session rejects invalid, stale, mismatched and transitional identities", async () => {
  const valid = signedInitData();
  const invalid = valid.replace(/hash=[a-f0-9]{64}/u, `hash=${"0".repeat(64)}`);
  await assert.rejects(createResolver()(invalid), {
    code: "owner_session_required",
    status: 401,
  });
  await assert.rejects(
    createResolver()(
      signedInitData(Number(ownerId), now - 25 * 60 * 60 * 1000),
    ),
    { code: "owner_session_required", status: 401 },
  );
  await assert.rejects(createResolver()(signedInitData(43)), {
    code: "game_session_required",
    status: 401,
  });
  await assert.rejects(
    createResolver({
      bootstrap: { state: "verification_pending", ownerId, playerId },
    })(valid),
    { code: "game_session_required", status: 401 },
  );
  await assert.rejects(
    createResolver({
      route: { policy: "direct", routeEpoch: 2, activeDeviceId: null },
    })(valid),
    { code: "game_session_required", status: 401 },
  );
  await assert.rejects(
    createResolver({
      credential: {
        ownerId,
        playerId,
        accessToken,
        credentialVersion: 1,
        routeEpoch: 0,
        expiresAt: now + 60_000,
        revoked: true,
      },
    })(valid),
    { code: "game_session_required", status: 401 },
  );
});

test("independently restored authorization generations fail closed in either direction", async () => {
  const base = {
    ownerId,
    playerId,
    operationId: authOperationId,
    authGeneration: 2,
    consentGeneration: 2,
    credentialVersion: 2,
    routeEpoch: 2,
  };
  const credential = {
    ownerId,
    playerId,
    accessToken,
    authOperationId,
    authGeneration: 2,
    consentGeneration: 2,
    credentialVersion: 2,
    routeEpoch: 2,
    expiresAt: now + 60_000,
    revoked: false,
  };
  const route = { policy: "direct", routeEpoch: 2, activeDeviceId: null };
  const valid = signedInitData();
  for (const field of [
    "authGeneration",
    "consentGeneration",
    "credentialVersion",
  ]) {
    for (const olderSide of ["database", "credential"]) {
      const bootstrap = { ...base, state: "ready" };
      const saved = { ...credential };
      if (olderSide === "database") bootstrap[field] = 1;
      else saved[field] = 1;
      await assert.rejects(
        createResolver({ bootstrap, credential: saved, route })(valid),
        { code: "game_session_required", status: 401 },
        `${field}: older ${olderSide}`,
      );
    }
  }
  for (const olderSide of ["database", "credential"]) {
    const recovery = { ...base, state: "ready" };
    const saved = { ...credential };
    if (olderSide === "database") recovery.routeEpoch = 1;
    else saved.routeEpoch = 1;
    await assert.rejects(
      createResolver({ bootstrap: null, recovery, credential: saved, route })(
        valid,
      ),
      { code: "game_session_required", status: 401 },
      `route epoch: older ${olderSide}`,
    );
  }
  await assert.rejects(
    createResolver({
      bootstrap: { ...base, state: "ready", operationId: "old-operation" },
      credential,
      route,
    })(valid),
    { code: "game_session_required", status: 401 },
  );
});

test("snapshot adapter consumes owner proof and injects private Bearer only upstream", async () => {
  const initData = signedInitData();
  let upstreamHeaders;
  const store = {
    readSnapshots: () => [],
    list: () => [],
    readRoutePolicy: () => ({
      policy: "direct",
      routeEpoch: 0,
      activeDeviceId: null,
    }),
    readGameAccountOwner: () => ({ ownerId }),
    readGameAuthRecovery: () => null,
    readGameAuthBootstrap: () => ({
      state: "ready",
      ownerId,
      playerId,
      operationId: authOperationId,
      authGeneration: 1,
      consentGeneration: 1,
      routeEpoch: 0,
      credentialVersion: 1,
    }),
    writeSnapshot: () => {},
  };
  const snapshots = createAccountSnapshots({
    store,
    ttl: 0,
    resolveOwnerSession: async (proof) => {
      assert.equal(proof, initData);
      return {
        ownerId,
        playerId,
        authorization: `Bearer ${accessToken}`,
      };
    },
    fetcher: async (_url, init) => {
      upstreamHeaders = new Headers(init.headers);
      return Response.json({ playerId: Number(playerId), nickname: "Test" });
    },
  });

  const response = await snapshots.fetch("https://cargohustle.online/api/me", {
    headers: { "X-Madhouse-Wiki-Init-Data": initData },
  });
  assert.equal(response.status, 200);
  assert.equal(upstreamHeaders.get("authorization"), `Bearer ${accessToken}`);
  assert.equal(upstreamHeaders.has("x-madhouse-wiki-init-data"), false);
  assert.deepEqual(await response.json(), {
    playerId: Number(playerId),
    nickname: "Test",
  });

  const conflict = await snapshots.fetch("https://cargohustle.online/api/me", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "X-Madhouse-Wiki-Init-Data": initData,
    },
  });
  assert.equal(conflict.status, 401);
});
