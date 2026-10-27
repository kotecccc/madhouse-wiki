import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { createAuthCoordinator } from "../scripts/account/auth-coordinator.mjs";
import { createGameCredentialStore } from "../scripts/account/game-credential-store.mjs";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

const ownerId = "7654321";
const playerId = "987654321";
const deviceId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000123";
const logoutOperationId = "00000000-0000-4000-8000-000000000124";
const renewedOperationId = "00000000-0000-4000-8000-000000000125";
const requestId = "00000000-0000-4000-8000-000000000456";
const accessTokenMarker = "T40_ACCESS_TOKEN_SECRET_MARKER_20261027";
const accessToken = `e30.${Buffer.from(
  JSON.stringify({ exp: 2_000_000_000 }),
).toString("base64url")}.fixture-signature_${accessTokenMarker}`;
const profile = { telegramId: ownerId, playerId, nickname: "Fixture" };

function fakePrivateStorage() {
  let current = null;
  let version = 0;
  return {
    get value() {
      return current?.value ?? "";
    },
    async read() {
      return current ? { ...current } : null;
    },
    async write(_path, value, expectedEtag) {
      assert.equal(current?.etag ?? null, expectedEtag);
      version++;
      current = { value, etag: `credential-${version}` };
      return { etag: current.etag };
    },
  };
}

function captureConsole(t) {
  const methods = ["debug", "info", "log", "warn", "error"];
  const original = new Map(methods.map((method) => [method, console[method]]));
  const lines = [];
  const restore = () => {
    for (const [method, value] of original) console[method] = value;
  };
  for (const method of methods)
    console[method] = (...args) =>
      lines.push(
        args
          .map((value) =>
            typeof value === "string"
              ? value
              : inspect(value, { depth: 10, colors: false }),
          )
          .join(" "),
      );
  t.after(restore);
  return { lines, restore };
}

function assertSecretMarkerAbsent(directory, credentialStorage, logLines) {
  const names = readdirSync(directory);
  assert.ok(names.includes("automation.sqlite"));
  assert.ok(names.includes("automation.sqlite-wal"));
  const files = Buffer.concat(
    names.map((name) => readFileSync(join(directory, name))),
  );
  const encryptedCredential = Buffer.from(credentialStorage.value);
  const logs = Buffer.from(logLines.join("\n"));
  for (const marker of [accessToken, accessTokenMarker]) {
    const bytes = Buffer.from(marker);
    assert.equal(files.includes(bytes), false);
    assert.equal(encryptedCredential.includes(bytes), false);
    assert.equal(logs.includes(bytes), false);
  }
}

async function waitForReady(coordinator, operationIdValue = operationId) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = coordinator.status(
      { ownerId, operationId: operationIdValue },
      requestId,
    );
    if (result.status === "ready") return result;
    if (["failed", "auth_outcome_unknown"].includes(result.status))
      assert.fail(
        `auth operation stopped at ${result.status}:${result.reason}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("auth operation did not reach ready");
}

test("owner-bound auth flows through snapshots, bridge transport, private storage, and actor adoption", async (t) => {
  const consoleCapture = captureConsole(t);
  const directory = mkdtempSync(join(tmpdir(), "madhouse-auth-integration-"));
  const store = createAutomationStateStore({ directory });
  let service;
  let coordinator;
  t.after(() => {
    coordinator?.close();
    service?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.bindVerifiedGameAccount(ownerId, playerId, 1_798_000_000_000);
  store.selectRoutePolicy(playerId, {
    policy: "bridge_required",
    activeDeviceId: deviceId,
    expectedRouteEpoch: 0,
    updatedAt: 1_798_000_000_001,
  });

  const bridgeRequests = [];
  let nextOperationId = operationId;
  const snapshots = createAccountSnapshots({
    store,
    now: () => 1_798_000_000_100,
    fetcher: async () => {
      throw new Error("unexpected_direct_game_request");
    },
    bridgeTransport: async (request) => {
      bridgeRequests.push(request);
      assert.equal(request.route.activeDeviceId, deviceId);
      if (request.path === "/api/auth/telegram") {
        assert.equal(request.operation.operationClass, "auth_issuance");
        assert.deepEqual(request.admission, {
          operationId: nextOperationId,
          routeEpoch: 1,
        });
        assert.deepEqual(JSON.parse(request.body), {
          initData: "signed-fixture-launch",
        });
        assert.equal(request.headers.has("authorization"), false);
        return Response.json({ accessToken });
      }
      assert.equal(request.path, "/api/me");
      assert.equal(
        request.headers.get("authorization"),
        `Bearer ${accessToken}`,
      );
      return Response.json(profile);
    },
  });
  service = createAutomationService({
    store,
    fetcher: snapshots.liveFetch,
    snapshotFetch: snapshots.fetch,
    accountHealth: snapshots.health,
    identifyPlayer: async () => profile,
    getBoss: (id) => ({ numericId: id, name: "Fixture boss" }),
    getBusinessCatalogue: () => ({ bosses: [], businesses: [], works: [] }),
    now: () => 1_798_000_000_100,
  });
  const privateStorage = fakePrivateStorage();
  const credentials = createGameCredentialStore({
    store: privateStorage,
    encryptionKey: randomBytes(32),
  });
  coordinator = createAuthCoordinator({
    store,
    credentialStore: credentials,
    controlGateway: {
      requestGameLaunch: async () => ({
        status: "ready",
        launchData: "signed-fixture-launch",
      }),
    },
    issueGameCredential: snapshots.issueGameCredential,
    verifyGameCredential: snapshots.verifyGameCredential,
    adoptGameCredential: async (candidate) => {
      snapshots.registerVerifiedCredential(
        `Bearer ${candidate.accessToken}`,
        candidate.playerId,
      );
      return service.adoptGameCredential(candidate);
    },
    revokeGameSession: (request) => service.logoutGameSession(request),
    isDeviceActive: () => true,
    now: () => 1_798_000_000_100,
    uuid: () => nextOperationId,
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    requestId,
  );
  const ready = await waitForReady(coordinator);

  assert.equal(ready.status, "ready");
  assertSecretMarkerAbsent(directory, privateStorage, consoleCapture.lines);
  assert.deepEqual(
    bridgeRequests.map((request) => request.path),
    ["/api/auth/telegram", "/api/me"],
  );
  assert.equal(store.readGameAuthRecovery(ownerId).state, "ready");
  const actor = await service.identify(`Bearer ${accessToken}`);
  assert.equal(actor.player.playerId, Number(playerId));
  assert.equal(actor.credential, `Bearer ${accessToken}`);

  nextOperationId = logoutOperationId;
  const loggedOut = await coordinator.logout({ ownerId }, requestId);
  assert.equal(loggedOut.status, "logged_out");
  assert.equal(store.readGameAuthRecovery(ownerId).state, "logged_out");
  assert.equal(store.read(playerId).credential, null);
  assert.equal((await credentials.read(ownerId)).record.revoked, true);
  const callsAfterLogout = bridgeRequests.length;
  await assert.rejects(service.identify(`Bearer ${accessToken}`), {
    status: 401,
  });
  assert.equal(bridgeRequests.length, callsAfterLogout);

  nextOperationId = renewedOperationId;
  await coordinator.start(
    { ownerId, consentGeneration: 5, routeEpoch: 1 },
    requestId,
  );
  assert.equal(
    (await waitForReady(coordinator, renewedOperationId)).status,
    "ready",
  );
  assert.equal(store.readGameAuthRecovery(ownerId).authGeneration, 3);
  assert.equal(store.readGameAuthRecovery(ownerId).consentGeneration, 6);
  assert.equal(store.read(playerId).credential, `Bearer ${accessToken}`);
  assertSecretMarkerAbsent(directory, privateStorage, consoleCapture.lines);
  consoleCapture.restore();
});

test("device revoke during actor adoption keeps the late credential unadopted", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "madhouse-auth-revoke-adoption-"),
  );
  const store = createAutomationStateStore({ directory });
  let service;
  let coordinator;
  t.after(() => {
    coordinator?.close();
    service?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.bindVerifiedGameAccount(ownerId, playerId, 1_798_000_000_000);
  store.selectRoutePolicy(playerId, {
    policy: "bridge_required",
    activeDeviceId: deviceId,
    expectedRouteEpoch: 0,
    updatedAt: 1_798_000_000_001,
  });

  const bridgeRequests = [];
  const snapshots = createAccountSnapshots({
    store,
    now: () => 1_798_000_000_100,
    fetcher: async () => {
      throw new Error("unexpected_direct_game_request");
    },
    bridgeTransport: async (request) => {
      bridgeRequests.push(request);
      if (request.path === "/api/auth/telegram")
        return Response.json({ accessToken });
      assert.equal(request.path, "/api/me");
      return Response.json(profile);
    },
  });
  service = createAutomationService({
    store,
    fetcher: snapshots.liveFetch,
    snapshotFetch: snapshots.fetch,
    accountHealth: snapshots.health,
    identifyPlayer: async () => profile,
    getBoss: (id) => ({ numericId: id, name: "Fixture boss" }),
    getBusinessCatalogue: () => ({ bosses: [], businesses: [], works: [] }),
    now: () => 1_798_000_000_100,
  });
  const privateStorage = fakePrivateStorage();
  const credentials = createGameCredentialStore({
    store: privateStorage,
    encryptionKey: randomBytes(32),
  });
  let deviceActive = true;
  coordinator = createAuthCoordinator({
    store,
    credentialStore: credentials,
    controlGateway: {
      requestGameLaunch: async () => ({
        status: "ready",
        launchData: "signed-fixture-launch",
      }),
    },
    issueGameCredential: snapshots.issueGameCredential,
    verifyGameCredential: snapshots.verifyGameCredential,
    adoptGameCredential: async (candidate) => {
      snapshots.registerVerifiedCredential(
        `Bearer ${candidate.accessToken}`,
        candidate.playerId,
      );
      const pendingAdoption = service.adoptGameCredential(candidate);
      deviceActive = false;
      assert.equal(coordinator.invalidateDevice(deviceId), 1);
      return pendingAdoption;
    },
    revokeGameSession: (request) => service.logoutGameSession(request),
    isDeviceActive: () => deviceActive,
    now: () => 1_798_000_000_100,
    uuid: () => operationId,
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    requestId,
  );
  let latest;
  for (let attempt = 0; attempt < 100; attempt++) {
    latest = coordinator.status({ ownerId, operationId }, requestId);
    if (latest.status === "auth_outcome_unknown") break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(latest.status, "auth_outcome_unknown");
  assert.equal(latest.reason, "consent_required");
  assert.equal(
    store.readGameAuthRecovery(ownerId).state,
    "auth_outcome_unknown",
  );
  assert.equal(store.read(playerId)?.credential ?? null, null);
  assert.equal(
    bridgeRequests.filter(({ path }) => path === "/api/auth/telegram").length,
    1,
  );
});

test("route switch during actor adoption keeps the late credential unadopted", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "madhouse-auth-route-adoption-"),
  );
  const store = createAutomationStateStore({ directory });
  let service;
  let coordinator;
  t.after(() => {
    coordinator?.close();
    service?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.bindVerifiedGameAccount(ownerId, playerId, 1_798_000_000_000);
  store.selectRoutePolicy(playerId, {
    policy: "bridge_required",
    activeDeviceId: deviceId,
    expectedRouteEpoch: 0,
    updatedAt: 1_798_000_000_001,
  });

  const bridgeRequests = [];
  const snapshots = createAccountSnapshots({
    store,
    now: () => 1_798_000_000_100,
    fetcher: async () => {
      throw new Error("unexpected_direct_game_request");
    },
    bridgeTransport: async (request) => {
      bridgeRequests.push(request);
      if (request.path === "/api/auth/telegram")
        return Response.json({ accessToken });
      assert.equal(request.path, "/api/me");
      return Response.json(profile);
    },
  });
  service = createAutomationService({
    store,
    fetcher: snapshots.liveFetch,
    snapshotFetch: snapshots.fetch,
    accountHealth: snapshots.health,
    identifyPlayer: async () => profile,
    getBoss: (id) => ({ numericId: id, name: "Fixture boss" }),
    getBusinessCatalogue: () => ({ bosses: [], businesses: [], works: [] }),
    now: () => 1_798_000_000_100,
  });
  const credentials = createGameCredentialStore({
    store: fakePrivateStorage(),
    encryptionKey: randomBytes(32),
  });
  coordinator = createAuthCoordinator({
    store,
    credentialStore: credentials,
    controlGateway: {
      requestGameLaunch: async () => ({
        status: "ready",
        launchData: "signed-fixture-launch",
      }),
    },
    issueGameCredential: snapshots.issueGameCredential,
    verifyGameCredential: snapshots.verifyGameCredential,
    adoptGameCredential: async (candidate) => {
      snapshots.registerVerifiedCredential(
        `Bearer ${candidate.accessToken}`,
        candidate.playerId,
      );
      const pendingAdoption = service.adoptGameCredential(candidate);
      const previous = store.readRoutePolicy(playerId);
      const current = store.selectRoutePolicy(playerId, {
        policy: "direct",
        activeDeviceId: null,
        expectedRouteEpoch: previous.routeEpoch,
        updatedAt: 1_798_000_000_200,
      });
      assert.equal(
        coordinator.invalidateRoute({ ownerId, previous, current }),
        1,
      );
      return pendingAdoption;
    },
    revokeGameSession: (request) => service.logoutGameSession(request),
    isDeviceActive: () => true,
    now: () => 1_798_000_000_100,
    uuid: () => operationId,
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    requestId,
  );
  let latest;
  for (let attempt = 0; attempt < 100; attempt++) {
    latest = coordinator.status({ ownerId, operationId }, requestId);
    if (latest.status === "auth_outcome_unknown") break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(latest.status, "auth_outcome_unknown");
  assert.equal(latest.reason, "consent_required");
  assert.equal(store.readRoutePolicy(playerId).policy, "direct");
  assert.equal(store.readRoutePolicy(playerId).routeEpoch, 2);
  assert.equal(
    store.readGameAuthRecovery(ownerId).state,
    "auth_outcome_unknown",
  );
  assert.equal(store.read(playerId)?.credential ?? null, null);
  assert.equal(
    bridgeRequests.filter(({ path }) => path === "/api/auth/telegram").length,
    1,
  );
  await assert.rejects(service.identify(`Bearer ${accessToken}`), {
    status: 401,
  });

  assert.deepEqual(await coordinator.recover(), [
    { operationId, status: "auth_outcome_unknown" },
  ]);
  assert.equal(
    bridgeRequests.filter(({ path }) => path === "/api/auth/telegram").length,
    1,
  );
});

test("user cancellation during actor adoption keeps the late credential unadopted", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "madhouse-auth-cancel-adoption-"),
  );
  const store = createAutomationStateStore({ directory });
  let service;
  let coordinator;
  t.after(() => {
    coordinator?.close();
    service?.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.bindVerifiedGameAccount(ownerId, playerId, 1_798_000_000_000);
  store.selectRoutePolicy(playerId, {
    policy: "bridge_required",
    activeDeviceId: deviceId,
    expectedRouteEpoch: 0,
    updatedAt: 1_798_000_000_001,
  });

  const bridgeRequests = [];
  const snapshots = createAccountSnapshots({
    store,
    now: () => 1_798_000_000_100,
    fetcher: async () => {
      throw new Error("unexpected_direct_game_request");
    },
    bridgeTransport: async (request) => {
      bridgeRequests.push(request);
      if (request.path === "/api/auth/telegram")
        return Response.json({ accessToken });
      assert.equal(request.path, "/api/me");
      return Response.json(profile);
    },
  });
  service = createAutomationService({
    store,
    fetcher: snapshots.liveFetch,
    snapshotFetch: snapshots.fetch,
    accountHealth: snapshots.health,
    identifyPlayer: async () => profile,
    getBoss: (id) => ({ numericId: id, name: "Fixture boss" }),
    getBusinessCatalogue: () => ({ bosses: [], businesses: [], works: [] }),
    now: () => 1_798_000_000_100,
  });
  const privateStorage = fakePrivateStorage();
  const credentials = createGameCredentialStore({
    store: privateStorage,
    encryptionKey: randomBytes(32),
  });
  let cancellation;
  coordinator = createAuthCoordinator({
    store,
    credentialStore: credentials,
    controlGateway: {
      requestGameLaunch: async () => ({
        status: "ready",
        launchData: "signed-fixture-launch",
      }),
    },
    issueGameCredential: snapshots.issueGameCredential,
    verifyGameCredential: snapshots.verifyGameCredential,
    adoptGameCredential: async (candidate) => {
      snapshots.registerVerifiedCredential(
        `Bearer ${candidate.accessToken}`,
        candidate.playerId,
      );
      const pendingAdoption = service.adoptGameCredential(candidate);
      cancellation = await coordinator.cancel(
        { ownerId, operationId },
        requestId,
      );
      return pendingAdoption;
    },
    revokeGameSession: (request) => service.logoutGameSession(request),
    isDeviceActive: () => true,
    now: () => 1_798_000_000_100,
    uuid: () => operationId,
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    requestId,
  );
  let latest;
  for (let attempt = 0; attempt < 100; attempt++) {
    latest = coordinator.status({ ownerId, operationId }, requestId);
    if (latest.status === "auth_outcome_unknown") break;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  assert.equal(cancellation.status, "auth_outcome_unknown");
  assert.equal(cancellation.reason, "consent_required");
  assert.equal(latest.status, "auth_outcome_unknown");
  assert.equal(latest.reason, "consent_required");
  assert.equal(
    store.readGameAuthRecovery(ownerId).state,
    "auth_outcome_unknown",
  );
  assert.equal(store.read(playerId)?.credential ?? null, null);
  assert.equal(
    (await credentials.read(ownerId)).record.accessToken,
    accessToken,
  );
  assert.equal(
    Buffer.from(privateStorage.value).includes(Buffer.from(accessToken)),
    false,
  );
  assert.equal(
    bridgeRequests.filter(({ path }) => path === "/api/auth/telegram").length,
    1,
  );
  assert.deepEqual(await coordinator.recover(), [
    { operationId, status: "auth_outcome_unknown" },
  ]);
  assert.equal(
    bridgeRequests.filter(({ path }) => path === "/api/auth/telegram").length,
    1,
  );
});
