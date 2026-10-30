import assert from "node:assert/strict";
import { test } from "node:test";
import { createAccountSnapshots } from "../../scripts/account/snapshots.mjs";
import { createBridgeAccountService } from "../../scripts/bridge/account-service.mjs";
import { createBridgeAwareAccountFetch } from "../../scripts/bridge/bridge-aware-fetch.mjs";

const authorization = "Bearer profile-single-flight.fake";
const owner = "101";
const deviceId = "00000000-0000-4000-8000-000000000001";
const origin = "https://cargohustle.online";

function memoryStore() {
  const records = new Map();
  return {
    readSnapshots: () =>
      [...records.values()].map((record) => structuredClone(record)),
    writeSnapshot: (id, record) =>
      records.set(String(id), structuredClone(record)),
    list: () => [],
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(readProfile) {
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    now: () => 200,
    fetcher: async () => {
      throw new Error("profile test must not use direct game fetch");
    },
  });
  snapshots.saveBridgeProfile(authorization, {
    playerId: 42,
    telegramId: owner,
    nickname: "Previously verified",
  });
  let ticketsStarted = 0;
  let commits = 0;
  const snapshotApi = {
    ...snapshots,
    beginBridgeProfileRead(credential, options) {
      ticketsStarted += 1;
      return snapshots.beginBridgeProfileRead(credential, options);
    },
    commitBridgeProfileRead(ticket, profile) {
      commits += 1;
      return snapshots.commitBridgeProfileRead(ticket, profile);
    },
  };
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
      value === owner ? { authorization, playerId: "42", revision: 1 } : null,
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
  let profileReads = 0;
  const accountService = createBridgeAccountService({
    accounts,
    devices,
    registry,
    readProfile: async ({ openTunnel, validateTunnel, signal }) => {
      await openTunnel();
      assert.equal(await validateTunnel(), true);
      profileReads += 1;
      return readProfile({ signal, readNumber: profileReads });
    },
    readGame: async () => {
      throw new Error("profile-only test must not issue a bridge game read");
    },
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
    snapshots: snapshotApi,
    accounts,
    directRoutes,
    accountService,
  });
  return {
    accounts,
    snapshots,
    transport,
    profileReadCount: () => profileReads,
    ticketCount: () => ticketsStarted,
    commitCount: () => commits,
    snapshotHealth: () => snapshots.health(authorization),
  };
}

function profileResponse(nickname = "Fresh profile") {
  return {
    status: 200,
    body: Buffer.from(
      JSON.stringify({ playerId: 42, telegramId: owner, nickname }),
    ),
  };
}

test("compatible bridge profile consumers share one read and one snapshot ticket", async () => {
  const started = deferred();
  const release = deferred();
  const readResolved = { value: false };
  const fixture = setup(async () => {
    started.resolve();
    await release.promise;
    readResolved.value = true;
    return profileResponse();
  });

  const first = fixture.transport.liveFetch(`${origin}/api/me`, {
    headers: { Authorization: authorization },
  });
  const second = fixture.transport.liveFetch(`${origin}/api/me`, {
    headers: { Authorization: authorization },
  });
  const originalResolveCredential = fixture.accounts.resolveCredential;
  const thirdStarted = deferred();
  let thirdPromise = null;
  let triggeredThird = false;
  fixture.accounts.resolveCredential = (value) => {
    if (readResolved.value && !triggeredThird) {
      triggeredThird = true;
      thirdPromise = fixture.transport.liveFetch(`${origin}/api/me`, {
        headers: { Authorization: authorization },
      });
      thirdStarted.resolve();
    }
    return originalResolveCredential(value);
  };
  try {
    await started.promise;
    assert.equal(fixture.profileReadCount(), 1);
    assert.equal(fixture.ticketCount(), 1);
    release.resolve();
    await thirdStarted.promise;
    const responses = await Promise.all([first, second, thirdPromise]);
    assert.deepEqual(
      responses.map((response) => response.status),
      [200, 200, 200],
    );
    assert.deepEqual(
      await Promise.all(responses.map((response) => response.json())),
      [
        { playerId: 42, telegramId: owner, nickname: "Fresh profile" },
        { playerId: 42, telegramId: owner, nickname: "Fresh profile" },
        { playerId: 42, telegramId: owner, nickname: "Fresh profile" },
      ],
    );
    assert.equal(fixture.profileReadCount(), 1);
    assert.equal(fixture.ticketCount(), 1);
    assert.equal(fixture.commitCount(), 3);
  } finally {
    release.resolve();
  }
});

test("a bridge profile read after a mutation does not join the earlier flight", async () => {
  const firstStarted = deferred();
  const releaseFirst = deferred();
  const fixture = setup(async ({ readNumber }) => {
    if (readNumber === 1) {
      firstStarted.resolve();
      await releaseFirst.promise;
    }
    return profileResponse(`Profile ${readNumber}`);
  });
  const options = { headers: { Authorization: authorization } };
  const first = fixture.transport.liveFetch(`${origin}/api/me`, options);
  await firstStarted.promise;
  const ticket = fixture.snapshots.beginMutation(
    authorization,
    "POST",
    "/api/shop/buy",
  );
  assert.equal(fixture.snapshots.commitMutationBarrier(ticket), true);
  const second = fixture.transport.liveFetch(`${origin}/api/me`, options);
  try {
    const response = await second;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).nickname, "Profile 2");
    releaseFirst.resolve();
    assert.equal((await first).status, 409);
    assert.equal(fixture.profileReadCount(), 2);
  } finally {
    releaseFirst.resolve();
  }
});

test("bridge profile reads with a caller signal do not join the shared flight", async () => {
  const bothStarted = deferred();
  const release = deferred();
  let startCount = 0;
  const fixture = setup(async () => {
    startCount += 1;
    if (startCount === 2) bothStarted.resolve();
    await release.promise;
    return profileResponse(`Fresh profile ${startCount}`);
  });
  const controller = new AbortController();
  const withSignal = fixture.transport.liveFetch(`${origin}/api/me`, {
    headers: { Authorization: authorization },
    signal: controller.signal,
  });
  const withoutSignal = fixture.transport.liveFetch(`${origin}/api/me`, {
    headers: { Authorization: authorization },
  });

  try {
    await bothStarted.promise;
    assert.equal(fixture.profileReadCount(), 2);
    assert.equal(fixture.ticketCount(), 2);
    release.resolve();
    const responses = await Promise.all([withSignal, withoutSignal]);
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
  } finally {
    release.resolve();
  }
});
