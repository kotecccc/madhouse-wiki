import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuthCoordinator } from "../scripts/account/auth-coordinator.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

const ownerId = "7654321";
const playerId = "987654321";
const deviceId = "00000000-0000-4000-8000-000000000001";
const operationId = "00000000-0000-4000-8000-000000000123";
const logoutOperationId = "00000000-0000-4000-8000-000000000124";
const renewedOperationId = "00000000-0000-4000-8000-000000000125";
const responseRequestId = "00000000-0000-4000-8000-000000000456";
const token = (exp = 2_000_000_000) => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString(
    "base64url",
  );
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `${header}.${payload}.signature`;
};
const profile = { telegramId: ownerId, playerId, nickname: "Fixture" };

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fakeCredentialStore(initial = null) {
  let current = initial ? structuredClone(initial) : null;
  let nextEtag = 1;
  return {
    async read() {
      return current ? structuredClone(current) : null;
    },
    async compareAndSwap({ ownerId: targetOwner, expectedEtag, record }) {
      assert.equal(targetOwner, ownerId);
      assert.equal(current?.etag ?? null, expectedEtag);
      assert.equal(
        record.credentialVersion,
        current ? current.record.credentialVersion + 1 : 1,
      );
      current = {
        etag: `credential-${nextEtag++}`,
        record: structuredClone(record),
      };
      return {
        etag: current.etag,
        credentialVersion: record.credentialVersion,
      };
    },
    set(value) {
      current = structuredClone(value);
    },
    get current() {
      return current ? structuredClone(current) : null;
    },
  };
}

async function fixture(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "madhouse-auth-coordinator-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createAutomationStateStore({ directory });
  t.after(() => store.close());
  store.bindVerifiedGameAccount(ownerId, playerId, 1_798_000_000_000);
  store.selectRoutePolicy(playerId, {
    policy: "bridge_required",
    activeDeviceId: deviceId,
    expectedRouteEpoch: 0,
    updatedAt: 1_798_000_000_001,
  });
  const calls = { launch: [], issue: [], verify: [], adopt: [], revoke: [] };
  const credentials = overrides.credentialStore || fakeCredentialStore();
  const coordinator = createAuthCoordinator({
    store,
    credentialStore: credentials,
    controlGateway: {
      requestGameLaunch: async (request) => {
        calls.launch.push(request);
        return { status: "ready", launchData: "signed-fixture-launch" };
      },
    },
    issueGameCredential: async (request) => {
      calls.issue.push(request);
      return Response.json({ accessToken: token() });
    },
    verifyGameCredential: async (request) => {
      calls.verify.push(request);
      return Response.json(profile);
    },
    adoptGameCredential: async (request) => {
      calls.adopt.push(request);
    },
    revokeGameSession: async (request) => {
      calls.revoke.push(request);
    },
    isDeviceActive: () => true,
    now: () => 1_798_000_000_100,
    uuid: () => operationId,
    ...overrides.coordinator,
  });
  return { coordinator, credentials, store, calls };
}

async function waitForStatus(coordinator, expected, id = operationId) {
  let latest;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = coordinator.status(
      { ownerId, operationId: id },
      responseRequestId,
    );
    latest = result;
    if (result.status === expected) return result;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(
    `auth operation did not reach ${expected}; latest=${JSON.stringify(latest)}`,
  );
}

test("singleflight performs one routed issuance, verifies identity, and adopts the version", async (t) => {
  const { coordinator, credentials, calls } = await fixture(t);
  const started = await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  assert.equal(started.operation, "game_auth.start");
  assert.equal(started.status, "created");
  assert.equal(started.operationId, operationId);
  const ready = await waitForStatus(coordinator, "ready");
  assert.equal(ready.reason, undefined);
  assert.equal(calls.launch.length, 1);
  assert.deepEqual(
    {
      ownerId: calls.launch[0].ownerId,
      deviceId: calls.launch[0].deviceId,
      routeEpoch: calls.launch[0].routeEpoch,
      consentGeneration: calls.launch[0].consentGeneration,
    },
    { ownerId, deviceId, routeEpoch: 1, consentGeneration: 4 },
  );
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.issue[0].launchData, "signed-fixture-launch");
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.verify[0].playerId, playerId);
  assert.equal(calls.adopt.length, 1);
  assert.equal(calls.adopt[0].credentialVersion, 1);
  assert.equal(credentials.current.record.authOperationId, operationId);
  assert.equal(credentials.current.record.routeEpoch, 1);
});

test("a candidate profile with another Telegram owner never activates credentials", async (t) => {
  const { coordinator, credentials, store, calls } = await fixture(t, {
    coordinator: {
      verifyGameCredential: async (request) => {
        calls.verify.push(request);
        return Response.json({ ...profile, telegramId: "7654322" });
      },
    },
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  const outcome = await waitForStatus(coordinator, "auth_outcome_unknown");

  assert.equal(outcome.reason, "unknown_outcome");
  assert.equal(calls.launch.length, 1);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.verify[0].ownerId, ownerId);
  assert.equal(calls.verify[0].playerId, playerId);
  assert.equal(credentials.current, null);
  assert.equal(calls.adopt.length, 0);
  assert.equal(store.readGameAccountBinding(ownerId).playerId, playerId);
  assert.equal(store.readGameAccountBinding("7654322"), null);
});

test("a lost private CAS reply is resolved by operation and version without reissuing", async (t) => {
  const committed = fakeCredentialStore();
  let compareAndSwapCalls = 0;
  let reads = 0;
  const credentials = {
    read: async (...args) => {
      reads++;
      return committed.read(...args);
    },
    compareAndSwap: async (request) => {
      compareAndSwapCalls++;
      await committed.compareAndSwap(request);
      throw new Error("storage response lost after commit");
    },
    get current() {
      return committed.current;
    },
  };
  const { coordinator, calls } = await fixture(t, {
    credentialStore: credentials,
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  const ready = await waitForStatus(coordinator, "ready");

  assert.equal(ready.status, "ready");
  assert.equal(compareAndSwapCalls, 1);
  assert.ok(reads >= 2);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.adopt.length, 1);
  assert.equal(credentials.current.record.authOperationId, operationId);
  assert.equal(credentials.current.record.credentialVersion, 1);
});

test("parallel start requests never issue twice when the outcome is unknown", async (t) => {
  let issueCount = 0;
  const { coordinator } = await fixture(t, {
    coordinator: {
      issueGameCredential: async () => {
        issueCount++;
        throw new Error("connection closed after request dispatch");
      },
    },
  });
  const starts = await Promise.allSettled([
    coordinator.start(
      { ownerId, consentGeneration: 4, routeEpoch: 1 },
      responseRequestId,
    ),
    coordinator.start(
      { ownerId, consentGeneration: 4, routeEpoch: 1 },
      "00000000-0000-4000-8000-000000000457",
    ),
  ]);
  assert.equal(
    starts.filter((value) => value.status === "fulfilled").length,
    1,
  );
  await waitForStatus(coordinator, "auth_outcome_unknown");
  assert.equal(issueCount, 1);
});

test("a minted token with a lost auth response stays unknown after coordinator restart", async (t) => {
  const counts = { launch: 0, issue: 0, verify: 0, adopt: 0 };
  let mintedToken = null;
  const { coordinator, store, credentials } = await fixture(t, {
    coordinator: {
      controlGateway: {
        requestGameLaunch: async () => {
          counts.launch++;
          return { status: "ready", launchData: "signed-fixture-launch" };
        },
      },
      issueGameCredential: async () => {
        counts.issue++;
        mintedToken = token();
        throw new Error("response lost after Cargo minted the token");
      },
      verifyGameCredential: async () => {
        counts.verify++;
        return Response.json(profile);
      },
      adoptGameCredential: async () => {
        counts.adopt++;
      },
    },
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  const unknown = await waitForStatus(coordinator, "auth_outcome_unknown");
  assert.equal(unknown.reason, "unknown_outcome");
  assert.equal(mintedToken, token());
  assert.equal(await credentials.read(ownerId), null);
  assert.deepEqual(counts, { launch: 1, issue: 1, verify: 0, adopt: 0 });

  coordinator.close();
  const restarted = createAuthCoordinator({
    store,
    credentialStore: credentials,
    controlGateway: {
      requestGameLaunch: async () => {
        counts.launch++;
        return { status: "ready", launchData: "signed-fixture-launch" };
      },
    },
    issueGameCredential: async () => {
      counts.issue++;
      throw new Error("restart must not reissue a lost auth request");
    },
    verifyGameCredential: async () => {
      counts.verify++;
      return Response.json(profile);
    },
    adoptGameCredential: async () => {
      counts.adopt++;
    },
    revokeGameSession: async () => {},
    isDeviceActive: () => true,
    now: () => 1_798_000_000_100,
  });
  t.after(() => restarted.close());

  assert.deepEqual(await restarted.recover(), [
    { operationId, status: "auth_outcome_unknown" },
  ]);
  assert.equal(store.readGameAuthRecovery(ownerId).reason, "unknown_outcome");
  assert.equal(await credentials.read(ownerId), null);
  assert.deepEqual(counts, { launch: 1, issue: 1, verify: 0, adopt: 0 });
});

test("an explicit Cargo rejection fails safely without storing or verifying a credential", async (t) => {
  const { coordinator, calls, credentials } = await fixture(t, {
    coordinator: {
      issueGameCredential: async (request) => {
        calls.issue.push(request);
        return Response.json({ error: "invalid_launch" }, { status: 401 });
      },
    },
  });
  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );

  const failed = await waitForStatus(coordinator, "failed");
  assert.equal(failed.reason, "invalid_game_session");
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.adopt.length, 0);
  assert.equal(credentials.current, null);
});

test("a new explicit start resolves an unknown result and advances consent generation", async (t) => {
  let issueCount = 0;
  let uuidIndex = 0;
  const nextOperationId = "00000000-0000-4000-8000-000000000124";
  const { coordinator } = await fixture(t, {
    coordinator: {
      uuid: () => (uuidIndex++ === 0 ? operationId : nextOperationId),
      issueGameCredential: async () => {
        issueCount++;
        if (issueCount === 1) throw new Error("dispatch outcome unknown");
        return Response.json({ accessToken: token() });
      },
    },
  });
  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await waitForStatus(coordinator, "auth_outcome_unknown");

  const retry = await coordinator.start(
    { ownerId, consentGeneration: 1, routeEpoch: 1 },
    "00000000-0000-4000-8000-000000000457",
  );
  assert.equal(retry.operationId, nextOperationId);
  const ready = await waitForStatus(coordinator, "ready", nextOperationId);
  assert.equal(ready.status, "ready");
  assert.equal(issueCount, 2);
  assert.equal(
    coordinator.status(
      { ownerId, operationId: nextOperationId },
      responseRequestId,
    ).operationId,
    nextOperationId,
  );
  assert.throws(
    () => coordinator.status({ ownerId, operationId }, responseRequestId),
    { code: "game_auth_operation_not_found" },
  );
});

test("route changes stop before auth issuance and direct routing cannot be selected implicitly", async (t) => {
  const { coordinator, store, calls } = await fixture(t);
  await assert.rejects(
    coordinator.start(
      { ownerId, consentGeneration: 4, routeEpoch: 2 },
      responseRequestId,
    ),
    { code: "route_stale" },
  );
  store.selectRoutePolicy(playerId, {
    policy: "direct",
    activeDeviceId: null,
    expectedRouteEpoch: 1,
    updatedAt: 1_798_000_000_200,
  });
  await assert.rejects(
    coordinator.start(
      { ownerId, consentGeneration: 4, routeEpoch: 2 },
      responseRequestId,
    ),
    { code: "route_stale" },
  );
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.issue.length, 0);
});

test("a route switch while launch data is pending prevents credential issuance", async (t) => {
  const launchResult = deferred();
  let launchEntered;
  const entered = new Promise((resolve) => {
    launchEntered = resolve;
  });
  const { coordinator, store, calls } = await fixture(t, {
    coordinator: {
      controlGateway: {
        requestGameLaunch: async () => {
          launchEntered();
          return launchResult.promise;
        },
      },
    },
  });
  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await entered;
  store.selectRoutePolicy(playerId, {
    policy: "direct",
    activeDeviceId: null,
    expectedRouteEpoch: 1,
    updatedAt: 1_798_000_000_200,
  });
  launchResult.resolve({
    status: "ready",
    launchData: "signed-fixture-launch",
  });

  const failed = await waitForStatus(coordinator, "failed");
  assert.equal(failed.reason, "route_stale");
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.verify.length, 0);
});

test("a route switch during candidate verification prevents storage and adoption", async (t) => {
  const verificationResult = deferred();
  let verifyEntered;
  const entered = new Promise((resolve) => {
    verifyEntered = resolve;
  });
  const { coordinator, store, calls, credentials } = await fixture(t, {
    coordinator: {
      verifyGameCredential: async (request) => {
        calls.verify.push(request);
        verifyEntered();
        return verificationResult.promise;
      },
    },
  });
  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await entered;
  const previousRoute = store.readRoutePolicy(playerId);
  const currentRoute = store.selectRoutePolicy(playerId, {
    policy: "direct",
    activeDeviceId: null,
    expectedRouteEpoch: 1,
    updatedAt: 1_798_000_000_200,
  });
  assert.equal(
    coordinator.invalidateRoute({
      ownerId,
      previous: previousRoute,
      current: currentRoute,
    }),
    1,
  );
  verificationResult.resolve(Response.json(profile));

  const unknown = await waitForStatus(coordinator, "auth_outcome_unknown");
  assert.equal(unknown.reason, "consent_required");
  assert.equal(credentials.current, null);
  assert.equal(calls.adopt.length, 0);
});

test("cancelling after issuance dispatch marks consent-required unknown and drops the late token", async (t) => {
  let resolveIssue;
  let issueStarted;
  const issueEntered = new Promise((resolve) => {
    issueStarted = resolve;
  });
  const { coordinator, credentials, calls } = await fixture(t, {
    coordinator: {
      issueGameCredential: async () => {
        issueStarted();
        return new Promise((resolve) => {
          resolveIssue = () => resolve(Response.json({ accessToken: token() }));
        });
      },
    },
  });
  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await issueEntered;
  const cancelled = await coordinator.cancel(
    { ownerId, operationId },
    responseRequestId,
  );
  assert.equal(cancelled.status, "auth_outcome_unknown");
  assert.equal(cancelled.reason, "consent_required");
  resolveIssue();
  await waitForStatus(coordinator, "auth_outcome_unknown");
  assert.equal(credentials.current, null);
  assert.equal(calls.verify.length, 0);
});

test("cancelling during candidate verification rejects the late profile", async (t) => {
  const verificationResult = deferred();
  let verifyEntered;
  const entered = new Promise((resolve) => {
    verifyEntered = resolve;
  });
  const { coordinator, credentials, calls } = await fixture(t, {
    coordinator: {
      verifyGameCredential: async (request) => {
        calls.verify.push(request);
        verifyEntered();
        return verificationResult.promise;
      },
    },
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await entered;

  const cancelled = await coordinator.cancel(
    { ownerId, operationId },
    responseRequestId,
  );
  assert.equal(cancelled.status, "auth_outcome_unknown");
  assert.equal(cancelled.reason, "consent_required");
  assert.equal(calls.verify[0].signal.aborted, true);

  verificationResult.resolve(Response.json(profile));
  const unknown = await waitForStatus(coordinator, "auth_outcome_unknown");
  assert.equal(unknown.reason, "consent_required");
  assert.equal(credentials.current, null);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.adopt.length, 0);
  assert.deepEqual(await coordinator.recover(), [
    { operationId, status: "auth_outcome_unknown" },
  ]);
  assert.equal(calls.issue.length, 1);
});

test("cancelling while private CAS is pending preserves unknown state and never adopts", async (t) => {
  const writeResult = deferred();
  let writeEntered;
  let writeFinished;
  const entered = new Promise((resolve) => {
    writeEntered = resolve;
  });
  const finished = new Promise((resolve) => {
    writeFinished = resolve;
  });
  const baseCredentials = fakeCredentialStore();
  const credentials = {
    read: (...args) => baseCredentials.read(...args),
    compareAndSwap: async (request) => {
      writeEntered();
      await writeResult.promise;
      const result = await baseCredentials.compareAndSwap(request);
      writeFinished();
      return result;
    },
    get current() {
      return baseCredentials.current;
    },
  };
  const { coordinator, calls } = await fixture(t, {
    credentialStore: credentials,
  });
  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await entered;
  const cancelled = await coordinator.cancel(
    { ownerId, operationId },
    responseRequestId,
  );
  assert.equal(cancelled.status, "auth_outcome_unknown");
  assert.equal(cancelled.reason, "consent_required");
  writeResult.resolve();
  await finished;
  await new Promise((resolve) => setImmediate(resolve));
  await waitForStatus(coordinator, "auth_outcome_unknown");
  assert.equal(credentials.current.record.accessToken, token());
  assert.equal(calls.adopt.length, 0);
  assert.deepEqual(await coordinator.recover(), [
    { operationId, status: "auth_outcome_unknown" },
  ]);
});

test("restore during routed credential CAS leaves a late private record unadopted", async (t) => {
  const writeResult = deferred();
  const entered = deferred();
  const finished = deferred();
  const inner = fakeCredentialStore();
  const credentials = {
    read: (...args) => inner.read(...args),
    compareAndSwap: async (request) => {
      entered.resolve();
      await writeResult.promise;
      const result = await inner.compareAndSwap(request);
      finished.resolve();
      return result;
    },
  };
  const { coordinator, store, calls } = await fixture(t, {
    credentialStore: credentials,
  });
  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  try {
    await entered.promise;
    store.activateRestoreGuard({ activatedAt: 1_800_000_000_100 });
  } finally {
    writeResult.resolve();
  }
  await finished.promise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inner.current.record.authOperationId, operationId);
  assert.equal(store.readGameAuthRecovery(ownerId), null);
  assert.equal(store.readGameAccountBinding(ownerId), null);
  assert.equal(calls.adopt.length, 0);
  assert.equal(calls.issue.length, 1);
  assert.deepEqual(await coordinator.recover(), []);
  assert.equal(calls.issue.length, 1);
});

test("device revocation during private CAS blocks late adoption until new consent", async (t) => {
  const writeResult = deferred();
  let writeEntered;
  let writeFinished;
  let deviceActive = true;
  const entered = new Promise((resolve) => {
    writeEntered = resolve;
  });
  const finished = new Promise((resolve) => {
    writeFinished = resolve;
  });
  const baseCredentials = fakeCredentialStore();
  const credentials = {
    read: (...args) => baseCredentials.read(...args),
    compareAndSwap: async (request) => {
      writeEntered();
      await writeResult.promise;
      const result = await baseCredentials.compareAndSwap(request);
      writeFinished();
      return result;
    },
    get current() {
      return baseCredentials.current;
    },
  };
  const { coordinator, calls } = await fixture(t, {
    credentialStore: credentials,
    coordinator: { isDeviceActive: () => deviceActive },
  });
  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await entered;

  deviceActive = false;
  assert.equal(coordinator.invalidateDevice(deviceId), 1);
  const invalidated = coordinator.status(
    { ownerId, operationId },
    responseRequestId,
  );
  assert.equal(invalidated.status, "auth_outcome_unknown");
  assert.equal(invalidated.reason, "consent_required");
  writeResult.resolve();
  await finished;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    (await waitForStatus(coordinator, "auth_outcome_unknown")).reason,
    "consent_required",
  );
  assert.equal(credentials.current.record.authOperationId, operationId);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.adopt.length, 0);
  assert.deepEqual(await coordinator.recover(), [
    { operationId, status: "auth_outcome_unknown" },
  ]);
  assert.equal(calls.issue.length, 1);
});

test("route change during private CAS blocks late adoption until new consent", async (t) => {
  const writeResult = deferred();
  let writeEntered;
  let writeFinished;
  const entered = new Promise((resolve) => {
    writeEntered = resolve;
  });
  const finished = new Promise((resolve) => {
    writeFinished = resolve;
  });
  const baseCredentials = fakeCredentialStore();
  const credentials = {
    read: (...args) => baseCredentials.read(...args),
    compareAndSwap: async (request) => {
      writeEntered();
      await writeResult.promise;
      const result = await baseCredentials.compareAndSwap(request);
      writeFinished();
      return result;
    },
    get current() {
      return baseCredentials.current;
    },
  };
  const { coordinator, store, calls } = await fixture(t, {
    credentialStore: credentials,
  });
  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await entered;

  const previous = store.readRoutePolicy(playerId);
  const current = store.selectRoutePolicy(playerId, {
    policy: "direct",
    activeDeviceId: null,
    expectedRouteEpoch: previous.routeEpoch,
    updatedAt: 1_798_000_000_200,
  });
  assert.equal(coordinator.invalidateRoute({ ownerId, previous, current }), 1);
  writeResult.resolve();
  await finished;
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    (await waitForStatus(coordinator, "auth_outcome_unknown")).reason,
    "consent_required",
  );
  assert.equal(credentials.current.record.authOperationId, operationId);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.adopt.length, 0);
  assert.deepEqual(await coordinator.recover(), [
    { operationId, status: "auth_outcome_unknown" },
  ]);
  assert.equal(calls.issue.length, 1);
});

test("game logout invalidates a pending auth generation and writes a durable tombstone before fresh consent", async (t) => {
  let currentOperationId = operationId;
  let resolveLaunch;
  let launchStarted;
  let launchCount = 0;
  const launchEntered = new Promise((resolve) => {
    launchStarted = resolve;
  });
  const { coordinator, credentials, store, calls } = await fixture(t, {
    coordinator: {
      uuid: () => currentOperationId,
      controlGateway: {
        requestGameLaunch: async () => {
          launchCount += 1;
          if (launchCount > 1)
            return { status: "ready", launchData: "fresh-launch-data" };
          launchStarted();
          return new Promise((resolve) => {
            resolveLaunch = resolve;
          });
        },
      },
    },
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await launchEntered;
  currentOperationId = logoutOperationId;
  const loggedOut = await coordinator.logout({ ownerId }, responseRequestId);

  assert.equal(loggedOut.operation, "game_auth.logout");
  assert.equal(loggedOut.operationId, logoutOperationId);
  assert.equal(loggedOut.status, "logged_out");
  assert.equal(store.readGameAuthRecovery(ownerId).authGeneration, 2);
  assert.equal(store.readGameAuthRecovery(ownerId).consentGeneration, 5);
  assert.equal(credentials.current.record.revoked, true);
  assert.equal(credentials.current.record.accessToken, null);
  assert.equal(credentials.current.record.authOperationId, logoutOperationId);
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.revoke.length, 1);

  resolveLaunch({ status: "ready", launchData: "late-launch-data" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.issue.length, 0);
  assert.equal(store.readGameAuthRecovery(ownerId).state, "logged_out");

  currentOperationId = renewedOperationId;
  await coordinator.start(
    { ownerId, consentGeneration: 5, routeEpoch: 1 },
    responseRequestId,
  );
  assert.equal(
    (await waitForStatus(coordinator, "ready", renewedOperationId)).status,
    "ready",
  );
  assert.equal(store.readGameAuthRecovery(ownerId).authGeneration, 3);
  assert.equal(store.readGameAuthRecovery(ownerId).consentGeneration, 6);
  assert.equal(credentials.current.record.revoked, false);
  assert.equal(credentials.current.record.credentialVersion, 2);
});

test("game logout during dispatched issuance keeps a late JWT behind its tombstone", async (t) => {
  let currentOperationId = operationId;
  const issueEntered = deferred();
  const issueResult = deferred();
  const { coordinator, credentials, store, calls } = await fixture(t, {
    coordinator: {
      uuid: () => currentOperationId,
      issueGameCredential: async ({ signal }) => {
        issueEntered.resolve(signal);
        return issueResult.promise;
      },
    },
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  const issueSignal = await issueEntered.promise;
  currentOperationId = logoutOperationId;
  assert.equal(
    (await coordinator.logout({ ownerId }, responseRequestId)).status,
    "logged_out",
  );
  assert.equal(issueSignal.aborted, true);

  issueResult.resolve(Response.json({ accessToken: token() }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(store.readGameAuthRecovery(ownerId).state, "logged_out");
  assert.equal(credentials.current.record.revoked, true);
  assert.equal(credentials.current.record.authOperationId, logoutOperationId);
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.adopt.length, 0);
});

test("game logout wins a race with a candidate credential CAS", async (t) => {
  let currentOperationId = operationId;
  const commitEntered = deferred();
  const commitGate = deferred();
  const credentials = fakeCredentialStore();
  const commit = credentials.compareAndSwap.bind(credentials);
  credentials.compareAndSwap = async (input) => {
    if (!input.record.revoked) {
      commitEntered.resolve();
      await commitGate.promise;
    }
    return commit(input);
  };
  const { coordinator, store, calls } = await fixture(t, {
    credentialStore: credentials,
    coordinator: { uuid: () => currentOperationId },
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await commitEntered.promise;
  currentOperationId = logoutOperationId;
  assert.equal(
    (await coordinator.logout({ ownerId }, responseRequestId)).status,
    "logged_out",
  );
  commitGate.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(store.readGameAuthRecovery(ownerId).state, "logged_out");
  assert.equal(credentials.current.record.revoked, true);
  assert.equal(credentials.current.record.accessToken, null);
  assert.equal(credentials.current.record.authOperationId, logoutOperationId);
  assert.equal(calls.adopt.length, 0);
});

test("game logout during actor adoption keeps the late result behind its tombstone", async (t) => {
  let currentOperationId = operationId;
  const adoptionEntered = deferred();
  const adoptionGate = deferred();
  const { coordinator, credentials, store, calls } = await fixture(t, {
    coordinator: {
      uuid: () => currentOperationId,
      adoptGameCredential: async (request) => {
        calls.adopt.push(request);
        adoptionEntered.resolve();
        await adoptionGate.promise;
      },
    },
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await adoptionEntered.promise;
  currentOperationId = logoutOperationId;

  assert.equal(
    (await coordinator.logout({ ownerId }, responseRequestId)).status,
    "logged_out",
  );
  assert.equal(credentials.current.record.revoked, true);
  assert.equal(credentials.current.record.accessToken, null);
  assert.equal(credentials.current.record.authOperationId, logoutOperationId);

  adoptionGate.resolve();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(
    store.readGameAuthRecovery(ownerId).operationId,
    logoutOperationId,
  );
  assert.equal(store.readGameAuthRecovery(ownerId).state, "logged_out");
  assert.equal(credentials.current.record.revoked, true);
  assert.equal(credentials.current.record.accessToken, null);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.adopt.length, 1);
});

test("a preflight auth request cannot continue after concurrent game logout", async (t) => {
  let currentOperationId = operationId;
  let releaseCredentialRead;
  let notifyCredentialRead;
  const credentialReadStarted = new Promise((resolve) => {
    notifyCredentialRead = resolve;
  });
  const credentialReadGate = new Promise((resolve) => {
    releaseCredentialRead = resolve;
  });
  const credentials = fakeCredentialStore();
  const readCredential = credentials.read.bind(credentials);
  let firstRead = true;
  credentials.read = async (...args) => {
    if (firstRead) {
      firstRead = false;
      notifyCredentialRead();
      await credentialReadGate;
    }
    return readCredential(...args);
  };
  const { coordinator, store, calls } = await fixture(t, {
    credentialStore: credentials,
    coordinator: { uuid: () => currentOperationId },
  });

  const pendingStart = coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await credentialReadStarted;
  currentOperationId = logoutOperationId;
  const loggedOut = await coordinator.logout({ ownerId }, responseRequestId);
  assert.equal(loggedOut.status, "logged_out");

  releaseCredentialRead();
  await assert.rejects(pendingStart, {
    code: "game_auth_operation_stale",
  });
  assert.equal(store.readGameAuthRecovery(ownerId).state, "logged_out");
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.issue.length, 0);
});

test("device revocation during verification blocks late adoption until new consent", async (t) => {
  let deviceActive = true;
  let verificationCount = 0;
  let resolveVerification;
  let notifyVerification;
  const verificationStarted = new Promise((resolve) => {
    notifyVerification = resolve;
  });
  const { coordinator, store, calls } = await fixture(t, {
    coordinator: {
      isDeviceActive: () => deviceActive,
      verifyGameCredential: async () => {
        verificationCount++;
        notifyVerification();
        return new Promise((resolve) => {
          resolveVerification = resolve;
        });
      },
    },
  });

  await coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await verificationStarted;
  deviceActive = false;
  assert.equal(coordinator.invalidateDevice(deviceId), 1);
  assert.equal(
    store.readGameAuthRecovery(ownerId).state,
    "auth_outcome_unknown",
  );
  assert.equal(store.readGameAuthRecovery(ownerId).reason, "consent_required");

  resolveVerification(Response.json(profile));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls.adopt.length, 0);
  assert.equal(calls.issue.length, 1);
  assert.deepEqual(await coordinator.recover(), [
    { operationId, status: "auth_outcome_unknown" },
  ]);
  assert.equal(verificationCount, 1);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.adopt.length, 0);
});

test("device revocation during auth preflight prevents operation creation", async (t) => {
  let deviceActive = true;
  let releaseCredentialRead;
  let notifyCredentialRead;
  const credentialReadStarted = new Promise((resolve) => {
    notifyCredentialRead = resolve;
  });
  const credentialReadGate = new Promise((resolve) => {
    releaseCredentialRead = resolve;
  });
  const credentials = fakeCredentialStore();
  const readCredential = credentials.read.bind(credentials);
  credentials.read = async (...args) => {
    notifyCredentialRead();
    await credentialReadGate;
    return readCredential(...args);
  };
  const { coordinator, store, calls } = await fixture(t, {
    credentialStore: credentials,
    coordinator: { isDeviceActive: () => deviceActive },
  });

  const pendingStart = coordinator.start(
    { ownerId, consentGeneration: 4, routeEpoch: 1 },
    responseRequestId,
  );
  await credentialReadStarted;
  deviceActive = false;
  assert.equal(coordinator.invalidateDevice(deviceId), 0);
  releaseCredentialRead();

  await assert.rejects(pendingStart, { code: "route_stale" });
  assert.equal(store.readGameAuthRecovery(ownerId), null);
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.issue.length, 0);
});

test("restart recovery completes a persisted logout before any new issuance", async (t) => {
  const credentials = fakeCredentialStore({
    etag: "credential-existing",
    record: {
      schemaVersion: 1,
      ownerId,
      playerId,
      credentialVersion: 1,
      authOperationId: operationId,
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 1,
      expiresAt: 1_900_000_000_000,
      revoked: false,
      accessToken: token(),
    },
  });
  const { coordinator, store, calls } = await fixture(t, {
    credentialStore: credentials,
  });
  let recovery = store.startGameAuthRecovery({
    schemaVersion: 1,
    ownerId,
    playerId,
    operationId,
    authGeneration: 1,
    consentGeneration: 4,
    routeEpoch: 1,
    state: "created",
    expectedCredentialVersion: 0,
    credentialVersion: null,
    updatedAt: 1_798_000_000_050,
  });
  for (const [state, credentialVersion] of [
    ["launch_requested", null],
    ["exchange_pending", null],
    ["verification_pending", null],
    ["credential_stored", 1],
    ["ready", 1],
  ]) {
    recovery = store.updateGameAuthRecovery(ownerId, operationId, {
      ...recovery,
      state,
      credentialVersion,
      updatedAt: recovery.updatedAt + 1,
    });
  }
  store.beginGameAuthLogout({
    ...recovery,
    operationId: logoutOperationId,
    authGeneration: 2,
    consentGeneration: 5,
    state: "logout_pending",
    expectedCredentialVersion: 1,
    credentialVersion: null,
    updatedAt: recovery.updatedAt + 1,
  });

  assert.deepEqual(await coordinator.recover(), [
    { operationId: logoutOperationId, status: "logged_out" },
  ]);
  assert.equal(store.readGameAuthRecovery(ownerId).state, "logged_out");
  assert.equal(store.readGameAuthRecovery(ownerId).credentialVersion, 2);
  assert.equal(credentials.current.record.revoked, true);
  assert.equal(credentials.current.record.accessToken, null);
  assert.equal(credentials.current.record.authOperationId, logoutOperationId);
  assert.equal(calls.revoke.length, 1);
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.launch.length, 0);
});

test("restart recovery adopts a matching private credential without issuing again", async (t) => {
  const credentials = fakeCredentialStore({
    etag: "credential-existing",
    record: {
      schemaVersion: 1,
      ownerId,
      playerId,
      credentialVersion: 1,
      authOperationId: operationId,
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 1,
      expiresAt: 1_900_000_000_000,
      revoked: false,
      accessToken: token(),
    },
  });
  const { coordinator, store, calls } = await fixture(t, {
    credentialStore: credentials,
  });
  const created = {
    schemaVersion: 1,
    ownerId,
    playerId,
    operationId,
    authGeneration: 1,
    consentGeneration: 4,
    routeEpoch: 1,
    state: "created",
    expectedCredentialVersion: 0,
    credentialVersion: null,
    updatedAt: 1_798_000_000_050,
  };
  store.startGameAuthRecovery(created);
  let pending = store.updateGameAuthRecovery(ownerId, operationId, {
    ...created,
    state: "launch_requested",
    updatedAt: created.updatedAt + 1,
  });
  pending = store.updateGameAuthRecovery(ownerId, operationId, {
    ...pending,
    state: "exchange_pending",
    updatedAt: pending.updatedAt + 1,
  });
  store.updateGameAuthRecovery(ownerId, operationId, {
    ...pending,
    state: "verification_pending",
    updatedAt: pending.updatedAt + 1,
  });
  assert.deepEqual(await coordinator.recover(), [
    { operationId, status: "ready" },
  ]);
  assert.equal(store.readGameAuthRecovery(ownerId).state, "ready");
  assert.equal(calls.launch.length, 0);
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.adopt.length, 1);
});

test("ready credentials remain ready on restart without a live verification request", async (t) => {
  const credentials = fakeCredentialStore({
    etag: "credential-existing",
    record: {
      schemaVersion: 1,
      ownerId,
      playerId,
      credentialVersion: 1,
      authOperationId: operationId,
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 1,
      expiresAt: 1_900_000_000_000,
      revoked: false,
      accessToken: token(),
    },
  });
  const { coordinator, store, calls } = await fixture(t, {
    credentialStore: credentials,
  });
  store.startGameAuthRecovery({
    schemaVersion: 1,
    ownerId,
    playerId,
    operationId,
    authGeneration: 1,
    consentGeneration: 4,
    routeEpoch: 1,
    state: "created",
    expectedCredentialVersion: 0,
    credentialVersion: null,
    updatedAt: 1_798_000_000_050,
  });
  let record = store.readGameAuthRecovery(ownerId);
  for (const [state, credentialVersion] of [
    ["launch_requested", null],
    ["exchange_pending", null],
    ["verification_pending", null],
    ["credential_stored", 1],
    ["ready", 1],
  ]) {
    record = store.updateGameAuthRecovery(ownerId, operationId, {
      ...record,
      state,
      credentialVersion,
      updatedAt: record.updatedAt + 1,
    });
  }

  assert.deepEqual(await coordinator.recover(), [
    { operationId, status: "ready" },
  ]);
  assert.equal(store.readGameAuthRecovery(ownerId).state, "ready");
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.adopt.length, 0);
});
