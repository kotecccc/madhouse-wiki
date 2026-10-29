import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountSnapshots } from "../../scripts/account/snapshots.mjs";
import { createBridgeAccountService } from "../../scripts/bridge/account-service.mjs";
import { createBridgeAwareAccountFetch } from "../../scripts/bridge/bridge-aware-fetch.mjs";

const authorization = "Bearer late-bridge-profile.fake";
const owner = "101";
const deviceId = "00000000-0000-4000-8000-000000000001";
const origin = "https://cargohustle.online";

function memoryStore() {
  const snapshots = new Map();
  return {
    readSnapshots: () =>
      [...snapshots.values()].map((value) => structuredClone(value)),
    writeSnapshot: (playerId, value) =>
      snapshots.set(String(playerId), structuredClone(value)),
    list: () => [],
    record: (playerId) => structuredClone(snapshots.get(String(playerId))),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("late bridge profile cannot overwrite a snapshot after its revision barrier changes", async () => {
  const store = memoryStore();
  const snapshots = createAccountSnapshots({
    store,
    now: () => 200,
    fetcher: async () => Response.json({ success: true }),
  });
  snapshots.saveBridgeProfile(authorization, {
    playerId: 42,
    telegramId: owner,
    nickname: "Before bridge read",
  });

  let bindingRevision = 1;
  let deviceGeneration = 1;
  const accounts = {
    resolveCredential: (value) =>
      value === authorization
        ? {
            policy: "bridge_required",
            owner,
            epoch: bindingRevision,
            credentialCurrent: true,
          }
        : null,
    read: (value) =>
      value === owner
        ? { authorization, playerId: "42", revision: bindingRevision }
        : null,
    getRevision: (value) => (value === owner ? bindingRevision : 0),
  };
  const devices = {
    listDevice: (value) =>
      value === owner ? { deviceId, generation: deviceGeneration } : null,
    open: async () => ({}),
  };
  const registry = {
    ownerKey: (value) => value,
    isActive: (identity) =>
      identity.owner === owner &&
      identity.device === deviceId &&
      identity.generation === deviceGeneration,
  };
  const profileStarted = deferred();
  const releaseProfile = deferred();
  const accountService = createBridgeAccountService({
    accounts,
    devices,
    registry,
    readProfile: async ({ openTunnel, validateTunnel }) => {
      await openTunnel();
      assert.equal(await validateTunnel(), true);
      profileStarted.resolve();
      await releaseProfile.promise;
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            playerId: 42,
            telegramId: owner,
            nickname: "Late response from bridge",
          }),
        ),
      };
    },
    readGame: async () => {
      throw new Error("profile-only race must not dispatch a bridge game read");
    },
  });
  const routeSnapshot = (authorizationValue) =>
    authorizationValue === authorization ? { playerId: 42, owner } : null;
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
    snapshots: {
      ...snapshots,
      identity: routeSnapshot,
      routingIdentity: routeSnapshot,
      fetch: (...args) => snapshots.read(...args),
      liveFetch: (...args) => snapshots.liveFetch(...args),
      bridgeProfile: snapshots.bridgeProfile,
      saveBridgeProfile: snapshots.saveBridgeProfile,
      readStored: snapshots.readStored,
    },
    accounts,
    directRoutes,
    accountService,
  });

  try {
    const pendingProfile = transport.liveFetch(`${origin}/api/me`, {
      headers: { Authorization: authorization },
    });
    await profileStarted.promise;

    // This fake direct transport response exercises the real mutation barrier
    // in account snapshots while the bridge profile remains delayed.
    const mutation = await snapshots.liveFetch(`${origin}/api/weapons/repair`, {
      method: "POST",
      headers: { Authorization: authorization },
      body: "{}",
    });
    assert.equal(mutation.status, 200);
    assert.equal(snapshots.health(authorization).profileRevision, 1);

    releaseProfile.resolve();
    const bridgeResponse = await pendingProfile;
    assert.equal(bridgeResponse.status, 409);
    assert.deepEqual(await bridgeResponse.json(), {
      error: "snapshot_superseded",
    });

    const saved = store.record(42);
    assert.equal(saved.sections["/api/me"].data.nickname, "Before bridge read");
    assert.equal(saved.profileRevision, 1);
  } finally {
    releaseProfile.resolve();
  }
});

test("bridge profile is not committed when the route epoch changes during the read", async () => {
  const store = memoryStore();
  const snapshots = createAccountSnapshots({
    store,
    now: () => 200,
    fetcher: async () => Response.json({ success: true }),
  });
  snapshots.saveBridgeProfile(authorization, {
    playerId: 42,
    telegramId: owner,
    nickname: "Before route change",
  });
  const initialRevision = snapshots.health(authorization).profileRevision;

  let routeEpoch = 1;
  const accounts = {
    resolveCredential: (value) =>
      value === authorization
        ? {
            policy: "bridge_required",
            owner,
            epoch: routeEpoch,
            credentialCurrent: true,
          }
        : null,
    read: (value) =>
      value === owner ? { authorization, playerId: "42", revision: 1 } : null,
    getRevision: (value) => (value === owner ? 1 : 0),
  };
  let deviceGeneration = 1;
  const devices = {
    listDevice: (value) =>
      value === owner ? { deviceId, generation: deviceGeneration } : null,
    open: async () => ({}),
  };
  const registry = {
    ownerKey: (value) => value,
    isActive: (identity) =>
      identity.owner === owner &&
      identity.device === deviceId &&
      identity.generation === deviceGeneration,
  };
  const profileStarted = deferred();
  const releaseProfile = deferred();
  const accountService = createBridgeAccountService({
    accounts,
    devices,
    registry,
    readProfile: async ({ openTunnel, validateTunnel }) => {
      await openTunnel();
      assert.equal(await validateTunnel(), true);
      profileStarted.resolve();
      await releaseProfile.promise;
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            playerId: 42,
            telegramId: owner,
            nickname: "Late response from changed route",
          }),
        ),
      };
    },
    readGame: async () => {
      throw new Error("profile-only race must not dispatch a bridge game read");
    },
  });
  const routeSnapshot = (authorizationValue) =>
    authorizationValue === authorization ? { playerId: 42, owner } : null;
  const directRoutes = {
    resolve: () => null,
    registerVerifiedDirect() {
      assert.fail("bridge credential must not enroll a direct route");
    },
    withDirectLease() {
      assert.fail("bridge credential must not use the direct route");
    },
  };
  let profileCommitCalls = 0;
  const transport = createBridgeAwareAccountFetch({
    snapshots: {
      ...snapshots,
      identity: routeSnapshot,
      routingIdentity: routeSnapshot,
      fetch: (...args) => snapshots.read(...args),
      liveFetch: (...args) => snapshots.liveFetch(...args),
      bridgeProfile: snapshots.bridgeProfile,
      saveBridgeProfile: snapshots.saveBridgeProfile,
      readStored: snapshots.readStored,
      commitBridgeProfileRead(ticket, profile) {
        profileCommitCalls += 1;
        return snapshots.commitBridgeProfileRead(ticket, profile);
      },
    },
    accounts,
    directRoutes,
    accountService,
  });

  try {
    const pendingProfile = transport.liveFetch(`${origin}/api/me`, {
      headers: { Authorization: authorization },
    });
    await profileStarted.promise;
    routeEpoch += 1;
    releaseProfile.resolve();

    await assert.rejects(pendingProfile, (error) => {
      assert.equal(error.code, "game_route_changed");
      return true;
    });
    assert.equal(profileCommitCalls, 0);
    assert.equal(
      snapshots.health(authorization).profileRevision,
      initialRevision,
    );
    assert.equal(
      store.record(42).sections["/api/me"].data.nickname,
      "Before route change",
    );
  } finally {
    releaseProfile.resolve();
  }
});

test("device revocation after profile completion blocks the snapshot commit", async () => {
  const store = memoryStore();
  const snapshots = createAccountSnapshots({
    store,
    now: () => 200,
    fetcher: async () => Response.json({ success: true }),
  });
  snapshots.saveBridgeProfile(authorization, {
    playerId: 42,
    telegramId: owner,
    nickname: "Before device revocation",
  });
  const initialRevision = snapshots.health(authorization).profileRevision;

  let deviceGeneration = 1;
  let resolveCredentialCalls = 0;
  const accounts = {
    resolveCredential: (value) => {
      if (value !== authorization) return null;
      resolveCredentialCalls += 1;
      // The third resolution is the router's post-read route check. Revoke
      // the device after accountService.profile has completed but before the
      // bridge-aware snapshot commit's in-process proof is checked.
      if (resolveCredentialCalls === 3) deviceGeneration += 1;
      return {
        policy: "bridge_required",
        owner,
        epoch: 1,
        credentialCurrent: true,
      };
    },
    read: (value) =>
      value === owner ? { authorization, playerId: "42", revision: 1 } : null,
    getRevision: (value) => (value === owner ? 1 : 0),
  };
  const devices = {
    listDevice: (value) =>
      value === owner ? { deviceId, generation: 1 } : null,
    open: async () => ({}),
  };
  const registry = {
    ownerKey: (value) => value,
    isActive: (identity) =>
      identity.owner === owner &&
      identity.device === deviceId &&
      identity.generation === deviceGeneration,
  };
  const accountService = createBridgeAccountService({
    accounts,
    devices,
    registry,
    readProfile: async ({ openTunnel, validateTunnel }) => {
      await openTunnel();
      assert.equal(await validateTunnel(), true);
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            playerId: 42,
            telegramId: owner,
            nickname: "Profile completed before revocation",
          }),
        ),
      };
    },
    readGame: async () => {
      throw new Error("profile-only race must not dispatch a bridge game read");
    },
  });
  const routeSnapshot = (authorizationValue) =>
    authorizationValue === authorization ? { playerId: 42, owner } : null;
  const directRoutes = {
    resolve: () => null,
    registerVerifiedDirect() {
      assert.fail("bridge credential must not enroll a direct route");
    },
    withDirectLease() {
      assert.fail("bridge credential must not use the direct route");
    },
  };
  let profileCommitCalls = 0;
  const transport = createBridgeAwareAccountFetch({
    snapshots: {
      ...snapshots,
      identity: routeSnapshot,
      routingIdentity: routeSnapshot,
      fetch: (...args) => snapshots.read(...args),
      liveFetch: (...args) => snapshots.liveFetch(...args),
      bridgeProfile: snapshots.bridgeProfile,
      saveBridgeProfile: snapshots.saveBridgeProfile,
      readStored: snapshots.readStored,
      commitBridgeProfileRead(ticket, profile) {
        profileCommitCalls += 1;
        return snapshots.commitBridgeProfileRead(ticket, profile);
      },
    },
    accounts,
    directRoutes,
    accountService,
  });

  const pendingProfile = transport.liveFetch(`${origin}/api/me`, {
    headers: { Authorization: authorization },
  });
  await assert.rejects(pendingProfile, (error) => {
    assert.equal(error.code, "game_route_changed");
    return true;
  });
  assert.equal(resolveCredentialCalls, 3);
  assert.equal(profileCommitCalls, 0);
  assert.equal(
    snapshots.health(authorization).profileRevision,
    initialRevision,
  );
  assert.equal(
    store.record(42).sections["/api/me"].data.nickname,
    "Before device revocation",
  );
});
