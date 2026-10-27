import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";

async function withDirectory(run) {
  const directory = mkdtempSync(join(tmpdir(), "automation-state-test-"));
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("state persists across store restart using the persisted encryption key", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    await first.write(12345, {
      token: "private-token",
      nickname: "Secret Nick",
    });
    first.close();

    const second = createAutomationStateStore({ directory });
    assert.deepEqual(await second.read("12345"), {
      token: "private-token",
      nickname: "Secret Nick",
    });
    assert.deepEqual(await second.list(), [
      {
        playerId: "12345",
        value: { token: "private-token", nickname: "Secret Nick" },
      },
    ]);
    second.close();
  });
});

test("helper pause intent is encrypted, owner scoped, and survives restart until resume", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    first.bindVerifiedGameAccount("54321", "101", 100);
    assert.equal(first.isGameHelperPaused("101"), false);
    const initial = first.withBridgeTransaction((bridge) =>
      bridge.readHelperControl("54321"),
    );
    assert.deepEqual(initial, {
      schemaVersion: 1,
      ownerId: "54321",
      paused: false,
      generation: 0,
      updatedAtMs: null,
    });
    const paused = first.withBridgeTransaction((bridge) =>
      bridge.setHelperPaused("54321", true, 200),
    );
    assert.equal(paused.paused, true);
    assert.equal(paused.generation, 1);
    assert.equal(first.isGameHelperPaused("101"), true);
    assert.equal(
      first.withBridgeTransaction(
        (bridge) => bridge.readHelperControl("65432").paused,
      ),
      false,
    );
    first.close();

    const second = createAutomationStateStore({ directory });
    assert.equal(second.isGameHelperPaused("101"), true);
    const repeatedPause = second.withBridgeTransaction((bridge) =>
      bridge.setHelperPaused("54321", true, 300),
    );
    assert.deepEqual(repeatedPause, paused);
    const resumed = second.withBridgeTransaction((bridge) =>
      bridge.setHelperPaused("54321", false, 400),
    );
    assert.equal(resumed.paused, false);
    assert.equal(resumed.generation, 2);
    assert.equal(second.isGameHelperPaused("101"), false);
    second.close();
  });
});

test("command admission signatures survive restart and reject tampered tickets", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    const payload = {
      version: 1,
      id: "00000000-0000-4000-8000-000000000001",
      command: "attack",
      argumentsDigest: "a".repeat(64),
      intentVersion: 9,
      routeEpoch: 3,
      issuedAt: 1000,
      expiresAt: 31_000,
    };
    const ticket = first.signCommandAdmissionTicket(payload);
    const ownerRef = first.commandAdmissionOwnerRef("7654321");
    assert.deepEqual(first.verifyCommandAdmissionTicket(ticket), payload);
    assert.notEqual(ownerRef, "7654321");
    assert.equal(
      first.verifyCommandAdmissionTicket(`A${ticket.slice(1)}`),
      null,
    );
    assert.equal(first.verifyCommandAdmissionTicket(`${ticket}x`), null);
    assert.equal(first.verifyCommandAdmissionTicket(`${ticket}.extra`), null);
    first.close();

    const second = createAutomationStateStore({ directory });
    assert.deepEqual(second.verifyCommandAdmissionTicket(ticket), payload);
    assert.equal(second.commandAdmissionOwnerRef("7654321"), ownerRef);
    assert.notEqual(
      second.commandAdmissionPlayerRef("101"),
      second.commandAdmissionPlayerRef("102"),
    );
    second.close();
  });
});

test("restore consent is owner scoped, durable, explicit and invalidated by a new restore", async () => {
  await withDirectory(async (directory) => {
    let store = createAutomationStateStore({ directory });
    const consent = {
      ownerId: "54321",
      requestId: "00000000-0000-4000-8000-000000000111",
      routePolicy: "direct",
      confirmedAt: 201,
      identityIssuedAt: 200,
      challenge: Buffer.alloc(32).toString("base64url"),
    };
    assert.throws(() => store.recordRestoreOwnerConsent(consent), /stale/u);
    store.activateRestoreGuard({ activatedAt: 200 });
    consent.challenge = store.issueRestoreOwnerChallenge({
      ownerId: consent.ownerId,
      issuedAt: 200,
      identityIssuedAt: 200,
    }).challenge;
    assert.throws(
      () =>
        store.recordRestoreOwnerConsent({
          ...consent,
          routePolicy: "bridge_required",
        }),
      /invalid/u,
    );
    assert.throws(
      () =>
        store.recordRestoreOwnerConsent({
          ...consent,
          confirmedAt: 199,
          identityIssuedAt: 199,
        }),
      /stale/u,
    );
    assert.throws(
      () => store.recordRestoreOwnerConsent({ ...consent, ownerId: "54322" }),
      /challenge_missing/u,
    );
    assert.throws(
      () =>
        store.recordRestoreOwnerConsent({
          ...consent,
          challenge: Buffer.alloc(32, 1).toString("base64url"),
        }),
      /challenge_invalid/u,
    );
    assert.throws(
      () =>
        store.recordRestoreOwnerConsent({ ...consent, confirmedAt: 120200 }),
      /challenge_invalid/u,
    );
    store.recordRestoreOwnerConsent(consent);
    assert.throws(
      () => store.recordRestoreOwnerConsent(consent),
      /challenge_missing/u,
    );
    const journal = {
      schemaVersion: 1,
      ownerId: consent.ownerId,
      requestId: consent.requestId,
      operationId: "00000000-0000-4000-8000-000000000112",
      authGeneration: 5,
      consentGeneration: 6,
      routeEpoch: 1,
      launchDataDigest: "a".repeat(64),
      state: "prepared",
      expectedCredentialVersion: 4,
      credentialVersion: null,
      playerId: null,
      createdAt: 202,
      updatedAt: 202,
    };
    assert.throws(
      () =>
        store.startRestoreGameAuthBootstrap({
          ...journal,
          requestId: "00000000-0000-4000-8000-000000000113",
        }),
      /consent_required/u,
    );
    assert.deepEqual(store.startRestoreGameAuthBootstrap(journal), journal);
    assert.deepEqual(store.startRestoreGameAuthBootstrap(journal), journal);
    assert.throws(
      () =>
        store.startRestoreGameAuthBootstrap({
          ...journal,
          operationId: "00000000-0000-4000-8000-000000000113",
        }),
      /bootstrap_pending/u,
    );
    assert.equal(store.readRestoreOwnerConsent("54322"), null);
    assert.equal(store.isRestoreRequired("101"), true);
    store.close();
    store = createAutomationStateStore({ directory });
    assert.deepEqual(store.readGameAuthBootstrap(consent.ownerId), journal);
    assert.deepEqual(store.readRestoreOwnerConsent("54321"), {
      schemaVersion: 1,
      ownerId: consent.ownerId,
      requestId: consent.requestId,
      routePolicy: consent.routePolicy,
      confirmedAt: consent.confirmedAt,
      identityIssuedAt: consent.identityIssuedAt,
      restoreActivatedAt: 200,
    });
    store.armRestoreGuardForMarker({ createdAt: 300 });
    assert.equal(store.readRestoreOwnerConsent("54321"), null);
    assert.equal(store.readGameAuthBootstrap(consent.ownerId), null);
    assert.equal(store.isRestoreRequired("101"), true);
    store.close();
  });
});

test("restored state revokes routes and devices until a fresh owner binding confirms it", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    const deviceId = "00000000-0000-4000-8000-000000000001";
    assert.deepEqual(store.readRestoreOwnerStatus("54321"), {
      status: "not_required",
    });
    store.bindVerifiedGameAccount("54321", "101", 100);
    store.selectRoutePolicy("101", {
      policy: "bridge_required",
      activeDeviceId: deviceId,
      expectedRouteEpoch: 0,
      updatedAt: 101,
    });
    store.write("101", {
      credential: "Bearer saved.token.signature",
      battle: { pending: { kind: "attack" }, needsRefresh: true },
      assistant: { pending: { kind: "attack" } },
      auto: { enabled: true, phase: "attacking" },
    });

    assert.equal(store.activateRestoreGuard({ activatedAt: 200 }), true);
    assert.equal(store.activateRestoreGuard({ activatedAt: 201 }), false);
    assert.equal(store.isRestoreGuardActive(), true);
    assert.deepEqual(store.readRestoreOwnerStatus("54321"), {
      status: "reauthorization_required",
    });
    assert.equal(store.isRestoreRequired("101"), true);
    assert.equal(store.readGameAccountOwner("101"), null);
    assert.deepEqual(store.readRoutePolicy("101"), {
      schemaVersion: 1,
      playerId: "101",
      policy: "direct",
      activeDeviceId: null,
      routeEpoch: 0,
      updatedAt: null,
    });

    store.bindVerifiedGameAccount("54321", "101", 300);
    assert.throws(
      () =>
        store.confirmRestoredAccount({
          ownerId: "54322",
          playerId: "101",
          verifiedAt: 301,
        }),
      /automation_owner_binding_mismatch/u,
    );
    store.confirmRestoredAccount({
      ownerId: "54321",
      playerId: "101",
      verifiedAt: 302,
    });
    assert.equal(store.isRestoreAccountReauthorized("101"), true);
    assert.equal(store.isRestoreRequired("101"), true);
    assert.deepEqual(store.readRestoreOwnerStatus("54321"), {
      status: "reconciliation_required",
    });

    store.write("101", {
      credential: "Bearer fresh.token.signature",
      battle: { pending: null, needsRefresh: false },
      assistant: { pending: null },
      auto: { enabled: false, phase: "stopped" },
    });
    assert.equal(store.isRestoreRequired("101"), true);
    const selected = store.selectRoutePolicy("101", {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 0,
      updatedAt: 303,
    });
    assert.equal(selected.routeEpoch, 1);
    assert.equal(store.isRestoreRequired("101"), false);
    assert.deepEqual(store.readRestoreOwnerStatus("54321"), {
      status: "ready",
    });
    assert.equal(store.isRestoreRequired("202"), true);
    store.close();

    const reopened = createAutomationStateStore({ directory });
    assert.equal(reopened.isRestoreGuardActive(), true);
    assert.equal(reopened.isRestoreAccountReauthorized("101"), true);
    assert.equal(reopened.isRestoreRequired("101"), false);
    assert.equal(reopened.armRestoreGuardForMarker({ createdAt: 400 }), true);
    assert.equal(reopened.isRestoreRequired("101"), true);
    assert.equal(reopened.armRestoreGuardForMarker({ createdAt: 400 }), false);
    reopened.close();
  });
});

test("restore guard retains every supported unresolved action checkpoint", async () => {
  await withDirectory(async (directory) => {
    let store = createAutomationStateStore({ directory });
    store.activateRestoreGuard({ activatedAt: 100 });
    store.bindVerifiedGameAccount("54321", "101", 101);
    store.confirmRestoredAccount({
      ownerId: "54321",
      playerId: "101",
      verifiedAt: 102,
    });
    store.selectRoutePolicy("101", {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 0,
      updatedAt: 103,
    });
    const checkpoints = [
      { characterUpgrade: { pending: { operationId: "fixture" } } },
      { buddyHelp: { pending: { operationId: "fixture" } } },
      { buddyHelp: { stashPending: { operationId: "fixture" } } },
      { friendRemoval: { pending: { playerId: 2 } } },
      { raidFriend: { pending: { playerId: 2 } } },
      { pvp: { pending: true } },
      {
        floorRunner: {
          status: "stopped",
          phase: "launching",
          target: { kind: "work" },
        },
      },
      { workFarm: { manualPending: { operationId: "fixture" } } },
      {
        businessHelper: { run: { pendingUpgrade: { operationId: "fixture" } } },
      },
    ];
    for (const checkpoint of checkpoints) {
      store.write("101", checkpoint);
      assert.equal(
        store.isRestoreRequired("101"),
        true,
        JSON.stringify(checkpoint),
      );
      store.close();
      store = createAutomationStateStore({ directory });
      assert.equal(
        store.isRestoreRequired("101"),
        true,
        JSON.stringify(checkpoint),
      );
    }
    store.write("101", {
      characterUpgrade: { pending: null },
      pvp: { pending: false },
    });
    assert.equal(store.isRestoreRequired("101"), false);
    store.close();
  });
});

test("route policy is encrypted, compare-and-swapped, and durable", async () => {
  await withDirectory(async (directory) => {
    const deviceId = "00000000-0000-4000-8000-000000000001";
    const first = createAutomationStateStore({ directory });
    assert.deepEqual(first.readRoutePolicy(123), {
      schemaVersion: 1,
      playerId: "123",
      policy: "direct",
      activeDeviceId: null,
      routeEpoch: 0,
      updatedAt: null,
    });
    const selected = first.selectRoutePolicy(123, {
      policy: "bridge_required",
      activeDeviceId: deviceId,
      expectedRouteEpoch: 0,
      updatedAt: 100,
    });
    assert.deepEqual(selected, {
      schemaVersion: 1,
      playerId: "123",
      policy: "bridge_required",
      activeDeviceId: deviceId,
      routeEpoch: 1,
      updatedAt: 100,
    });
    assert.throws(
      () =>
        first.selectRoutePolicy(123, {
          policy: "direct",
          activeDeviceId: null,
          expectedRouteEpoch: 0,
          updatedAt: 101,
        }),
      /route_epoch_conflict/u,
    );
    assert.throws(
      () =>
        first.selectRoutePolicy(123, {
          policy: "bridge_required",
          activeDeviceId: null,
          expectedRouteEpoch: 1,
          updatedAt: 101,
        }),
      /route_selection_invalid/u,
    );
    first.close();

    const second = createAutomationStateStore({ directory });
    assert.equal(second.readRoutePolicy(123).routeEpoch, 1);
    const direct = second.selectRoutePolicy(123, {
      policy: "direct",
      activeDeviceId: null,
      expectedRouteEpoch: 1,
      updatedAt: 102,
    });
    assert.equal(direct.policy, "direct");
    assert.equal(direct.routeEpoch, 2);
    second.close();
    for (const name of readdirSync(directory).filter((entry) =>
      [
        "automation.sqlite",
        "automation.sqlite-wal",
        "automation.sqlite-shm",
      ].includes(entry),
    )) {
      const bytes = readFileSync(join(directory, name));
      assert.equal(bytes.includes(Buffer.from("bridge_required")), false);
      assert.equal(bytes.includes(Buffer.from(deviceId)), false);
    }
  });
});

test("verified Wiki owner and game account binding is one-to-one and durable", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    const binding = first.bindVerifiedGameAccount("54321", "98765", 100);
    assert.deepEqual(binding, {
      schemaVersion: 1,
      ownerId: "54321",
      playerId: "98765",
      verifiedAt: 100,
    });
    assert.deepEqual(first.bindVerifiedGameAccount(54321, 98765, 200), binding);
    assert.deepEqual(first.readGameAccountBinding("54321"), binding);
    assert.deepEqual(first.readGameAccountOwner(98765), binding);
    assert.throws(
      () => first.bindVerifiedGameAccount("54321", "98766", 300),
      /owner_binding_conflict/u,
    );
    assert.throws(
      () => first.bindVerifiedGameAccount("54322", "98765", 300),
      /game_account_already_bound/u,
    );
    assert.throws(
      () => first.bindVerifiedGameAccount("054321", "98767", 300),
      /invalid_owner_id/u,
    );
    first.close();

    for (const name of readdirSync(directory).filter((entry) =>
      [
        "automation.sqlite",
        "automation.sqlite-wal",
        "automation.sqlite-shm",
      ].includes(entry),
    )) {
      const bytes = readFileSync(join(directory, name));
      assert.equal(bytes.includes(Buffer.from("54321")), false);
      assert.equal(bytes.includes(Buffer.from("98765")), false);
    }

    const restored = createAutomationStateStore({ directory });
    assert.deepEqual(restored.readGameAccountBinding(54321), binding);
    assert.deepEqual(restored.readGameAccountOwner("98765"), binding);
    assert.equal(restored.readGameAccountBinding("54322"), null);
    restored.close();
  });
});

test("records are encrypted at rest and account ciphertext cannot be moved", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    await store.write(111, {
      token: "opaque-secret-token",
      nickname: "Private Name",
    });
    await store.write(222, { token: "other-token" });
    assert.equal(await store.read(333), null);
    store.close();

    const files = readdirSync(directory).filter((name) =>
      [
        "automation.sqlite",
        "automation.sqlite-wal",
        "automation.sqlite-shm",
      ].includes(name),
    );
    for (const file of files) {
      const bytes = readFileSync(join(directory, file));
      assert.equal(bytes.includes(Buffer.from("opaque-secret-token")), false);
      assert.equal(bytes.includes(Buffer.from("Private Name")), false);
    }

    const db = new DatabaseSync(join(directory, "automation.sqlite"));
    const rows = db
      .prepare("SELECT account_key, record FROM accounts ORDER BY account_key")
      .all();
    assert.equal(rows.length, 2);
    assert.match(rows[0].account_key, /^[a-f0-9]{64}$/u);
    const accountKey = (playerId) =>
      createHmac("sha256", readFileSync(join(directory, "encryption.key")))
        .update("automation-account:")
        .update(String(playerId))
        .digest("hex");
    const source = rows.find((row) => row.account_key === accountKey(111));
    const destination = rows.find((row) => row.account_key === accountKey(222));
    db.prepare("UPDATE accounts SET record = ? WHERE account_key = ?").run(
      source.record,
      destination.account_key,
    );
    db.close();

    const isolated = createAutomationStateStore({ directory });
    assert.throws(() => isolated.read(222), /authentication_failed/u);
    isolated.close();
  });
});

test("tampered ciphertext fails closed", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    await store.write(9001, { token: "secret" });
    store.close();

    const db = new DatabaseSync(join(directory, "automation.sqlite"));
    const row = db.prepare("SELECT account_key, record FROM accounts").get();
    const envelope = JSON.parse(row.record);
    envelope.data =
      (envelope.data[0] === "A" ? "B" : "A") + envelope.data.slice(1);
    db.prepare("UPDATE accounts SET record = ? WHERE account_key = ?").run(
      JSON.stringify(envelope),
      row.account_key,
    );
    db.close();

    const restored = createAutomationStateStore({ directory });
    assert.throws(() => restored.read(9001), /authentication_failed/u);
    assert.throws(() => restored.list(), /authentication_failed/u);
    restored.close();
  });
});

test("key, database, and state directory have restrictive permissions", async () => {
  await withDirectory(async (parent) => {
    const directory = join(parent, "state");
    const store = createAutomationStateStore({ directory });
    await store.write(42, { value: true });
    store.close();
    assert.equal(lstatSync(directory).mode & 0o777, 0o700);
    assert.equal(
      lstatSync(join(directory, "encryption.key")).mode & 0o777,
      0o600,
    );
    assert.equal(
      lstatSync(join(directory, "automation.sqlite")).mode & 0o777,
      0o600,
    );
  });
});

test("unsafe key symlinks and permissive existing key modes are rejected", () => {
  withDirectory((directory) => {
    const target = join(directory, "target.key");
    writeFileSync(target, Buffer.alloc(32));
    symlinkSync(target, join(directory, "encryption.key"));
    assert.throws(
      () => createAutomationStateStore({ directory }),
      /encryption_key_invalid/u,
    );
  });
  withDirectory((directory) => {
    writeFileSync(join(directory, "encryption.key"), Buffer.alloc(32), {
      mode: 0o644,
    });
    chmodSync(join(directory, "encryption.key"), 0o644);
    assert.throws(
      () => createAutomationStateStore({ directory }),
      /key_permissions_invalid/u,
    );
  });
});

test("player IDs and serialized record size are bounded", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    for (const playerId of [0, -1, 1.2, "0", "-1", "01", "9007199254740992"]) {
      assert.throws(() => store.read(playerId), /invalid_player_id/u);
    }
    assert.throws(
      () => store.write(1, { data: "x".repeat(4 * 1024 * 1024) }),
      /record_too_large/u,
    );
    store.close();
  });
});

test("versioned actor writes reject a stale snapshot atomically", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    const second = createAutomationStateStore({ directory });
    try {
      first.write(101, { version: 4, label: "before" });
      assert.equal(
        second.writeIfVersion(101, 4, { version: 5, label: "new actor" }),
        true,
      );
      assert.equal(
        first.writeIfVersion(101, 4, { version: 5, label: "late actor" }),
        false,
      );
      assert.deepEqual(first.read(101), {
        version: 5,
        label: "new actor",
      });
      assert.throws(
        () => first.writeIfVersion(101, 5, { version: 7, label: "skip" }),
        /state_version_invalid/u,
      );
    } finally {
      first.close();
      second.close();
    }
  });
});

test("worker lease prevents overlap and rejects stale owner release or renewal", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    const second = createAutomationStateStore({ directory });
    assert.equal(first.acquireLease("worker-a", 1_000, 15_000), true);
    assert.equal(second.acquireLease("worker-b", 5_000, 15_000), false);
    assert.equal(first.acquireLease("worker-a", 5_000, 15_000), true);

    assert.equal(second.acquireLease("worker-b", 20_000, 15_000), true);
    assert.equal(first.acquireLease("worker-a", 20_001, 15_000), false);
    assert.equal(first.releaseLease("worker-a"), false);
    assert.equal(second.acquireLease("worker-b", 21_000, 15_000), true);
    assert.equal(second.releaseLease("worker-b"), true);
    assert.equal(first.releaseLease("worker-a"), false);
    first.close();
    second.close();
  });
});

test("long-running series history remains durable above the old single-battle record bound", () => {
  withDirectory((directory) => {
    const store = createAutomationStateStore({ directory });
    const history = Array.from({ length: 15000 }, (_, index) => [
      `battle-${index}`,
      "won",
    ]);
    const record = {
      goalRecord: { results: history, attempts: history.map(([id]) => id) },
    };
    assert.ok(Buffer.byteLength(JSON.stringify(record)) > 256 * 1024);
    try {
      store.write(1, record);
      assert.equal(store.read(1).goalRecord.results.length, 15000);
    } finally {
      store.close();
    }
  });
});

test("game auth recovery is encrypted, operation-bound, and blocks unknown outcomes", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    const initial = {
      schemaVersion: 1,
      ownerId: "7654321",
      playerId: "987654321",
      operationId: "00000000-0000-4000-8000-000000000123",
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 5,
      state: "created",
      expectedCredentialVersion: 7,
      credentialVersion: null,
      updatedAt: 1_798_000_000_000,
    };

    assert.deepEqual(first.startGameAuthRecovery(initial), initial);
    const launchRequested = {
      ...initial,
      state: "launch_requested",
      updatedAt: initial.updatedAt + 1,
    };
    first.updateGameAuthRecovery(
      initial.ownerId,
      initial.operationId,
      launchRequested,
    );
    const unknown = {
      ...launchRequested,
      state: "auth_outcome_unknown",
      reason: "unknown_outcome",
      updatedAt: launchRequested.updatedAt + 1,
    };
    first.updateGameAuthRecovery(initial.ownerId, initial.operationId, unknown);
    assert.throws(
      () =>
        first.startGameAuthRecovery({
          ...initial,
          operationId: "00000000-0000-4000-8000-000000000124",
          authGeneration: 2,
          consentGeneration: 5,
          expectedCredentialVersion: 7,
          updatedAt: unknown.updatedAt + 1,
        }),
      /automation_game_auth_operation_pending/u,
    );
    first.close();

    const rawDatabase = readFileSync(join(directory, "automation.sqlite"));
    assert.equal(rawDatabase.includes(Buffer.from("7654321")), false);
    assert.equal(rawDatabase.includes(Buffer.from("987654321")), false);
    assert.equal(rawDatabase.includes(Buffer.from("unknown_outcome")), false);

    const restored = createAutomationStateStore({ directory });
    assert.deepEqual(restored.readGameAuthRecovery(initial.ownerId), unknown);
    assert.deepEqual(restored.listGameAuthRecoveries(), [unknown]);
    const failed = {
      ...unknown,
      state: "failed",
      updatedAt: unknown.updatedAt + 1,
    };
    restored.updateGameAuthRecovery(
      initial.ownerId,
      initial.operationId,
      failed,
    );
    const next = {
      ...initial,
      operationId: "00000000-0000-4000-8000-000000000124",
      authGeneration: 2,
      consentGeneration: 5,
      updatedAt: failed.updatedAt + 1,
    };
    assert.throws(
      () =>
        restored.startGameAuthRecovery({
          ...next,
          consentGeneration: failed.consentGeneration,
        }),
      /automation_game_auth_generation_conflict/u,
    );
    assert.deepEqual(restored.startGameAuthRecovery(next), next);
    assert.throws(
      () =>
        restored.updateGameAuthRecovery(
          initial.ownerId,
          initial.operationId,
          failed,
        ),
      /automation_game_auth_operation_stale/u,
    );
    restored.close();
  });
});

test("game auth recovery rejects credentials or mutable operation identity", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    const record = {
      schemaVersion: 1,
      ownerId: "7654321",
      playerId: "987654321",
      operationId: "00000000-0000-4000-8000-000000000123",
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 5,
      state: "created",
      expectedCredentialVersion: 0,
      credentialVersion: null,
      updatedAt: 1_798_000_000_000,
    };
    assert.throws(
      () =>
        store.startGameAuthRecovery({
          ...record,
          accessToken: "must-not-be-stored",
        }),
      /automation_game_auth_recovery_invalid/u,
    );
    store.startGameAuthRecovery(record);
    assert.throws(
      () =>
        store.updateGameAuthRecovery(record.ownerId, record.operationId, {
          ...record,
          playerId: "987654322",
          state: "launch_requested",
          updatedAt: record.updatedAt + 1,
        }),
      /automation_game_auth_transition_invalid/u,
    );
    store.close();
  });
});

test("initial game auth bootstrap is encrypted, owner-scoped, and stores no launch data", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    const prepared = {
      schemaVersion: 1,
      ownerId: "7654321",
      requestId: "00000000-0000-4000-8000-000000000201",
      operationId: "00000000-0000-4000-8000-000000000202",
      authGeneration: 1,
      consentGeneration: 1,
      routeEpoch: 0,
      launchDataDigest: "a".repeat(64),
      state: "prepared",
      expectedCredentialVersion: 0,
      credentialVersion: null,
      playerId: null,
      createdAt: 1_798_000_000_000,
      updatedAt: 1_798_000_000_000,
    };

    assert.deepEqual(
      first.startGameAuthBootstrap(prepared, { expectedCurrent: null }),
      prepared,
    );
    assert.equal(first.readGameAuthBootstrap("7654322"), null);
    assert.deepEqual(first.listGameAuthBootstraps(), [prepared]);

    let current = first.updateGameAuthBootstrap(
      prepared.ownerId,
      prepared.operationId,
      {
        ...prepared,
        state: "exchange_pending",
        updatedAt: prepared.updatedAt + 1,
      },
    );
    current = first.updateGameAuthBootstrap(
      prepared.ownerId,
      prepared.operationId,
      {
        ...current,
        state: "verification_pending",
        updatedAt: current.updatedAt + 1,
      },
    );
    current = first.updateGameAuthBootstrap(
      prepared.ownerId,
      prepared.operationId,
      {
        ...current,
        playerId: "987654321",
        credentialVersion: 1,
        state: "credential_stored",
        updatedAt: current.updatedAt + 1,
      },
    );
    const ready = first.updateGameAuthBootstrap(
      prepared.ownerId,
      prepared.operationId,
      {
        ...current,
        state: "ready",
        updatedAt: current.updatedAt + 1,
      },
    );
    first.close();

    const rawDatabase = readFileSync(join(directory, "automation.sqlite"));
    for (const marker of ["7654321", "987654321", "a".repeat(64)])
      assert.equal(rawDatabase.includes(Buffer.from(marker)), false);

    const restored = createAutomationStateStore({ directory });
    assert.deepEqual(restored.readGameAuthBootstrap(prepared.ownerId), ready);
    assert.deepEqual(restored.listGameAuthBootstraps(), [ready]);
    restored.close();
  });
});

test("unknown initial auth outcome requires a distinct launch and higher consent generation", async () => {
  await withDirectory(async (directory) => {
    const store = createAutomationStateStore({ directory });
    const prepared = {
      schemaVersion: 1,
      ownerId: "7654321",
      requestId: "00000000-0000-4000-8000-000000000211",
      operationId: "00000000-0000-4000-8000-000000000212",
      authGeneration: 1,
      consentGeneration: 1,
      routeEpoch: 0,
      launchDataDigest: "b".repeat(64),
      state: "prepared",
      expectedCredentialVersion: 0,
      credentialVersion: null,
      playerId: null,
      createdAt: 1_798_000_000_000,
      updatedAt: 1_798_000_000_000,
    };
    store.startGameAuthBootstrap(prepared);
    let unknown = store.updateGameAuthBootstrap(
      prepared.ownerId,
      prepared.operationId,
      {
        ...prepared,
        state: "exchange_pending",
        updatedAt: prepared.updatedAt + 1,
      },
    );
    unknown = store.updateGameAuthBootstrap(
      prepared.ownerId,
      prepared.operationId,
      {
        ...unknown,
        state: "auth_outcome_unknown",
        reason: "unknown_outcome",
        updatedAt: unknown.updatedAt + 1,
      },
    );
    assert.deepEqual(
      store.startGameAuthBootstrap({
        ...prepared,
        operationId: "00000000-0000-4000-8000-000000000213",
      }),
      unknown,
    );
    assert.throws(
      () =>
        store.startGameAuthBootstrap({
          ...prepared,
          requestId: "00000000-0000-4000-8000-000000000216",
          operationId: "00000000-0000-4000-8000-000000000217",
          authGeneration: 2,
          consentGeneration: 2,
          createdAt: unknown.updatedAt + 1,
          updatedAt: unknown.updatedAt + 1,
        }),
      /automation_game_auth_bootstrap_replay/u,
    );
    assert.throws(
      () =>
        store.updateGameAuthBootstrap(prepared.ownerId, prepared.operationId, {
          ...unknown,
          state: "exchange_pending",
          updatedAt: unknown.updatedAt + 1,
        }),
      /automation_game_auth_bootstrap_transition_invalid/u,
    );
    const retried = store.startGameAuthBootstrap({
      ...prepared,
      requestId: "00000000-0000-4000-8000-000000000218",
      operationId: "00000000-0000-4000-8000-000000000219",
      launchDataDigest: "c".repeat(64),
      authGeneration: 2,
      consentGeneration: 2,
      createdAt: unknown.updatedAt + 1,
      updatedAt: unknown.updatedAt + 1,
    });
    assert.equal(retried.state, "prepared");
    assert.equal(retried.authGeneration, 2);
    assert.equal(retried.consentGeneration, 2);
    assert.notEqual(retried.launchDataDigest, unknown.launchDataDigest);
    assert.throws(
      () =>
        store.startGameAuthBootstrap({
          ...prepared,
          launchDataDigest: "c".repeat(64),
        }),
      /automation_game_auth_bootstrap_pending/u,
    );
    assert.throws(
      () =>
        store.startGameAuthBootstrap({
          ...prepared,
          requestId: "00000000-0000-4000-8000-000000000216",
          operationId: "00000000-0000-4000-8000-000000000217",
          launchData: "private-telegram-launch-data",
        }),
      /automation_game_auth_bootstrap_invalid/u,
    );
    store.close();
  });
});

test("durable game logout advances authorization generations and blocks starts until the tombstone is recorded", async () => {
  await withDirectory(async (directory) => {
    const first = createAutomationStateStore({ directory });
    const ownerId = "7654321";
    const playerId = "987654321";
    const active = {
      schemaVersion: 1,
      ownerId,
      playerId,
      operationId: "00000000-0000-4000-8000-000000000123",
      authGeneration: 1,
      consentGeneration: 4,
      routeEpoch: 5,
      state: "created",
      expectedCredentialVersion: 7,
      credentialVersion: null,
      updatedAt: 1_798_000_000_000,
    };
    first.startGameAuthRecovery(active);
    const logout = {
      ...active,
      operationId: "00000000-0000-4000-8000-000000000124",
      authGeneration: 2,
      consentGeneration: 5,
      state: "logout_pending",
      updatedAt: active.updatedAt + 1,
    };
    first.beginGameAuthLogout(logout);
    assert.throws(
      () =>
        first.startGameAuthRecovery({
          ...active,
          operationId: "00000000-0000-4000-8000-000000000125",
          authGeneration: 3,
          consentGeneration: 6,
          updatedAt: logout.updatedAt + 1,
        }),
      /automation_game_auth_operation_pending/u,
    );
    const completed = {
      ...logout,
      state: "logged_out",
      credentialVersion: 8,
      updatedAt: logout.updatedAt + 1,
    };
    first.updateGameAuthRecovery(ownerId, logout.operationId, completed);
    first.close();

    const restored = createAutomationStateStore({ directory });
    assert.deepEqual(restored.readGameAuthRecovery(ownerId), completed);
    const freshConsent = {
      ...active,
      operationId: "00000000-0000-4000-8000-000000000125",
      authGeneration: 3,
      consentGeneration: 6,
      expectedCredentialVersion: 8,
      updatedAt: completed.updatedAt + 1,
    };
    assert.deepEqual(
      restored.startGameAuthRecovery(freshConsent),
      freshConsent,
    );
    restored.close();
  });
});
