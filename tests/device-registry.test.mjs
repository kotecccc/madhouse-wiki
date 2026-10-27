import assert from "node:assert/strict";
import {
  createHmac,
  generateKeyPairSync,
  randomUUID,
  sign as signEd25519,
} from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket } from "ws";
import test from "node:test";
import { createDeviceRegistry } from "../scripts/bridge/device-registry.mjs";
import { createBridgeControlGateway } from "../scripts/bridge/control-gateway.mjs";
import { createBridgeHttp } from "../scripts/bridge/bridge-http.mjs";
import { encodeDeviceChallenge } from "../scripts/bridge/protocol-v1/challenge.mjs";
import { signOwnerProof } from "../scripts/bridge/protocol-v1/owner-proof.mjs";
import { verifyDeviceSessionCredential } from "../scripts/bridge/protocol-v1/session-credential.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createAutomationRuntime } from "../scripts/automation/runtime.mjs";

const uuid = (tail) => `00000000-0000-4000-8000-${tail.padStart(12, "0")}`;
const ownerProofKey = new Uint8Array(32).fill(23);
const testBotToken = "123456:bridge-test-token";
const codeForOther = (code) => (code === "AAAAAA" ? "BBBBBB" : "AAAAAA");

function signedOwnerInit(userId, nowMs) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(nowMs / 1000)),
    user: JSON.stringify({ id: Number(userId) }),
    query_id: "bridge-test",
  });
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData")
    .update(testBotToken)
    .digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

async function ownerProof(operation, { subject = "54321", nowMs = 1000 } = {}) {
  const issuedAtSeconds = Math.floor(nowMs / 1000);
  return signOwnerProof(
    {
      issuer: "madhouse-wiki",
      audience: "madhouse-wiki-bridge-internal",
      subject,
      operation,
      issuedAtSeconds,
      expiresAtSeconds: issuedAtSeconds + 60,
      jti: randomUUID(),
      identityGeneration: 1,
    },
    ownerProofKey,
  );
}

function startRequest({
  requestId = uuid("1"),
  idempotencyKey = uuid("2"),
  deviceId = uuid("3"),
  publicKey = Buffer.alloc(32, 7).toString("base64url"),
  deviceName = "This computer",
  platform = "macos",
} = {}) {
  return {
    operation: "device.pair.start",
    requestId,
    idempotencyKey,
    deviceId,
    publicKey,
    deviceName,
    platform,
  };
}

async function approveRequest(
  pairing,
  { requestId = uuid("4"), code, subject, nowMs = 1000 } = {},
) {
  return {
    operation: "device.pair.approve",
    requestId,
    ownerProof: await ownerProof("device.pair.approve", { subject, nowMs }),
    pairingId: pairing.pairingId,
    matchingCode: code ?? pairing.displayCode,
  };
}

async function revokeRequest(
  deviceId,
  {
    requestId = uuid("10"),
    expectedGeneration = 1,
    subject,
    nowMs = 1000,
  } = {},
) {
  return {
    operation: "device.revoke",
    requestId,
    ownerProof: await ownerProof("device.revoke", { subject, nowMs }),
    deviceId,
    expectedGeneration,
  };
}

async function listRequest({
  requestId = uuid("12"),
  subject,
  nowMs = 1000,
} = {}) {
  return {
    operation: "device.list",
    requestId,
    ownerProof: await ownerProof("device.list", { subject, nowMs }),
  };
}

async function selectRouteRequest(
  {
    requestId = uuid("13"),
    policy = "bridge_required",
    activeDeviceId = uuid("3"),
    expectedRouteEpoch = 0,
  } = {},
  { subject = "54321", nowMs = 1000 } = {},
) {
  return {
    operation: "route.select",
    requestId,
    ownerProof: await ownerProof("route.select", { subject, nowMs }),
    policy,
    activeDeviceId: policy === "direct" ? null : activeDeviceId,
    expectedRouteEpoch,
  };
}

function retrievalRequest(operation, pairing, requestId) {
  return {
    operation,
    requestId,
    pairingId: pairing.pairingId,
    retrievalSecret: pairing.retrievalSecret,
  };
}

async function withStore(run) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-device-registry-"));
  let store = createAutomationStateStore({ directory });
  try {
    await run({
      directory,
      get store() {
        return store;
      },
      replace() {
        store.close();
        store = createAutomationStateStore({ directory });
        return store;
      },
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

async function createRoutedSessionFixture({
  store,
  now,
  onDeviceRevoked,
  onRouteChanging,
  onRouteChanged,
}) {
  let activeStore = store;
  const deviceId = uuid("301");
  const keyPair = generateKeyPairSync("ed25519");
  const publicKey = keyPair.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32)
    .toString("base64url");
  const sessionSigningKey = new Uint8Array(32).fill(77);
  activeStore.bindVerifiedGameAccount("54321", 17, now());
  activeStore.selectRoutePolicy("17", {
    policy: "bridge_required",
    activeDeviceId: deviceId,
    expectedRouteEpoch: 0,
    updatedAt: now(),
  });
  const makeRegistry = () =>
    createDeviceRegistry({
      store: activeStore,
      now,
      ownerProofKey,
      sessionSigningKey,
      onDeviceRevoked,
      onRouteChanging,
      onRouteChanged,
      resolveDeviceRoute: (verifiedOwnerId) => {
        const binding = activeStore.readGameAccountBinding(verifiedOwnerId);
        return binding ? activeStore.readRoutePolicy(binding.playerId) : null;
      },
    });
  let registry = makeRegistry();
  const pairing = registry.startPairing(startRequest({ deviceId, publicKey }));
  await registry.approvePairing(
    await approveRequest(pairing, { nowMs: now() }),
  );
  return {
    deviceId,
    keyPair,
    sessionSigningKey,
    get registry() {
      return registry;
    },
    restart(nextStore) {
      activeStore = nextStore;
      registry = makeRegistry();
    },
  };
}

function signSessionChallenge(challenge, privateKey) {
  return signEd25519(
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
    privateKey,
  ).toString("base64url");
}

test("pairing is idempotent, secret-protected, owner-bound and durable through revoke", async () => {
  await withStore(async ({ directory, store, replace }) => {
    const registry = createDeviceRegistry({
      store,
      now: () => 1000,
      ownerProofKey,
    });
    const request = startRequest();
    const pairing = registry.startPairing(request);
    const repeated = registry.startPairing({
      ...request,
      requestId: uuid("5"),
    });
    assert.equal(repeated.pairingId, pairing.pairingId);
    assert.equal(repeated.displayCode, pairing.displayCode);
    assert.equal(repeated.retrievalSecret, pairing.retrievalSecret);
    assert.notEqual(repeated.requestId, pairing.requestId);
    assert.throws(
      () => registry.startPairing({ ...request, deviceName: "Other computer" }),
      /idempotency_conflict/u,
    );
    assert.throws(
      () =>
        registry.pairingStatus({
          ...retrievalRequest("device.pair.status", pairing, uuid("6")),
          retrievalSecret: Buffer.alloc(32, 9).toString("base64url"),
        }),
      /pairing_not_found/u,
    );

    const approved = await registry.approvePairing(
      await approveRequest(pairing),
    );
    assert.equal(approved.status, "approved");
    assert.equal(approved.deviceId, request.deviceId);
    assert.equal(approved.deviceGeneration, 1);
    assert.equal(
      registry.isDeviceActive({ ownerId: "54321", deviceId: request.deviceId }),
      true,
    );
    assert.equal(
      registry.isDeviceActive({ ownerId: "54322", deviceId: request.deviceId }),
      false,
    );
    const paired = await registry.pairingStatus(
      retrievalRequest("device.pair.status", pairing, uuid("61")),
    );
    assert.equal(paired.expectedTelegramOwnerId, "54321");
    assert.equal(
      (
        await registry.approvePairing(
          await approveRequest(pairing, { requestId: uuid("7") }),
        )
      ).status,
      "already_approved",
    );
    const wrongOwnerRequest = await approveRequest(pairing, {
      requestId: uuid("8"),
      subject: "54322",
    });
    await assert.rejects(
      () => registry.approvePairing(wrongOwnerRequest),
      /pairing_not_found/u,
    );
    assert.deepEqual(
      (await registry.listOwnedDevices(await listRequest())).devices,
      [
        {
          deviceId: request.deviceId,
          deviceName: "This computer",
          platform: "macos",
          status: "active",
          generation: 1,
          createdAtMs: 1000,
          approvedAtMs: 1000,
          revokedAtMs: null,
        },
      ],
    );

    const files = readdirSync(directory).filter((name) =>
      [
        "automation.sqlite",
        "automation.sqlite-wal",
        "automation.sqlite-shm",
      ].includes(name),
    );
    for (const file of files) {
      const bytes = readFileSync(join(directory, file));
      for (const secret of [
        "54321",
        pairing.displayCode,
        pairing.retrievalSecret,
        request.publicKey,
      ])
        assert.equal(bytes.includes(Buffer.from(secret)), false);
    }

    const restored = replace();
    const afterRestart = createDeviceRegistry({
      store: restored,
      now: () => 2000,
      ownerProofKey,
    });
    assert.equal(
      afterRestart.pairingStatus(
        retrievalRequest("device.pair.status", pairing, uuid("9")),
      ).status,
      "approved",
    );
    assert.equal(
      (
        await afterRestart.revokeDevice(
          await revokeRequest(request.deviceId, { nowMs: 2000 }),
        )
      ).status,
      "revoked",
    );
    assert.equal(
      afterRestart.isDeviceActive({
        ownerId: "54321",
        deviceId: request.deviceId,
      }),
      false,
    );

    const finalStore = replace();
    const finalRegistry = createDeviceRegistry({
      store: finalStore,
      now: () => 3000,
      ownerProofKey,
    });
    const listed = await finalRegistry.listOwnedDevices(
      await listRequest({ nowMs: 3000 }),
    );
    assert.equal(listed.devices[0].status, "revoked");
    assert.equal(listed.devices[0].generation, 2);
    assert.equal(
      (
        await finalRegistry.revokeDevice(
          await revokeRequest(request.deviceId, {
            requestId: uuid("11"),
            nowMs: 3000,
          }),
        )
      ).status,
      "already_revoked",
    );
  });
});

test("pairing code guesses persist, lock the request, and approval/cancel is terminal", async () => {
  await withStore(async ({ store }) => {
    const registry = createDeviceRegistry({
      store,
      now: () => 1000,
      ownerProofKey,
    });
    const pairing = registry.startPairing(startRequest());
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const request = await approveRequest(pairing, {
        requestId: uuid(String(20 + attempt)),
        code: codeForOther(pairing.displayCode),
      });
      await assert.rejects(
        () => registry.approvePairing(request),
        /pairing_code_invalid/u,
      );
    }
    assert.equal(
      registry.pairingStatus(
        retrievalRequest("device.pair.status", pairing, uuid("30")),
      ).status,
      "expired",
    );

    const anotherPairing = registry.startPairing(
      startRequest({
        requestId: uuid("31"),
        idempotencyKey: uuid("32"),
        deviceId: uuid("33"),
      }),
    );
    assert.equal(
      registry.cancelPairing(
        retrievalRequest("device.pair.cancel", anotherPairing, uuid("34")),
      ).status,
      "cancelled",
    );
    assert.equal(
      registry.pairingStatus(
        retrievalRequest("device.pair.status", anotherPairing, uuid("35")),
      ).status,
      "cancelled",
    );
    const cancelledApprovalRequest = await approveRequest(anotherPairing, {
      requestId: uuid("36"),
    });
    await assert.rejects(
      () => registry.approvePairing(cancelledApprovalRequest),
      /pairing_expired/u,
    );
  });
});

test("pairing expires by server time and owner device limits are enforced", async () => {
  await withStore(async ({ store }) => {
    let clock = 1000;
    const registry = createDeviceRegistry({
      store,
      now: () => clock,
      maxActiveDevicesPerOwner: 1,
      ownerProofKey,
    });
    const expired = registry.startPairing(startRequest());
    clock += 5 * 60_000;
    assert.equal(
      registry.pairingStatus(
        retrievalRequest("device.pair.status", expired, uuid("40")),
      ).status,
      "expired",
    );
    const expiredApprovalRequest = await approveRequest(expired, {
      requestId: uuid("41"),
      nowMs: clock,
    });
    await assert.rejects(
      () => registry.approvePairing(expiredApprovalRequest),
      /pairing_expired/u,
    );

    const first = registry.startPairing(
      startRequest({
        requestId: uuid("42"),
        idempotencyKey: uuid("43"),
        deviceId: uuid("44"),
      }),
    );
    const firstApprovalRequest = await approveRequest(first, {
      requestId: uuid("45"),
      nowMs: clock,
    });
    assert.equal(
      (await registry.approvePairing(firstApprovalRequest)).status,
      "approved",
    );
    const second = registry.startPairing(
      startRequest({
        requestId: uuid("46"),
        idempotencyKey: uuid("47"),
        deviceId: uuid("48"),
      }),
    );
    const secondApprovalRequest = await approveRequest(second, {
      requestId: uuid("49"),
      nowMs: clock,
    });
    await assert.rejects(
      () => registry.approvePairing(secondApprovalRequest),
      /device_limit_reached/u,
    );
    assert.equal(
      registry.pairingStatus(
        retrievalRequest("device.pair.status", second, uuid("50")),
      ).status,
      "pending",
    );
  });
});

test("concurrent approval retries converge and cancel wins against an unverified approval", async () => {
  await withStore(async ({ store }) => {
    const registry = createDeviceRegistry({
      store,
      now: () => 1000,
      ownerProofKey,
    });
    const pairing = registry.startPairing(startRequest());
    const [first, second] = await Promise.all([
      approveRequest(pairing, { requestId: uuid("61") }),
      approveRequest(pairing, { requestId: uuid("62") }),
    ]);
    const approvals = await Promise.all([
      registry.approvePairing(first),
      registry.approvePairing(second),
    ]);
    assert.deepEqual(approvals.map(({ status }) => status).sort(), [
      "already_approved",
      "approved",
    ]);
    assert.equal(
      registry.cancelPairing(
        retrievalRequest("device.pair.cancel", pairing, uuid("63")),
      ).status,
      "already_approved",
    );

    const cancelledPairing = registry.startPairing(
      startRequest({
        requestId: uuid("64"),
        idempotencyKey: uuid("65"),
        deviceId: uuid("66"),
      }),
    );
    const lateApproval = registry.approvePairing(
      await approveRequest(cancelledPairing, { requestId: uuid("67") }),
    );
    assert.equal(
      registry.cancelPairing(
        retrievalRequest("device.pair.cancel", cancelledPairing, uuid("68")),
      ).status,
      "cancelled",
    );
    await assert.rejects(lateApproval, /pairing_expired/u);
  });
});

test("route selection requires a verified game binding, owned active device, and current epoch", async () => {
  await withStore(async ({ store }) => {
    const registry = createDeviceRegistry({
      store,
      now: () => 1000,
      ownerProofKey,
    });
    const request = startRequest();
    const pairing = registry.startPairing(request);
    await registry.approvePairing(await approveRequest(pairing));

    const unboundRouteRequest = await selectRouteRequest();
    await assert.rejects(
      () => registry.selectRoute(unboundRouteRequest),
      /game_account_binding_required/u,
    );

    store.bindVerifiedGameAccount("54321", 17, 1000);
    const defaultRoute = await registry.listOwnedDevices(await listRequest());
    assert.deepEqual(defaultRoute.routePolicy, {
      policy: "direct",
      activeDeviceId: null,
      routeEpoch: 0,
    });
    const selected = await registry.selectRoute(await selectRouteRequest());
    assert.equal(selected.status, "selected");
    assert.equal(selected.policy, "bridge_required");
    assert.equal(selected.routeEpoch, 1);

    const listed = await registry.listOwnedDevices(await listRequest());
    assert.deepEqual(listed.routePolicy, {
      policy: "bridge_required",
      activeDeviceId: request.deviceId,
      routeEpoch: 1,
    });

    const staleRequest = await selectRouteRequest({
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 0,
      requestId: uuid("14"),
    });
    await assert.rejects(
      () => registry.selectRoute(staleRequest),
      /route_epoch_conflict/u,
    );

    await registry.revokeDevice(
      await revokeRequest(request.deviceId, { nowMs: 1000 }),
    );
    const revokedDeviceRequest = await selectRouteRequest({
      expectedRouteEpoch: 1,
      requestId: uuid("15"),
    });
    await assert.rejects(
      () => registry.selectRoute(revokedDeviceRequest),
      /device_not_found/u,
    );

    const reset = await registry.selectRoute(
      await selectRouteRequest({
        policy: "direct",
        activeDeviceId: null,
        expectedRouteEpoch: 1,
        requestId: uuid("16"),
      }),
    );
    assert.equal(reset.policy, "direct");
    assert.equal(reset.routeEpoch, 2);
  });
});

test("game account binding stores only a fresh identity-matched ID and is permanent", async () => {
  await withStore(async ({ directory, store }) => {
    const restoreConfirmations = [];
    const registry = createDeviceRegistry({
      store,
      now: () => 1000,
      ownerProofKey,
      onGameAccountBound: async (binding) => {
        restoreConfirmations.push(binding);
      },
      verifyGameAccount: async (authorization) => {
        if (authorization === "Bearer second.valid.token")
          return { telegramId: "54322", playerId: 17 };
        return { telegramId: "54321", playerId: 17 };
      },
    });
    const bindRequest = async (
      subject,
      authorization,
      requestId,
      nowMs = 1000,
    ) => ({
      operation: "game_account.bind",
      requestId,
      ownerProof: await ownerProof("game_account.bind", {
        subject,
        nowMs,
      }),
      authorization,
    });

    const wrongGameOwnerRequest = await bindRequest(
      "54323",
      "Bearer first.valid.token",
      uuid("20"),
    );
    await assert.rejects(
      () => registry.bindGameAccount(wrongGameOwnerRequest),
      /game_account_mismatch/u,
    );

    const first = await registry.bindGameAccount(
      await bindRequest("54321", "Bearer first.valid.token", uuid("17")),
    );
    assert.equal(first.status, "bound");
    assert.equal(Object.hasOwn(first, "playerId"), false);
    assert.deepEqual(store.readGameAccountBinding("54321"), {
      schemaVersion: 1,
      ownerId: "54321",
      playerId: "17",
      verifiedAt: 1000,
    });
    assert.deepEqual(restoreConfirmations, [
      {
        ownerId: "54321",
        playerId: "17",
        authorization: "Bearer first.valid.token",
        verifiedAt: 1000,
      },
    ]);

    const replay = await registry.bindGameAccount(
      await bindRequest("54321", "Bearer first.valid.token", uuid("18")),
    );
    assert.equal(replay.status, "already_bound");

    const duplicateAccountRequest = await bindRequest(
      "54322",
      "Bearer second.valid.token",
      uuid("19"),
    );
    await assert.rejects(
      () => registry.bindGameAccount(duplicateAccountRequest),
      /game_account_already_bound/u,
    );

    for (const file of readdirSync(directory).filter((name) =>
      [
        "automation.sqlite",
        "automation.sqlite-wal",
        "automation.sqlite-shm",
      ].includes(name),
    )) {
      const bytes = readFileSync(join(directory, file));
      assert.equal(bytes.includes(Buffer.from("first.valid.token")), false);
      assert.equal(bytes.includes(Buffer.from("second.valid.token")), false);
    }
  });
});

test("device session proof issues a short-lived route-bound credential once", async () => {
  await withStore(async ({ store }) => {
    let nowMs = 1000;
    const fixture = await createRoutedSessionFixture({
      store,
      now: () => nowMs,
    });
    const challenge = fixture.registry.issueDeviceSessionChallenge({
      operation: "device.session.challenge",
      requestId: uuid("302"),
      deviceId: fixture.deviceId,
    });
    assert.equal(challenge.routeEpoch, 1);
    assert.equal(challenge.deviceGeneration, 1);
    const proof = {
      operation: "device.session.prove",
      requestId: uuid("303"),
      deviceId: fixture.deviceId,
      challengeId: challenge.challengeId,
      signature: signSessionChallenge(challenge, fixture.keyPair.privateKey),
    };
    const routeMissingRegistry = createDeviceRegistry({
      store,
      now: () => nowMs,
      ownerProofKey,
      sessionSigningKey: fixture.sessionSigningKey,
    });
    assert.throws(
      () =>
        routeMissingRegistry.issueDeviceSessionChallenge({
          operation: "device.session.challenge",
          requestId: uuid("304"),
          deviceId: fixture.deviceId,
        }),
      /device_route_unavailable/u,
    );
    await assert.rejects(
      () =>
        fixture.registry.proveDeviceSession({
          ...proof,
          signature: Buffer.alloc(64, 3).toString("base64url"),
        }),
      /device_proof_invalid/u,
    );
    const issued = await fixture.registry.proveDeviceSession(proof);
    const claims = await verifyDeviceSessionCredential(
      issued.sessionCredential,
      fixture.sessionSigningKey,
      { nowMs: nowMs + 1 },
    );
    assert.deepEqual(claims, {
      protocolMajor: challenge.protocolMajor,
      protocolMinor: challenge.protocolMinor,
      purpose: "device-session",
      deviceId: fixture.deviceId,
      deviceGeneration: 1,
      connectionId: challenge.connectionId,
      routeEpoch: challenge.routeEpoch,
      issuedAtMs: nowMs,
      expiresAtMs: nowMs + 15 * 60_000,
      scopes: ["control", "data"],
    });
    assert.deepEqual(
      await fixture.registry.authorizeDeviceSession(issued.sessionCredential),
      {
        ownerId: "54321",
        deviceId: fixture.deviceId,
        deviceGeneration: 1,
        connectionId: challenge.connectionId,
        routeEpoch: 1,
        expiresAtMs: issued.expiresAtMs,
        scopes: ["control", "data"],
      },
    );
    nowMs = issued.expiresAtMs;
    await assert.rejects(
      () => fixture.registry.authorizeDeviceSession(issued.sessionCredential),
      /device_session_invalid/u,
    );
    nowMs = claims.issuedAtMs + 1;
    await assert.rejects(
      () => fixture.registry.proveDeviceSession(proof),
      /device_challenge_replayed/u,
    );

    for (let index = 0; index < 3; index += 1)
      fixture.registry.issueDeviceSessionChallenge({
        operation: "device.session.challenge",
        requestId: uuid(String(310 + index)),
        deviceId: fixture.deviceId,
      });
    assert.throws(
      () =>
        fixture.registry.issueDeviceSessionChallenge({
          operation: "device.session.challenge",
          requestId: uuid("320"),
          deviceId: fixture.deviceId,
        }),
      /device_challenge_limit/u,
    );
    store.selectRoutePolicy("17", {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 1,
      updatedAt: nowMs,
    });
    await assert.rejects(
      () => fixture.registry.authorizeDeviceSession(issued.sessionCredential),
      /device_route_inactive/u,
    );
  });
});

test("device session challenges survive restart and concurrent proofs consume once", async () => {
  await withStore(async ({ store, replace }) => {
    const now = () => 1000;
    const fixture = await createRoutedSessionFixture({ store, now });
    const challenge = fixture.registry.issueDeviceSessionChallenge({
      operation: "device.session.challenge",
      requestId: uuid("321"),
      deviceId: fixture.deviceId,
    });
    const proof = {
      operation: "device.session.prove",
      requestId: uuid("322"),
      deviceId: fixture.deviceId,
      challengeId: challenge.challengeId,
      signature: signSessionChallenge(challenge, fixture.keyPair.privateKey),
    };

    fixture.restart(replace());
    const results = await Promise.allSettled([
      fixture.registry.proveDeviceSession(proof),
      fixture.registry.proveDeviceSession({ ...proof, requestId: uuid("323") }),
    ]);
    assert.equal(
      results.filter(({ status }) => status === "fulfilled").length,
      1,
    );
    assert.equal(
      results.filter(({ status }) => status === "rejected").length,
      1,
    );
    const rejected = results.find(({ status }) => status === "rejected");
    assert.match(rejected.reason.message, /device_challenge_replayed/u);
  });
});

test("helper pause control is scoped to the verified owner and survives registry restart", async () => {
  await withStore(async ({ store, replace }) => {
    const fixture = await createRoutedSessionFixture({
      store,
      now: () => 1000,
    });
    assert.equal(fixture.registry.getHelperPaused("54321"), false);
    const paused = fixture.registry.setHelperPaused("54321", true);
    assert.equal(paused.paused, true);
    assert.equal(paused.generation, 1);
    assert.equal(fixture.registry.getHelperPaused("54321"), true);
    assert.equal(fixture.registry.getHelperPaused("65432"), false);

    fixture.restart(replace());
    assert.equal(fixture.registry.getHelperPaused("54321"), true);
    const resumed = fixture.registry.setHelperPaused("54321", false);
    assert.equal(resumed.paused, false);
    assert.equal(resumed.generation, 2);
    assert.equal(fixture.registry.getHelperPaused("54321"), false);
  });
});

test("device session proof fails after challenge expiry or route change", async () => {
  await withStore(async ({ store }) => {
    let nowMs = 1000;
    const fixture = await createRoutedSessionFixture({
      store,
      now: () => nowMs,
    });
    const expired = fixture.registry.issueDeviceSessionChallenge({
      operation: "device.session.challenge",
      requestId: uuid("331"),
      deviceId: fixture.deviceId,
    });
    const expiredProof = {
      operation: "device.session.prove",
      requestId: uuid("332"),
      deviceId: fixture.deviceId,
      challengeId: expired.challengeId,
      signature: signSessionChallenge(expired, fixture.keyPair.privateKey),
    };
    nowMs = expired.expiresAtMs;
    await assert.rejects(
      () => fixture.registry.proveDeviceSession(expiredProof),
      /device_challenge_expired/u,
    );

    nowMs += 1;
    const stale = fixture.registry.issueDeviceSessionChallenge({
      operation: "device.session.challenge",
      requestId: uuid("333"),
      deviceId: fixture.deviceId,
    });
    const staleProof = {
      operation: "device.session.prove",
      requestId: uuid("334"),
      deviceId: fixture.deviceId,
      challengeId: stale.challengeId,
      signature: signSessionChallenge(stale, fixture.keyPair.privateKey),
    };
    store.selectRoutePolicy("17", {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 1,
      updatedAt: nowMs,
    });
    await assert.rejects(
      () => fixture.registry.proveDeviceSession(staleProof),
      /device_route_inactive/u,
    );
  });
});

test("registry notifies the control gateway after committed route changes and revokes", async () => {
  await withStore(async ({ store }) => {
    const events = [];
    const fixture = await createRoutedSessionFixture({
      store,
      now: () => 1000,
      onDeviceRevoked: (deviceId, generation) =>
        events.push({ type: "revoked", deviceId, generation }),
      onRouteChanging: async (change) => {
        assert.equal(store.readRoutePolicy("17").routeEpoch, 1);
        events.push({ type: "pausing", ...change });
      },
      onRouteChanged: (change) => events.push({ type: "route", ...change }),
    });
    const route = await fixture.registry.selectRoute(
      await selectRouteRequest({
        policy: "direct",
        expectedRouteEpoch: 1,
        requestId: uuid("341"),
      }),
    );
    assert.equal(route.routeEpoch, 2);
    const revoked = await fixture.registry.revokeDevice(
      await revokeRequest(fixture.deviceId, {
        requestId: uuid("342"),
        expectedGeneration: 1,
      }),
    );
    assert.equal(revoked.status, "revoked");
    assert.deepEqual(
      events.map((event) => event.type),
      ["pausing", "route", "revoked"],
    );
    assert.equal(events[0].next.routeEpoch, 2);
    assert.equal(events[1].current.routeEpoch, 2);
    assert.equal(events[2].generation, 2);
  });
});

test("runtime admits a genuinely signed routed device session only behind the release gate", async () => {
  await withStore(async ({ directory, store }) => {
    const fixture = await createRoutedSessionFixture({ store, now: Date.now });
    const challenge = fixture.registry.issueDeviceSessionChallenge({
      operation: "device.session.challenge",
      requestId: uuid("801"),
      deviceId: fixture.deviceId,
    });
    const issued = await fixture.registry.proveDeviceSession({
      operation: "device.session.prove",
      requestId: uuid("802"),
      deviceId: fixture.deviceId,
      challengeId: challenge.challengeId,
      signature: signSessionChallenge(challenge, fixture.keyPair.privateKey),
    });
    const commit = "a".repeat(40);
    const env = {
      MADHOUSE_AUTOMATION_STATE_DIR: directory,
      MADHOUSE_AUTOMATION_GAME_ENABLED: "0",
      MADHOUSE_RELEASE_SHA: commit,
      MADHOUSE_BRIDGE_ROUTE_SELECTION_ENABLED: "1",
      MADHOUSE_MINIMUM_SAFE_RELEASE_SHA: commit,
      MADHOUSE_BRIDGE_R0_RELEASE_SHA: commit,
      MADHOUSE_HOST_CONFIG_VERSION: "1",
      MADHOUSE_BRIDGE_LEGACY_EGRESS_REVIEWED: "1",
      MADHOUSE_BRIDGE_STORAGE_CREDENTIAL_PATH_VERIFIED: "1",
      MADHOUSE_BRIDGE_OWNER_PROOF_KEY:
        Buffer.from(ownerProofKey).toString("base64url"),
      MADHOUSE_BRIDGE_SESSION_SIGNING_KEY: Buffer.from(
        fixture.sessionSigningKey,
      ).toString("base64url"),
    };
    let runtime;
    let server;
    try {
      runtime = await createAutomationRuntime({ env });
      server = createServer();
      server.on("upgrade", (request, socket, head) =>
        runtime
          .bridgeUpgradeHandler(request, socket, head)
          .catch(() => socket.destroy()),
      );
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const socket = new WebSocket(
        `ws://127.0.0.1:${server.address().port}/bridge/control`,
        { headers: { authorization: `Bearer ${issued.sessionCredential}` } },
      );
      await once(socket, "open");
      socket.send(
        JSON.stringify({
          type: "hello",
          protocolMajor: 1,
          protocolMinor: 0,
          clientVersion: "0.1.0",
          capabilities: ["cargo-byte-tunnel-v1"],
        }),
      );
      const [data] = await once(socket, "message");
      const response = JSON.parse(data.toString());
      assert.equal(response.type, "hello_ok");
      assert.equal(response.connectionId, challenge.connectionId);
      socket.close();
      await once(socket, "close");
      runtime.close();
      runtime = await createAutomationRuntime({
        env: { ...env, MADHOUSE_BRIDGE_ROUTE_SELECTION_ENABLED: "0" },
      });
      let rejection = "";
      await runtime.bridgeUpgradeHandler(
        {
          method: "GET",
          url: "/bridge/control",
          headers: { authorization: `Bearer ${issued.sessionCredential}` },
        },
        {
          end: (value) => {
            rejection = value;
          },
        },
        Buffer.alloc(0),
      );
      assert.match(rejection, /^HTTP\/1\.1 404 /u);
    } finally {
      runtime?.close();
      if (server) {
        server.close();
        await once(server, "close");
      }
    }
  });
});

test("durable device revocation closes its real gateway connection and rejects its signed session after restart", async () => {
  await withStore(async ({ store, replace }) => {
    const nowMs = 1000;
    let gateway;
    const fixture = await createRoutedSessionFixture({
      store,
      now: () => nowMs,
      onDeviceRevoked: (id, generation) => gateway.closeDevice(id, generation),
    });
    const challenge = fixture.registry.issueDeviceSessionChallenge({
      operation: "device.session.challenge",
      requestId: uuid("701"),
      deviceId: fixture.deviceId,
    });
    const issued = await fixture.registry.proveDeviceSession({
      operation: "device.session.prove",
      requestId: uuid("702"),
      deviceId: fixture.deviceId,
      challengeId: challenge.challengeId,
      signature: signSessionChallenge(challenge, fixture.keyPair.privateKey),
    });
    gateway = createBridgeControlGateway({
      registry: fixture.registry,
      sessionSigningKey: fixture.sessionSigningKey,
      enabled: true,
      wallNow: () => nowMs,
    });
    const server = createServer();
    server.on("upgrade", (request, socket, head) =>
      gateway
        .handleUpgrade(request, socket, head)
        .catch(() => socket.destroy()),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const socket = new WebSocket(
      `ws://127.0.0.1:${server.address().port}/bridge/control`,
      { headers: { authorization: `Bearer ${issued.sessionCredential}` } },
    );
    try {
      await once(socket, "open");
      assert.equal(gateway.activeConnectionCount, 1);
      const api = createBridgeHttp({
        registry: fixture.registry,
        botToken: testBotToken,
        ownerProofKey,
        now: () => nowMs,
      });
      const requestRevoke = (userId) =>
        api(
          new Request("https://madhouse-wiki.ru/api/bridge", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              origin: "https://madhouse-wiki.ru",
            },
            body: JSON.stringify({
              operation: "device.revoke",
              requestId: uuid(userId === "54321" ? "704" : "705"),
              deviceId: fixture.deviceId,
              expectedGeneration: 1,
              initData: signedOwnerInit(userId, nowMs),
            }),
          }),
          { clientIp: "198.51.100.10" },
        );
      assert.equal((await requestRevoke("54322")).status, 404);
      assert.equal(gateway.activeConnectionCount, 1);
      const closed = once(socket, "close");
      const result = await requestRevoke("54321");
      assert.equal(result.status, 200);
      assert.equal((await result.json()).status, "revoked");
      const [code] = await closed;
      assert.equal(code, 4003);
      fixture.restart(replace());
      await assert.rejects(() =>
        fixture.registry.authorizeDeviceSession(issued.sessionCredential),
      );
      assert.equal(
        (
          await fixture.registry.revokeDevice(
            await revokeRequest(fixture.deviceId, {
              nowMs,
              requestId: uuid("703"),
              expectedGeneration: 1,
            }),
          )
        ).status,
        "already_revoked",
      );
    } finally {
      gateway.close();
      socket.terminate();
      server.close();
      await once(server, "close");
    }
  });
});

test("route stays unchanged when the required automation pause fails", async () => {
  await withStore(async ({ store }) => {
    const fixture = await createRoutedSessionFixture({
      store,
      now: () => 1000,
      onRouteChanging: async () => {
        throw new Error("storage unavailable");
      },
    });
    const request = await selectRouteRequest({
      policy: "direct",
      expectedRouteEpoch: 1,
      requestId: uuid("343"),
    });
    await assert.rejects(
      () => fixture.registry.selectRoute(request),
      /route_selection_pause_failed/u,
    );
    assert.deepEqual(store.readRoutePolicy("17"), {
      schemaVersion: 1,
      playerId: "17",
      policy: "bridge_required",
      activeDeviceId: uuid("301"),
      routeEpoch: 1,
      updatedAt: 1000,
    });
  });
});
