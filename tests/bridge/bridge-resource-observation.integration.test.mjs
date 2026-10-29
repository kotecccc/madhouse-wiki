import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountSnapshots } from "../../scripts/account/snapshots.mjs";
import { createBridgeAccountService } from "../../scripts/bridge/account-service.mjs";
import { createBridgeAwareAccountFetch } from "../../scripts/bridge/bridge-aware-fetch.mjs";

const authorization = "Bearer bridge-observation.fake";
const owner = "101";
const playerId = "42";
const deviceId = "00000000-0000-4000-8000-000000000001";
const origin = "https://cargohustle.online";
const bagUrl = `${origin}/api/me/bag`;

function memoryStore() {
  const records = new Map();
  return {
    readSnapshots: () =>
      [...records.values()].map((record) => structuredClone(record)),
    writeSnapshot: (id, record) =>
      records.set(String(id), structuredClone(record)),
    list: () => [],
    record: (id) => structuredClone(records.get(String(id))),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeBridge({ snapshots, readGame }) {
  const accounts = {
    resolveCredential: (value) =>
      value === authorization
        ? {
            policy: "bridge_required",
            owner,
            epoch: 1,
            credentialCurrent: true,
          }
        : null,
    read: (value) =>
      value === owner ? { authorization, playerId, revision: 1 } : null,
    getRevision: (value) => (value === owner ? 1 : 0),
  };
  const devices = {
    listDevice: (value) =>
      value === owner ? { deviceId, generation: 1 } : null,
    open: async (value) => {
      assert.equal(value, owner);
      return {};
    },
  };
  const registry = {
    ownerKey: (value) => value,
    isActive: (identity) =>
      identity.owner === owner &&
      identity.device === deviceId &&
      identity.generation === 1,
  };
  const accountService = createBridgeAccountService({
    accounts,
    devices,
    registry,
    readProfile: async () => {
      throw new Error("resource observation must not fetch /api/me");
    },
    readGame,
  });
  const directRoutes = {
    resolve: () => null,
    registerVerifiedDirect() {
      assert.fail("bridge credential must not enroll a direct route");
    },
    withDirectLease() {
      assert.fail("bridge credential must not use the direct route");
    },
  };
  const transport = createBridgeAwareAccountFetch({
    snapshots,
    accounts,
    directRoutes,
    accountService,
  });
  return { accounts, accountService, transport };
}

function routeSnapshots(snapshots) {
  const identity = (value) =>
    value === authorization ? { playerId: Number(playerId), owner } : null;
  return {
    ...snapshots,
    identity,
    routingIdentity: identity,
  };
}

test("bridge GET observation is stored as incomplete and read after snapshot restart", async () => {
  const store = memoryStore();
  let directFetcherCalls = 0;
  const snapshots = createAccountSnapshots({
    store,
    now: () => 200,
    fetcher: async () => {
      directFetcherCalls += 1;
      throw new Error("bridge observation should use the fake relay");
    },
  });
  snapshots.saveBridgeProfile(authorization, {
    playerId: Number(playerId),
    telegramId: Number(owner),
    nickname: "Verified profile",
  });
  const observedBag = {
    activityItems: [{ id: 7, name: "fake item", quantity: 3 }],
    consumables: [],
  };
  let bridgeReads = 0;
  const { transport } = makeBridge({
    snapshots: routeSnapshots(snapshots),
    readGame: async ({ path, openTunnel, validateTunnel }) => {
      assert.equal(path, "/api/me/bag");
      await openTunnel();
      assert.equal(await validateTunnel(), true);
      bridgeReads += 1;
      return {
        status: 200,
        body: Buffer.from(JSON.stringify(observedBag)),
      };
    },
  });

  const response = await transport.liveFetch(bagUrl, {
    headers: { Authorization: authorization },
  });
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("X-Madhouse-Snapshot-Completeness"),
    "unknown",
  );
  assert.ok(Number(response.headers.get("X-Madhouse-Section-Updated")) > 0);
  assert.deepEqual(await response.json(), observedBag);
  assert.equal(bridgeReads, 1);
  assert.equal(directFetcherCalls, 0);
  const cached = await transport.fetch(bagUrl, {
    headers: { Authorization: authorization, "X-Madhouse-Snapshot-Only": "1" },
  });
  assert.equal(cached.status, 200);
  assert.equal(cached.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.deepEqual(await cached.json(), observedBag);
  assert.equal(bridgeReads, 1);

  const stored = store.record(playerId).sections["/api/me/bag"];
  assert.deepEqual(stored.data, observedBag);
  assert.equal(stored.completeness, "unknown");
  assert.equal(stored.dirty, false);
  assert.deepEqual(stored.latestObservation, {
    observedAt: 200,
    source: "bridge",
    completeness: "unknown",
    sequence: 1,
    disposition: "accepted",
    rawIsData: true,
  });

  const restartedSnapshots = createAccountSnapshots({
    store,
    now: () => 201,
    fetcher: async () => {
      directFetcherCalls += 1;
      throw new Error("readStored must not call a game transport");
    },
  });
  const restartCallsBeforeRead = directFetcherCalls;
  const storedResponse = restartedSnapshots.readStored(bagUrl, {
    headers: { Authorization: authorization },
  });
  assert.equal(storedResponse.status, 200);
  assert.equal(storedResponse.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(
    storedResponse.headers.get("X-Madhouse-Snapshot-Completeness"),
    "unknown",
  );
  assert.deepEqual(await storedResponse.json(), observedBag);
  assert.equal(directFetcherCalls, restartCallsBeforeRead);
});

test("late bridge resource observation is rejected after a mutation barrier", async () => {
  const store = memoryStore();
  const initialBag = {
    activityItems: [{ id: 8, name: "previous item", quantity: 1 }],
    consumables: [],
  };
  let directFetcherCalls = 0;
  const snapshots = createAccountSnapshots({
    store,
    now: () => 200,
    fetcher: async () => {
      directFetcherCalls += 1;
      return Response.json(initialBag);
    },
  });
  snapshots.saveBridgeProfile(authorization, {
    playerId: Number(playerId),
    telegramId: Number(owner),
    nickname: "Verified profile",
  });
  const initialResponse = await snapshots.liveFetch(bagUrl, {
    headers: { Authorization: authorization },
  });
  assert.equal(initialResponse.status, 200);
  const initialRevision = snapshots.health(authorization).profileRevision;
  const initialObservation =
    store.record(playerId).sections["/api/me/bag"].latestObservation;
  const readStarted = deferred();
  const releaseRead = deferred();
  const lateBag = {
    activityItems: [{ id: 9, name: "late item", quantity: 2 }],
    consumables: [],
  };
  const { transport } = makeBridge({
    snapshots: routeSnapshots(snapshots),
    readGame: async ({ path, openTunnel, validateTunnel }) => {
      assert.equal(path, "/api/me/bag");
      await openTunnel();
      assert.equal(await validateTunnel(), true);
      readStarted.resolve();
      await releaseRead.promise;
      return { status: 200, body: Buffer.from(JSON.stringify(lateBag)) };
    },
  });

  try {
    const pendingRead = transport.liveFetch(bagUrl, {
      headers: { Authorization: authorization },
    });
    await readStarted.promise;

    const mutation = await snapshots.liveFetch(
      `${origin}/api/me/bag/boosters/use`,
      {
        method: "POST",
        headers: { Authorization: authorization },
        body: "{}",
      },
    );
    assert.equal(mutation.status, 200);
    assert.equal(
      snapshots.health(authorization).profileRevision,
      initialRevision + 1,
    );

    releaseRead.resolve();
    const lateResponse = await pendingRead;
    assert.equal(lateResponse.status, 409);
    assert.deepEqual(await lateResponse.json(), {
      error: "snapshot_superseded",
    });
    const saved = store.record(playerId);
    assert.deepEqual(saved.sections["/api/me/bag"].data, initialBag);
    assert.equal(saved.sections["/api/me/bag"].dirty, true);
    assert.deepEqual(
      saved.sections["/api/me/bag"].latestObservation,
      initialObservation,
    );
    assert.equal(saved.profileRevision, initialRevision + 1);
    assert.equal(directFetcherCalls, 2);
  } finally {
    releaseRead.resolve();
  }
});
