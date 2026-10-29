import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountSnapshots } from "../../scripts/account/snapshots.mjs";
import { createBridgeAccountService } from "../../scripts/bridge/account-service.mjs";
import { createBridgeAwareAccountFetch } from "../../scripts/bridge/bridge-aware-fetch.mjs";
import { createQueueActionGate } from "../../scripts/bridge/queue-action-gate.mjs";

const authorization = "Bearer mutation-barrier.fake";
const owner = "101";
const playerId = "42";
const deviceId = "00000000-0000-4000-8000-000000000001";
const url = "https://cargohustle.online/api/friends/requests/42/accept";

function setup() {
  const records = new Map();
  let failWrites = false;
  const store = {
    readSnapshots: () =>
      [...records.values()].map((record) => structuredClone(record)),
    writeSnapshot: (id, record) => {
      if (failWrites) throw new Error("fake_snapshot_storage_failure");
      records.set(String(id), structuredClone(record));
    },
    list: () => [],
    record: (id) => structuredClone(records.get(String(id))),
  };
  const snapshots = createAccountSnapshots({
    store,
    now: () => 200,
    fetcher: async () => Response.json({}),
  });
  snapshots.saveBridgeProfile(authorization, {
    playerId: Number(playerId),
    telegramId: Number(owner),
    nickname: "Snapshot before action",
  });

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
  const gate = createQueueActionGate();
  let physicalPosts = 0;
  let barrierObservedAtPost = null;
  const accountService = createBridgeAccountService({
    accounts,
    devices,
    registry,
    queueActionGate: gate,
    readProfile: async () => {
      throw new Error("mutation test must not read the bridge profile");
    },
    readGame: async () => {
      throw new Error("mutation test must not issue a bridge game read");
    },
    sendAction: async ({ openTunnel, validateTunnel }) => {
      await openTunnel();
      if ((await validateTunnel()) !== true)
        throw new Error("mutation was not admitted");
      const record = store.record(playerId);
      barrierObservedAtPost = {
        revision: record.profileRevision,
        meDirty: record.sections["/api/me"].dirty,
      };
      physicalPosts += 1;
      return { status: 200, body: Buffer.from("{}") };
    },
  });
  const directRoutes = {
    resolve: () => null,
    registerVerifiedDirect() {
      assert.fail("bridge mutation must not enroll a direct route");
    },
    withDirectLease() {
      assert.fail("bridge mutation must not use the direct route");
    },
  };
  const transport = createBridgeAwareAccountFetch({
    snapshots,
    accounts,
    directRoutes,
    accountService,
  });
  const job = {
    id: "mutation-job-1",
    status: "running",
    type: "friend.response",
    args: { playerId: 42, decision: "accept" },
  };
  return {
    accounts,
    failSnapshotWrites(value) {
      failWrites = value;
    },
    gate,
    job,
    physicalPostCount: () => physicalPosts,
    barrierObservedAtPost: () => barrierObservedAtPost,
    snapshots,
    store,
    transport,
  };
}

async function queuedAction(fixture) {
  return fixture.gate.run(
    fixture.job,
    false,
    authorization,
    () =>
      fixture.transport.liveFetch(url, {
        method: "POST",
        headers: { Authorization: authorization },
        body: "{}",
      }),
    () => true,
  );
}

test("bridge action commits the real snapshot barrier after gate claim and before fake POST", async () => {
  const fixture = setup();
  const initialRevision =
    fixture.snapshots.health(authorization).profileRevision;
  const response = await queuedAction(fixture);

  assert.equal(response.status, 200);
  assert.equal(fixture.physicalPostCount(), 1);
  assert.deepEqual(fixture.barrierObservedAtPost(), {
    revision: initialRevision + 1,
    meDirty: true,
  });
  assert.equal(
    fixture.snapshots.health(authorization).profileRevision,
    initialRevision + 1,
  );
});

test("bridge action without a queued gate permit never reaches fake POST or snapshot barrier", async () => {
  const fixture = setup();
  const initialRevision =
    fixture.snapshots.health(authorization).profileRevision;
  const initialProfile = fixture.store.record(playerId).sections["/api/me"];

  await assert.rejects(
    fixture.transport.liveFetch(url, {
      method: "POST",
      headers: { Authorization: authorization },
      body: "{}",
    }),
    { code: "bridge_unavailable" },
  );
  assert.equal(fixture.physicalPostCount(), 0);
  assert.equal(
    fixture.snapshots.health(authorization).profileRevision,
    initialRevision,
  );
  assert.deepEqual(
    fixture.store.record(playerId).sections["/api/me"],
    initialProfile,
  );
});

test("snapshot persistence failure after gate claim blocks fake POST", async () => {
  const fixture = setup();
  const initialRevision =
    fixture.snapshots.health(authorization).profileRevision;
  const initialProfile = fixture.store.record(playerId).sections["/api/me"];
  fixture.failSnapshotWrites(true);

  await assert.rejects(queuedAction(fixture), { code: "bridge_unavailable" });
  assert.equal(fixture.physicalPostCount(), 0);
  assert.equal(
    fixture.snapshots.health(authorization).profileRevision,
    initialRevision,
  );
  assert.deepEqual(
    fixture.store.record(playerId).sections["/api/me"],
    initialProfile,
  );
});
