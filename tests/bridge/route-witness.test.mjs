import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";

test("restoring an older bridge database cannot restore a direct route", async () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-witness-"));
  const directory = join(root, "state");
  const witnessDir = join(root, "witness");
  mkdirSync(witnessDir, { mode: 0o700 });
  const witnessPath = join(witnessDir, "routes.sqlite");
  let storage = createBridgeStorage({
    directory,
    witnessPath,
    provisionWitness: true,
  });
  try {
    storage.directRoutes.registerVerifiedDirect("42", "101");
    storage.close();
    copyFileSync(join(directory, "devices.sqlite"), join(root, "old.sqlite"));
    storage = createBridgeStorage({ directory, witnessPath });
    const device = storage.registry.redeemInvitation(
      storage.registry.issueInvitation("101").invitation,
    );
    storage.accounts.saveVerified({
      owner: "101",
      playerId: "42",
      authorization: "Bearer bridge",
      expectedRevision: 0,
      deviceId: device.deviceId,
      generation: 1,
    });
    storage.close();
    copyFileSync(join(root, "old.sqlite"), join(directory, "devices.sqlite"));
    storage = createBridgeStorage({ directory, witnessPath });
    assert.equal(
      storage.directRoutes.resolve({ playerId: "42", owner: "101" }),
      null,
    );
    assert.throws(
      () => storage.directRoutes.registerVerifiedDirect("42", "101"),
      { code: "bridge_route_required" },
    );
    assert.throws(
      () => storage.connectorLeases.acquire("101", "telegram_auth"),
      { code: "bridge_route_required" },
    );
    await assert.rejects(
      storage.directRoutes.withDirectLease(
        { playerId: "42", owner: "101" },
        1,
        () => assert.fail("must not send"),
      ),
      { code: "bridge_route_required" },
    );
    assert.throws(() => storage.directRoutes.registerVerifiedDirect("43"), {
      code: "bridge_route_required",
    });
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing witness and changed registry key fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-witness-"));
  const directory = join(root, "state");
  const witnessPath = join(root, "witness.sqlite");
  const store = createBridgeStorage({
    directory,
    witnessPath,
    provisionWitness: true,
  });
  store.close();
  try {
    assert.throws(() =>
      createBridgeStorage({ directory, witnessPath: join(root, "missing") }),
    );
    assert.throws(
      () =>
        createBridgeStorage({ directory, witnessPath, provisionWitness: true }),
      { message: "route_witness_provision_requires_fresh_storage" },
    );
    writeFileSync(join(directory, "device-hmac.key"), randomBytes(32));
    assert.throws(() => createBridgeStorage({ directory, witnessPath }), {
      message: "route_witness_invalid",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a failed binding after witness commit cannot reopen direct access", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-witness-"));
  const directory = join(root, "state");
  const storage = createBridgeStorage({
    directory,
    witnessPath: join(root, "witness.sqlite"),
    provisionWitness: true,
  });
  try {
    storage.directRoutes.registerVerifiedDirect("42", "101");
    const device = storage.registry.redeemInvitation(
      storage.registry.issueInvitation("101").invitation,
    );
    const db = new DatabaseSync(join(directory, "devices.sqlite"));
    try {
      db.exec(
        "CREATE TRIGGER fail_binding BEFORE INSERT ON mobile_bridge_accounts BEGIN SELECT RAISE(ABORT, 'synthetic_failure'); END",
      );
      const bind = () =>
        storage.accounts.saveVerified({
          owner: "101",
          playerId: "42",
          authorization: "Bearer bridge",
          expectedRevision: 0,
          deviceId: device.deviceId,
          generation: 1,
        });
      assert.throws(bind);
      assert.equal(
        storage.directRoutes.resolve({ playerId: "42", owner: "101" }),
        null,
      );
      db.exec("DROP TRIGGER fail_binding");
      assert.deepEqual(bind(), { revision: 1 });
    } finally {
      db.close();
    }
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoring the database cannot revive an invitation or a revoked device", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-witness-device-"));
  const directory = join(root, "state");
  const witnessPath = join(root, "witness.sqlite");
  let storage = createBridgeStorage({
    directory,
    witnessPath,
    provisionWitness: true,
  });
  try {
    const invite = storage.registry.issueInvitation("101");
    storage.close();
    copyFileSync(
      join(directory, "devices.sqlite"),
      join(root, "before-redeem.sqlite"),
    );
    storage = createBridgeStorage({ directory, witnessPath });
    const device = storage.registry.redeemInvitation(invite.invitation);
    storage.close();
    copyFileSync(
      join(directory, "devices.sqlite"),
      join(root, "before-revoke.sqlite"),
    );
    storage = createBridgeStorage({ directory, witnessPath });
    assert.equal(storage.registry.revoke("101", device.deviceId), true);
    storage.close();
    copyFileSync(
      join(root, "before-revoke.sqlite"),
      join(directory, "devices.sqlite"),
    );
    storage = createBridgeStorage({ directory, witnessPath });
    assert.equal(
      storage.registry.authenticateDevice(device.deviceId, device.deviceKey),
      null,
    );
    assert.equal(storage.registry.listDevice("101"), null);
    assert.throws(
      () =>
        storage.accounts.saveVerified({
          owner: "101",
          playerId: "42",
          authorization: "Bearer token",
          expectedRevision: 0,
          deviceId: device.deviceId,
          generation: 1,
        }),
      { code: "device_changed" },
    );
    storage.close();
    copyFileSync(
      join(root, "before-redeem.sqlite"),
      join(directory, "devices.sqlite"),
    );
    storage = createBridgeStorage({ directory, witnessPath });
    assert.throws(() => storage.registry.redeemInvitation(invite.invitation), {
      code: "invalid_invitation",
    });
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoring the database cannot revive a superseded invitation", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-witness-invite-"));
  const directory = join(root, "state");
  const witnessPath = join(root, "witness.sqlite");
  let storage = createBridgeStorage({
    directory,
    witnessPath,
    provisionWitness: true,
  });
  try {
    const first = storage.registry.issueInvitation("101");
    storage.close();
    copyFileSync(join(directory, "devices.sqlite"), join(root, "old.sqlite"));
    storage = createBridgeStorage({ directory, witnessPath });
    storage.registry.issueInvitation("101");
    storage.close();
    copyFileSync(join(root, "old.sqlite"), join(directory, "devices.sqlite"));
    storage = createBridgeStorage({ directory, witnessPath });
    assert.throws(() => storage.registry.redeemInvitation(first.invitation), {
      code: "invalid_invitation",
    });
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restoring an old database cannot erase an unresolved direct or Connector lease", async () => {
  for (const kind of ["direct", "connector"]) {
    const root = mkdtempSync(join(tmpdir(), "bridge-witness-lease-"));
    const directory = join(root, "state");
    const witnessPath = join(root, "witness.sqlite");
    let storage = createBridgeStorage({
      directory,
      witnessPath,
      provisionWitness: true,
    });
    try {
      const device = storage.registry.redeemInvitation(
        storage.registry.issueInvitation("101").invitation,
      );
      storage.directRoutes.registerVerifiedDirect("42", "101");
      storage.close();
      copyFileSync(join(directory, "devices.sqlite"), join(root, "old.sqlite"));
      storage = createBridgeStorage({ directory, witnessPath });
      if (kind === "direct") {
        await assert.rejects(
          storage.directRoutes.withDirectLease(
            { owner: "101", playerId: "42" },
            1,
            (mark) => {
              mark();
              throw new Error("lost result");
            },
          ),
        );
      } else {
        const lease = storage.connectorLeases.acquire("101", "session_verify");
        storage.connectorLeases.markDispatched("101", lease);
      }
      storage.close();
      copyFileSync(join(root, "old.sqlite"), join(directory, "devices.sqlite"));
      storage = createBridgeStorage({ directory, witnessPath });
      assert.throws(
        () =>
          storage.accounts.saveVerified({
            owner: "101",
            playerId: "43",
            authorization: "Bearer token",
            expectedRevision: 0,
            deviceId: device.deviceId,
            generation: 1,
          }),
        { code: "direct_requests_in_flight" },
      );
    } finally {
      storage.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("restored database cannot replay an authenticated IPC nonce", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-witness-nonce-"));
  const directory = join(root, "state");
  const witnessPath = join(root, "witness.sqlite");
  let storage = createBridgeStorage({
    directory,
    witnessPath,
    provisionWitness: true,
  });
  try {
    storage.close();
    copyFileSync(join(directory, "devices.sqlite"), join(root, "old.sqlite"));
    storage = createBridgeStorage({ directory, witnessPath });
    const now = 1_800_000_000_000;
    assert.equal(storage.consumeConnectorNonce("a".repeat(32), now), true);
    storage.close();
    copyFileSync(join(root, "old.sqlite"), join(directory, "devices.sqlite"));
    storage = createBridgeStorage({ directory, witnessPath });
    assert.equal(storage.consumeConnectorNonce("a".repeat(32), now), false);
    assert.equal(
      storage.consumeConnectorNonce("a".repeat(32), now + 60000),
      false,
    );
    assert.equal(storage.consumeConnectorNonce("b".repeat(32), now - 1), false);
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("restored database cannot revive a replaced game credential", () => {
  const root = mkdtempSync(join(tmpdir(), "bridge-witness-token-"));
  const directory = join(root, "state");
  const witnessPath = join(root, "witness.sqlite");
  let storage = createBridgeStorage({
    directory,
    witnessPath,
    provisionWitness: true,
  });
  try {
    const device = storage.registry.redeemInvitation(
      storage.registry.issueInvitation("101").invitation,
    );
    const bind = (authorization, expectedRevision) =>
      storage.accounts.saveVerified({
        owner: "101",
        playerId: "42",
        authorization,
        expectedRevision,
        deviceId: device.deviceId,
        generation: 1,
      });
    bind("Bearer old", 0);
    storage.close();
    copyFileSync(join(directory, "devices.sqlite"), join(root, "old.sqlite"));
    storage = createBridgeStorage({ directory, witnessPath });
    bind("Bearer new", 1);
    assert.equal(storage.accounts.read("101").authorization, "Bearer new");
    storage.close();
    copyFileSync(join(root, "old.sqlite"), join(directory, "devices.sqlite"));
    storage = createBridgeStorage({ directory, witnessPath });
    assert.throws(() => storage.accounts.read("101"), {
      code: "account_storage_corrupt",
    });
    assert.throws(() => storage.accounts.resolveCredential("Bearer old"), {
      code: "account_storage_corrupt",
    });
    assert.throws(() => bind("Bearer unrelated", 1), {
      message: "route_witness_account_rollback",
    });
  } finally {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  }
});
