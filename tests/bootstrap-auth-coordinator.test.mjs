import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAuthCoordinator } from "../scripts/account/auth-coordinator.mjs";
import { createBootstrapAuthCoordinator } from "../scripts/account/bootstrap-auth-coordinator.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

const ownerId = "7654321";
const playerId = "987654321";
const firstRequestId = "00000000-0000-4000-8000-000000000101";
const operationId = "00000000-0000-4000-8000-000000000102";
const statusRequestId = "00000000-0000-4000-8000-000000000103";
const logoutRequestId = "00000000-0000-4000-8000-000000000104";
const reloginRequestId = "00000000-0000-4000-8000-000000000105";
const logoutOperationId = "00000000-0000-4000-8000-000000000106";
const reloginOperationId = "00000000-0000-4000-8000-000000000107";
const token = (exp = 2_000_000_000) =>
  `e30.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.fixture`;
const profile = { telegramId: ownerId, playerId, nickname: "Fixture" };

function cargoLaunch(userId = ownerId, nonce = "a") {
  return new URLSearchParams({
    auth_date: "1790000000",
    hash: nonce.repeat(64),
    user: JSON.stringify({ id: Number(userId) }),
  }).toString();
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
        etag: `private-${nextEtag++}`,
        record: structuredClone(record),
      };
      return {
        etag: current.etag,
        credentialVersion: record.credentialVersion,
      };
    },
    get current() {
      return current ? structuredClone(current) : null;
    },
  };
}

async function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "madhouse-bootstrap-auth-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const store = createAutomationStateStore({ directory });
  t.after(() => store.close());
  let timestamp = 1_800_000_000_000;
  const credentialStore = options.credentialStore || fakeCredentialStore();
  const calls = { issue: [], verify: [], adopt: [] };
  const coordinator = createBootstrapAuthCoordinator({
    store,
    credentialStore,
    now: () => timestamp++,
    uuid: options.uuid || (() => operationId),
    issueGameCredential: async (request) => {
      calls.issue.push(request);
      if (options.issueGameCredential)
        return options.issueGameCredential(request);
      return Response.json({ accessToken: token() });
    },
    verifyGameCredential: async (request) => {
      calls.verify.push(request);
      if (options.verifyGameCredential)
        return options.verifyGameCredential(request);
      return Response.json(profile);
    },
    adoptGameCredential: async (request) => {
      calls.adopt.push(request);
      if (options.adoptGameCredential)
        return options.adoptGameCredential(request);
    },
  });
  return { store, credentialStore, calls, coordinator };
}

test("restore guard blocks direct bootstrap before issuance or credential adoption", async (t) => {
  const { store, calls, coordinator } = await fixture(t);
  store.startGameAuthBootstrap({
    schemaVersion: 1,
    ownerId,
    requestId: firstRequestId,
    operationId,
    authGeneration: 1,
    consentGeneration: 1,
    routeEpoch: 0,
    launchDataDigest: "a".repeat(64),
    state: "prepared",
    expectedCredentialVersion: 0,
    credentialVersion: null,
    playerId: null,
    createdAt: 1_799_999_999_999,
    updatedAt: 1_799_999_999_999,
  });
  assert.equal(store.readGameAuthBootstrap(ownerId).state, "prepared");
  store.activateRestoreGuard({ activatedAt: 1_800_000_000_000 });
  await assert.rejects(
    () =>
      coordinator.bootstrap(
        { ownerId, cargoLaunchData: cargoLaunch() },
        firstRequestId,
      ),
    /game_auth_busy/u,
  );
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.verify.length, 0);
  assert.equal(calls.adopt.length, 0);
  assert.equal(store.readGameAuthBootstrap(ownerId), null);
});

test("restore preparation binds a new journal to fresh consent and advances private generations", async (t) => {
  const privateRecord = {
    etag: "old-etag",
    record: {
      ownerId,
      playerId,
      credentialVersion: 4,
      authGeneration: 6,
      consentGeneration: 7,
      revoked: true,
    },
  };
  const { store, calls, coordinator } = await fixture(t, {
    credentialStore: fakeCredentialStore(privateRecord),
  });
  store.activateRestoreGuard({ activatedAt: 1_800_000_000_000 });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await assert.rejects(
    () => coordinator.prepareRestore(request, firstRequestId),
    /game_auth_busy/u,
  );
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: 1_800_000_000_000,
    identityIssuedAt: 1_800_000_000_000,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: 1_800_000_000_000,
    identityIssuedAt: 1_800_000_000_000,
    challenge: challenge.challenge,
  });
  const result = await coordinator.prepareRestore(request, firstRequestId);
  assert.equal(result.status, "prepared");
  const saved = store.readGameAuthBootstrap(ownerId);
  assert.equal(saved.authGeneration, 7);
  assert.equal(saved.consentGeneration, 8);
  assert.equal(saved.expectedCredentialVersion, 4);
  assert.equal(saved.routeEpoch, 1);
  assert.deepEqual(
    await coordinator.prepareRestore(request, firstRequestId),
    result,
  );
  await assert.rejects(
    () =>
      coordinator.prepareRestore(
        { ...request, cargoLaunchData: cargoLaunch(ownerId, "b") },
        firstRequestId,
      ),
    /game_auth_generation_conflict/u,
  );
  assert.equal(calls.issue.length, 0);
  assert.equal(calls.adopt.length, 0);
});

test("only a prepared restore can be cancelled and replaced by fresh consent and launch", async (t) => {
  let serial = 0;
  const { store, calls, coordinator } = await fixture(t, {
    uuid: () => (serial++ === 0 ? operationId : reloginOperationId),
  });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const confirm = (requestId) => {
    const challenge = store.issueRestoreOwnerChallenge({
      ownerId,
      issuedAt: timestamp,
      identityIssuedAt: timestamp,
    });
    store.recordRestoreOwnerConsent({
      ownerId,
      requestId,
      routePolicy: "direct",
      confirmedAt: timestamp,
      identityIssuedAt: timestamp,
      challenge: challenge.challenge,
    });
  };
  confirm(firstRequestId);
  await coordinator.prepareRestore(
    { ownerId, cargoLaunchData: cargoLaunch() },
    firstRequestId,
  );
  assert.deepEqual(store.readRestoreOwnerStatus(ownerId), {
    status: "auth_prepared",
  });
  assert.deepEqual(coordinator.cancelPreparedRestore({ ownerId }), {
    status: "cancelled",
  });
  assert.equal(calls.issue.length, 0);
  confirm(reloginRequestId);
  await assert.rejects(
    () =>
      coordinator.prepareRestore(
        { ownerId, cargoLaunchData: cargoLaunch() },
        reloginRequestId,
      ),
    /game_auth_busy/u,
  );
  const prepared = await coordinator.prepareRestore(
    { ownerId, cargoLaunchData: cargoLaunch(ownerId, "b") },
    reloginRequestId,
  );
  assert.equal(prepared.status, "prepared");
  assert.equal(store.readGameAuthBootstrap(ownerId).authGeneration, 2);
  assert.equal(
    (
      await coordinator.exchangeRestore(
        { ownerId, cargoLaunchData: cargoLaunch(ownerId, "b") },
        reloginRequestId,
      )
    ).status,
    "credential_stored",
  );
  assert.throws(
    () => coordinator.cancelPreparedRestore({ ownerId }),
    /game_auth_busy/u,
  );
  assert.equal(calls.issue.length, 1);
});

test("a second restore while private credentials are read invalidates preparation", async (t) => {
  let release;
  let notify;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    notify = resolve;
  });
  const credentialStore = {
    read: async () => {
      notify();
      await pending;
      return null;
    },
    compareAndSwap: async () => {
      throw new Error("unexpected write");
    },
  };
  const { store, calls, coordinator } = await fixture(t, { credentialStore });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: timestamp,
    identityIssuedAt: timestamp,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: challenge.challenge,
  });
  const preparing = coordinator.prepareRestore(
    { ownerId, cargoLaunchData: cargoLaunch() },
    firstRequestId,
  );
  await started;
  store.armRestoreGuardForMarker({ createdAt: timestamp + 1 });
  release();
  await assert.rejects(preparing, /game_auth_busy/u);
  assert.equal(store.readGameAuthBootstrap(ownerId), null);
  assert.equal(calls.issue.length, 0);
});

test("restore exchange writes a fresh credential once without adopting it", async (t) => {
  const { store, credentialStore, calls, coordinator } = await fixture(t);
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: timestamp,
    identityIssuedAt: timestamp,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: challenge.challenge,
  });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await coordinator.prepareRestore(request, firstRequestId);
  const result = await coordinator.exchangeRestore(request, firstRequestId);
  assert.equal(result.status, "credential_stored");
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.verify.length, 1);
  assert.equal(calls.adopt.length, 0);
  assert.equal(credentialStore.current.record.routeEpoch, 1);
  assert.equal(store.readGameAccountBinding(ownerId), null);
  assert.equal(store.isRestoreRequired(playerId), true);
  assert.throws(
    () =>
      store.stageRestoredGameAccount({
        ownerId,
        playerId,
        operationId: reloginOperationId,
        verifiedAt: timestamp + 100,
      }),
    /stale/u,
  );
  assert.equal(
    (await coordinator.stageRestore({ ownerId }, firstRequestId)).status,
    "credential_stored",
  );
  assert.equal(calls.adopt.length, 1);
  assert.equal(calls.adopt[0].restored, true);
  assert.equal(calls.adopt[0].routeEpoch, 1);
  const staged = {
    binding: store.readGameAccountBinding(ownerId),
    route: store.readRoutePolicy(playerId),
  };
  assert.equal(staged.binding.playerId, playerId);
  assert.equal(staged.route.routeEpoch, 1);
  assert.deepEqual(
    store.stageRestoredGameAccount({
      ownerId,
      playerId,
      operationId,
      verifiedAt: timestamp + 101,
    }),
    staged,
  );
  assert.equal(store.isRestoreAccountReauthorized(playerId), false);
  assert.equal(store.isRestoreRequired(playerId), true);
  assert.deepEqual(
    await coordinator.exchangeRestore(request, firstRequestId),
    result,
  );
  assert.equal(calls.issue.length, 1);
});

test("unknown restore issuance is never retried", async (t) => {
  const { store, calls, coordinator } = await fixture(t, {
    issueGameCredential: async () => {
      throw new Error("synthetic disconnect");
    },
  });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: timestamp,
    identityIssuedAt: timestamp,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: challenge.challenge,
  });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await coordinator.prepareRestore(request, firstRequestId);
  assert.equal(
    (await coordinator.exchangeRestore(request, firstRequestId)).status,
    "auth_outcome_unknown",
  );
  assert.deepEqual(store.readRestoreOwnerStatus(ownerId), {
    status: "auth_outcome_unknown",
  });
  assert.throws(
    () => coordinator.cancelPreparedRestore({ ownerId }),
    /game_auth_busy/u,
  );
  assert.equal(
    (await coordinator.exchangeRestore(request, firstRequestId)).status,
    "auth_outcome_unknown",
  );
  assert.equal(calls.issue.length, 1);
});

test("unknown restored issuance requires explicit acknowledgement and fresh consent before another attempt", async (t) => {
  let serial = 0;
  const { store, calls, coordinator } = await fixture(t, {
    uuid: () => (serial++ === 0 ? operationId : reloginOperationId),
    issueGameCredential: async () => {
      throw new Error("lost response");
    },
  });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const issueChallenge = () =>
    store.issueRestoreOwnerChallenge({
      ownerId,
      issuedAt: timestamp,
      identityIssuedAt: timestamp,
    }).challenge;
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: issueChallenge(),
  });
  const first = { ownerId, cargoLaunchData: cargoLaunch() };
  await coordinator.prepareRestore(first, firstRequestId);
  assert.equal(
    (await coordinator.exchangeRestore(first, firstRequestId)).status,
    "auth_outcome_unknown",
  );
  await assert.rejects(
    () =>
      coordinator.acknowledgeUnknownRestore({
        ownerId,
        challenge: "bad",
        confirmedAt: timestamp,
        identityIssuedAt: timestamp,
      }),
    /game_auth_operation_stale/u,
  );
  const challenge = issueChallenge();
  assert.deepEqual(
    await coordinator.acknowledgeUnknownRestore({
      ownerId,
      challenge,
      confirmedAt: timestamp,
      identityIssuedAt: timestamp,
    }),
    { status: "reauthorization_required" },
  );
  await assert.rejects(
    () =>
      coordinator.acknowledgeUnknownRestore({
        ownerId,
        challenge,
        confirmedAt: timestamp,
        identityIssuedAt: timestamp,
      }),
    /game_auth_busy/u,
  );
  assert.equal(calls.issue.length, 1);
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: reloginRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: issueChallenge(),
  });
  const next = { ownerId, cargoLaunchData: cargoLaunch(ownerId, "b") };
  assert.equal(
    (await coordinator.prepareRestore(next, reloginRequestId)).status,
    "prepared",
  );
  assert.equal(store.readGameAuthBootstrap(ownerId).authGeneration, 2);
  assert.equal(calls.issue.length, 1);
});

test("owner acknowledgement handles an interrupted exchange but cannot interrupt a live flight", async (t) => {
  let release, notify;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    notify = resolve;
  });
  const { store, calls, coordinator } = await fixture(t, {
    issueGameCredential: async () => {
      notify();
      await pending;
      throw new Error("lost response");
    },
  });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const issueChallenge = () =>
    store.issueRestoreOwnerChallenge({
      ownerId,
      issuedAt: timestamp,
      identityIssuedAt: timestamp,
    }).challenge;
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: issueChallenge(),
  });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await coordinator.prepareRestore(request, firstRequestId);
  const exchange = coordinator.exchangeRestore(request, firstRequestId);
  await started;
  const challenge = issueChallenge();
  await assert.rejects(
    () =>
      coordinator.acknowledgeUnknownRestore({
        ownerId,
        challenge,
        confirmedAt: timestamp,
        identityIssuedAt: timestamp,
      }),
    /game_auth_busy/u,
  );
  release();
  assert.equal((await exchange).status, "auth_outcome_unknown");
  assert.equal(calls.issue.length, 1);
  assert.equal(
    (
      await coordinator.acknowledgeUnknownRestore({
        ownerId,
        challenge,
        confirmedAt: timestamp,
        identityIssuedAt: timestamp,
      })
    ).status,
    "reauthorization_required",
  );
});

test("a persisted exchange intent can be acknowledged without a new game request", async (t) => {
  const { store, calls, coordinator } = await fixture(t);
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const issueChallenge = () =>
    store.issueRestoreOwnerChallenge({
      ownerId,
      issuedAt: timestamp,
      identityIssuedAt: timestamp,
    }).challenge;
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: issueChallenge(),
  });
  await coordinator.prepareRestore(
    { ownerId, cargoLaunchData: cargoLaunch() },
    firstRequestId,
  );
  const journal = store.readGameAuthBootstrap(ownerId);
  store.updateGameAuthBootstrap(ownerId, operationId, {
    ...journal,
    state: "exchange_pending",
    updatedAt: journal.updatedAt + 1,
  });
  assert.equal(
    (
      await coordinator.acknowledgeUnknownRestore({
        ownerId,
        challenge: issueChallenge(),
        confirmedAt: timestamp,
        identityIssuedAt: timestamp,
      })
    ).status,
    "reauthorization_required",
  );
  assert.equal(
    store.readGameAuthBootstrap(ownerId).reason,
    "unknown_acknowledged",
  );
  assert.equal(calls.issue.length, 0);
});

test("restore staging rejects a changed private credential before binding", async (t) => {
  const underlying = fakeCredentialStore();
  let changed = false;
  const credentialStore = {
    read: async () => {
      const saved = await underlying.read();
      return changed && saved
        ? { ...saved, record: { ...saved.record, routeEpoch: 2 } }
        : saved;
    },
    compareAndSwap: (input) => underlying.compareAndSwap(input),
  };
  const { store, coordinator } = await fixture(t, { credentialStore });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: timestamp,
    identityIssuedAt: timestamp,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: challenge.challenge,
  });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await coordinator.prepareRestore(request, firstRequestId);
  await coordinator.exchangeRestore(request, firstRequestId);
  changed = true;
  await assert.rejects(
    () => coordinator.stageRestore({ ownerId }, firstRequestId),
    /credential_unavailable/u,
  );
  assert.equal(store.readGameAccountBinding(ownerId), null);
  assert.equal(store.isRestoreRequired(playerId), true);
});

test("explicit restore resume completes a stored credential without reissuing it", async (t) => {
  let store;
  const context = await fixture(t, {
    adoptGameCredential: async (candidate) => {
      store.write(candidate.playerId, {
        credential: `Bearer ${candidate.accessToken}`,
        auto: { enabled: false },
      });
    },
  });
  ({ store } = context);
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: timestamp,
    identityIssuedAt: timestamp,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: challenge.challenge,
  });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await context.coordinator.prepareRestore(request, firstRequestId);
  await context.coordinator.exchangeRestore(request, firstRequestId);
  assert.deepEqual(store.readRestoreOwnerStatus(ownerId), {
    status: "auth_ready_to_resume",
  });
  assert.equal(
    (await context.coordinator.resumeRestore({ ownerId })).status,
    "ready",
  );
  assert.equal(context.calls.issue.length, 1);
  assert.equal(store.isRestoreAccountReauthorized(playerId), true);
  assert.equal(store.isRestoreRequired(playerId), true);
  assert.deepEqual(store.readRestoreOwnerStatus(ownerId), {
    status: "review_required",
  });
});

for (const unknown of [false, true])
  test(`restore resume reconciles a matching private credential after ${unknown ? "unknown outcome" : "interrupted verification"}`, async (t) => {
    let store;
    const context = await fixture(t, {
      adoptGameCredential: async (candidate) => {
        store.write(candidate.playerId, {
          credential: `Bearer ${candidate.accessToken}`,
          auto: { enabled: false },
        });
      },
    });
    ({ store } = context);
    const timestamp = 1_800_000_000_000;
    store.activateRestoreGuard({ activatedAt: timestamp });
    const challenge = store.issueRestoreOwnerChallenge({
      ownerId,
      issuedAt: timestamp,
      identityIssuedAt: timestamp,
    });
    store.recordRestoreOwnerConsent({
      ownerId,
      requestId: firstRequestId,
      routePolicy: "direct",
      confirmedAt: timestamp,
      identityIssuedAt: timestamp,
      challenge: challenge.challenge,
    });
    await context.coordinator.prepareRestore(
      { ownerId, cargoLaunchData: cargoLaunch() },
      firstRequestId,
    );
    let journal = store.readGameAuthBootstrap(ownerId);
    for (const state of ["exchange_pending", "verification_pending"])
      journal = store.updateGameAuthBootstrap(ownerId, operationId, {
        ...journal,
        state,
        updatedAt: journal.updatedAt + 1,
      });
    if (unknown)
      journal = store.updateGameAuthBootstrap(ownerId, operationId, {
        ...journal,
        state: "auth_outcome_unknown",
        reason: "storage_unavailable",
        updatedAt: journal.updatedAt + 1,
      });
    assert.deepEqual(store.readRestoreOwnerStatus(ownerId), {
      status: unknown ? "auth_outcome_unknown" : "auth_check_saved",
    });
    await assert.rejects(
      () => context.coordinator.resumeRestore({ ownerId }),
      /credential_unavailable/u,
    );
    assert.equal(
      store.readGameAuthBootstrap(ownerId).state,
      unknown ? "auth_outcome_unknown" : "verification_pending",
    );
    await context.credentialStore.compareAndSwap({
      ownerId,
      expectedEtag: null,
      record: {
        schemaVersion: 1,
        ownerId,
        playerId,
        credentialVersion: 1,
        authOperationId: operationId,
        authGeneration: journal.authGeneration,
        consentGeneration: journal.consentGeneration,
        routeEpoch: 1,
        expiresAt: timestamp + 60000,
        revoked: false,
        accessToken: token(),
      },
    });
    if (unknown) {
      const acknowledgement = store.issueRestoreOwnerChallenge({
        ownerId,
        issuedAt: timestamp,
        identityIssuedAt: timestamp,
      });
      await assert.rejects(
        () =>
          context.coordinator.acknowledgeUnknownRestore({
            ownerId,
            challenge: acknowledgement.challenge,
            confirmedAt: timestamp,
            identityIssuedAt: timestamp,
          }),
        /credential_unavailable/u,
      );
      assert.equal(
        store.readGameAuthBootstrap(ownerId).state,
        "auth_outcome_unknown",
      );
    }
    assert.equal(
      (await context.coordinator.resumeRestore({ ownerId })).status,
      "ready",
    );
    assert.equal(context.calls.issue.length, 0);
    assert.equal(store.isRestoreRequired(playerId), true);
  });

test("restore staging rejects a changed verified game identity before adoption", async (t) => {
  let count = 0;
  const { store, calls, coordinator } = await fixture(t, {
    verifyGameCredential: async () =>
      Response.json(
        ++count === 1 ? profile : { ...profile, telegramId: "7654322" },
      ),
  });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: timestamp,
    identityIssuedAt: timestamp,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: challenge.challenge,
  });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await coordinator.prepareRestore(request, firstRequestId);
  await coordinator.exchangeRestore(request, firstRequestId);
  await assert.rejects(
    () => coordinator.stageRestore({ ownerId }, firstRequestId),
    /game_account_mismatch/u,
  );
  assert.equal(store.readGameAccountBinding(ownerId), null);
  assert.equal(calls.adopt.length, 0);
  assert.equal(store.isRestoreRequired(playerId), true);
});

test("restore CAS lost reply reconciles only the exact stored candidate", async (t) => {
  const underlying = fakeCredentialStore();
  const credentialStore = {
    read: (...args) => underlying.read(...args),
    compareAndSwap: async (input) => {
      await underlying.compareAndSwap(input);
      throw new Error("synthetic lost reply");
    },
  };
  const { store, calls, coordinator } = await fixture(t, { credentialStore });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: timestamp,
    identityIssuedAt: timestamp,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: challenge.challenge,
  });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await coordinator.prepareRestore(request, firstRequestId);
  assert.equal(
    (await coordinator.exchangeRestore(request, firstRequestId)).status,
    "credential_stored",
  );
  assert.equal(underlying.current.record.authOperationId, operationId);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.adopt.length, 0);
});

test("restore CAS failure without a matching stored candidate stays unknown", async (t) => {
  const credentialStore = {
    read: async () => null,
    compareAndSwap: async () => {
      throw new Error("synthetic storage failure");
    },
  };
  const { store, calls, coordinator } = await fixture(t, { credentialStore });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: timestamp,
    identityIssuedAt: timestamp,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: challenge.challenge,
  });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await coordinator.prepareRestore(request, firstRequestId);
  assert.equal(
    (await coordinator.exchangeRestore(request, firstRequestId)).status,
    "auth_outcome_unknown",
  );
  assert.equal(
    (await coordinator.exchangeRestore(request, firstRequestId)).status,
    "auth_outcome_unknown",
  );
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.adopt.length, 0);
});

test("a new restore during credential issuance prevents verification and storage", async (t) => {
  let release;
  let notify;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    notify = resolve;
  });
  const { store, credentialStore, calls, coordinator } = await fixture(t, {
    issueGameCredential: async () => {
      notify();
      await pending;
      return Response.json({ accessToken: token() });
    },
  });
  const timestamp = 1_800_000_000_000;
  store.activateRestoreGuard({ activatedAt: timestamp });
  const challenge = store.issueRestoreOwnerChallenge({
    ownerId,
    issuedAt: timestamp,
    identityIssuedAt: timestamp,
  });
  store.recordRestoreOwnerConsent({
    ownerId,
    requestId: firstRequestId,
    routePolicy: "direct",
    confirmedAt: timestamp,
    identityIssuedAt: timestamp,
    challenge: challenge.challenge,
  });
  const request = { ownerId, cargoLaunchData: cargoLaunch() };
  await coordinator.prepareRestore(request, firstRequestId);
  const exchange = coordinator.exchangeRestore(request, firstRequestId);
  await started;
  store.armRestoreGuardForMarker({ createdAt: timestamp + 1 });
  release();
  await assert.rejects(exchange, /game_auth_operation_stale/u);
  assert.equal(calls.verify.length, 0);
  assert.equal(credentialStore.current, null);
  assert.equal(store.readGameAuthBootstrap(ownerId), null);
});

test("restore activated during profile verification prevents a late private credential write", async (t) => {
  let release;
  let started;
  const waiting = new Promise((resolve) => {
    started = resolve;
  });
  const proceed = new Promise((resolve) => {
    release = resolve;
  });
  const { store, credentialStore, calls, coordinator } = await fixture(t, {
    verifyGameCredential: async () => {
      started();
      await proceed;
      return Response.json(profile);
    },
  });
  const operation = coordinator.bootstrap(
    { ownerId, cargoLaunchData: cargoLaunch() },
    firstRequestId,
  );
  const result = operation.then(
    () => "completed",
    () => "rejected",
  );
  try {
    await waiting;
    store.activateRestoreGuard({ activatedAt: 1_800_000_000_100 });
  } finally {
    release();
  }
  assert.equal(await result, "rejected");
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.adopt.length, 0);
  assert.equal(credentialStore.current, null);
  assert.equal(store.readGameAccountBinding(ownerId), null);
});

test("restore during private credential CAS does not adopt or replay an ambiguous candidate", async (t) => {
  const inner = fakeCredentialStore();
  let release;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const credentialStore = {
    read: (...args) => inner.read(...args),
    compareAndSwap: async (args) => {
      markStarted();
      await blocked;
      return inner.compareAndSwap(args);
    },
  };
  const { store, calls, coordinator } = await fixture(t, { credentialStore });
  const result = coordinator
    .bootstrap({ ownerId, cargoLaunchData: cargoLaunch() }, firstRequestId)
    .then(
      () => "completed",
      () => "rejected",
    );
  try {
    await started;
    store.activateRestoreGuard({ activatedAt: 1_800_000_000_100 });
  } finally {
    release();
  }
  assert.equal(await result, "rejected");
  assert.equal(inner.current.record.authOperationId, operationId);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.adopt.length, 0);
  assert.equal(store.readGameAccountBinding(ownerId), null);
  await assert.rejects(
    () =>
      coordinator.bootstrap(
        { ownerId, cargoLaunchData: cargoLaunch() },
        firstRequestId,
      ),
    /game_auth_busy/u,
  );
  assert.equal(calls.issue.length, 1);
});

test("first direct login verifies Cargo identity, stores by CAS, binds owner, and returns no JWT", async (t) => {
  const { store, credentialStore, calls, coordinator } = await fixture(t);
  const launchData = cargoLaunch();
  const result = await coordinator.bootstrap(
    { ownerId, cargoLaunchData: launchData },
    firstRequestId,
  );

  assert.equal(result.status, "ready");
  assert.equal(Object.hasOwn(result, "accessToken"), false);
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.verify.length, 2);
  assert.equal(calls.adopt.length, 1);
  assert.equal(calls.issue[0].ownerId, ownerId);
  assert.equal(calls.issue[0].launchData, launchData);
  assert.equal(credentialStore.current.record.routeEpoch, 0);
  assert.equal(credentialStore.current.record.accessToken, token());
  assert.equal(store.readGameAccountBinding(ownerId).playerId, playerId);
  assert.equal(store.readGameAuthBootstrap(ownerId).state, "ready");

  const duplicate = await coordinator.bootstrap(
    { ownerId, cargoLaunchData: launchData },
    firstRequestId,
  );
  assert.equal(duplicate.status, "ready");
  assert.equal(calls.issue.length, 1);
  assert.equal(
    (await coordinator.bootstrapStatus({ ownerId }, statusRequestId)).status,
    "ready",
  );
});

test("direct bootstrap can re-enter only after durable game logout and a fresh launch", async (t) => {
  const { store, credentialStore, calls, coordinator } = await fixture(t);
  await coordinator.bootstrap(
    { ownerId, cargoLaunchData: cargoLaunch("7654321", "a") },
    firstRequestId,
  );

  const logout = createAuthCoordinator({
    store,
    credentialStore,
    controlGateway: { requestGameLaunch: async () => assert.fail("no launch") },
    issueGameCredential: async () => assert.fail("no exchange"),
    verifyGameCredential: async () => assert.fail("no verification"),
    adoptGameCredential: async () => assert.fail("no adoption"),
    revokeGameSession: async () => {},
    isDeviceActive: () => true,
    now: () => 1_800_000_100_000,
    uuid: () => logoutOperationId,
  });
  const loggedOut = await logout.logout({ ownerId }, logoutRequestId);
  assert.equal(loggedOut.status, "logged_out");
  assert.equal(store.readGameAuthRecovery(ownerId).authGeneration, 2);
  assert.equal(store.readGameAuthRecovery(ownerId).credentialVersion, 2);
  assert.equal(credentialStore.current.record.revoked, true);

  const relogin = createBootstrapAuthCoordinator({
    store,
    credentialStore,
    now: () => 1_800_000_200_000,
    uuid: () => reloginOperationId,
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
  });
  const result = await relogin.bootstrap(
    { ownerId, cargoLaunchData: cargoLaunch("7654321", "b") },
    reloginRequestId,
  );
  assert.equal(result.status, "ready");
  assert.equal(result.operationId, reloginOperationId);
  assert.equal(calls.issue.length, 2);
  assert.equal(credentialStore.current.record.revoked, false);
  assert.equal(credentialStore.current.record.credentialVersion, 3);
  assert.equal(credentialStore.current.record.authGeneration, 3);
  assert.equal(store.readGameAuthRecovery(ownerId).state, "logged_out");
  assert.equal(
    (await relogin.bootstrapStatus({ ownerId }, logoutRequestId)).status,
    "ready",
  );
});

test("unknown auth outcome is durable and only a distinct explicit launch can retry it", async (t) => {
  let ambiguous = true;
  const operationIds = [operationId, reloginOperationId];
  const { store, calls, coordinator } = await fixture(t, {
    uuid: () => operationIds.shift(),
    issueGameCredential: async () => {
      if (ambiguous) {
        ambiguous = false;
        throw new Error("transport_lost_after_dispatch");
      }
      return Response.json({ accessToken: token() });
    },
  });
  const result = await coordinator.bootstrap(
    { ownerId, cargoLaunchData: cargoLaunch(ownerId, "b") },
    firstRequestId,
  );
  assert.equal(result.status, "auth_outcome_unknown");
  assert.equal(result.reason, "unknown_outcome");
  assert.equal(calls.issue.length, 1);
  assert.equal(calls.verify.length, 0);
  assert.equal(
    store.readGameAuthBootstrap(ownerId).state,
    "auth_outcome_unknown",
  );
  const status = await coordinator.bootstrapStatus(
    { ownerId },
    statusRequestId,
  );
  assert.equal(status.status, "auth_outcome_unknown");
  const retry = await coordinator.bootstrap(
    { ownerId, cargoLaunchData: cargoLaunch(ownerId, "c") },
    reloginRequestId,
  );
  assert.equal(retry.status, "ready");
  assert.equal(calls.issue.length, 2);
  assert.equal(store.readGameAuthBootstrap(ownerId).authGeneration, 2);
  assert.equal(store.readGameAuthBootstrap(ownerId).consentGeneration, 2);
});

test("restart recovery adopts a CAS-saved candidate without issuing a second token", async (t) => {
  const credentialStore = fakeCredentialStore();
  const initial = await fixture(t, { credentialStore });
  const timestamp = 1_800_000_000_000;
  const launchData = cargoLaunch(ownerId, "d");
  let record = initial.store.startGameAuthBootstrap({
    schemaVersion: 1,
    ownerId,
    requestId: firstRequestId,
    operationId,
    authGeneration: 1,
    consentGeneration: 1,
    routeEpoch: 0,
    launchDataDigest: randomBytes(32).toString("hex"),
    state: "prepared",
    expectedCredentialVersion: 0,
    credentialVersion: null,
    playerId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  record = initial.store.updateGameAuthBootstrap(ownerId, operationId, {
    ...record,
    state: "exchange_pending",
    updatedAt: timestamp + 1,
  });
  record = initial.store.updateGameAuthBootstrap(ownerId, operationId, {
    ...record,
    state: "verification_pending",
    updatedAt: timestamp + 2,
  });
  await credentialStore.compareAndSwap({
    ownerId,
    expectedEtag: null,
    record: {
      schemaVersion: 1,
      ownerId,
      playerId,
      credentialVersion: 1,
      authOperationId: operationId,
      authGeneration: 1,
      consentGeneration: 1,
      routeEpoch: 0,
      expiresAt: Math.min(2_000_000_000_000, timestamp + 86_400_000),
      revoked: false,
      accessToken: token(),
    },
  });
  const digest = await import("node:crypto").then(({ createHash }) =>
    createHash("sha256").update(launchData).digest("hex"),
  );
  assert.equal(record.state, "verification_pending");
  assert.equal(initial.calls.issue.length, 0);
  await initial.coordinator.recover();
  assert.equal(initial.store.readGameAuthBootstrap(ownerId).state, "ready");
  assert.equal(
    initial.store.readGameAccountBinding(ownerId).playerId,
    playerId,
  );
  assert.equal(initial.calls.issue.length, 0);
  assert.equal(initial.calls.adopt.length, 1);
  assert.equal(digest.length, 64);
});

test("Cargo owner mismatch is rejected before dispatch", async (t) => {
  const { calls, coordinator } = await fixture(t);
  await assert.rejects(
    coordinator.bootstrap(
      { ownerId, cargoLaunchData: cargoLaunch("7654322") },
      firstRequestId,
    ),
    { code: "game_account_mismatch" },
  );
  assert.equal(calls.issue.length, 0);
});
