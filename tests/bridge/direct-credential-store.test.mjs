import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";

test("only a dispatched verification lease can register a direct session", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-direct-credential-"));
  let store = createBridgeStorage({ directory });
  const authorization = "Bearer synthetic-token";
  const credentialDigest = createHash("sha256")
    .update(authorization)
    .digest("hex");
  try {
    const leaseId = store.connectorLeases.acquire("101", "session_verify");
    const record = { owner: "101", playerId: "42", credentialDigest, leaseId };
    assert.throws(() => store.directCredentials.register(record), {
      code: "owner_lease_invalid",
    });
    store.connectorLeases.markDispatched("101", leaseId);
    assert.throws(
      () => store.directCredentials.register({ ...record, owner: "102" }),
      { code: "owner_lease_invalid" },
    );
    store.directCredentials.register(record);
    const device = store.registry.redeemInvitation(
      store.registry.issueInvitation("101").invitation,
    );
    assert.throws(
      () =>
        store.accounts.saveVerified({
          owner: "101",
          playerId: "42",
          authorization: "Bearer bridge",
          expectedRevision: 0,
          deviceId: device.deviceId,
          generation: 1,
        }),
      { code: "direct_requests_in_flight" },
    );
    assert.deepEqual(store.directCredentials.resolve(authorization), {
      owner: "101",
      playerId: "42",
    });
    assert.deepEqual(store.directRoutes.resolve({ playerId: "42" }), {
      policy: "direct",
      epoch: 1,
    });
    assert.equal(
      readFileSync(join(directory, "devices.sqlite")).includes(
        Buffer.from(authorization),
      ),
      false,
    );
    store.connectorLeases.finish("101", leaseId, { definitelyFinished: true });
    assert.throws(() => store.directCredentials.register(record), {
      code: "owner_lease_invalid",
    });
    store.close();
    store = createBridgeStorage({ directory });
    assert.deepEqual(store.directCredentials.resolve(authorization), {
      owner: "101",
      playerId: "42",
    });
    assert.equal(store.directCredentials.resolve("Bearer different"), null);
    const db = new DatabaseSync(join(directory, "devices.sqlite"));
    try {
      db.exec(
        "UPDATE mobile_bridge_direct_credentials SET player_key = 'tampered'",
      );
    } finally {
      db.close();
    }
    assert.throws(() => store.directCredentials.resolve(authorization), {
      code: "account_storage_corrupt",
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a bridge owner cannot enroll a new direct credential", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-direct-credential-"));
  const store = createBridgeStorage({ directory });
  try {
    const device = store.registry.redeemInvitation(
      store.registry.issueInvitation("101").invitation,
    );
    store.accounts.saveVerified({
      owner: "101",
      playerId: "42",
      authorization: "Bearer bridge",
      expectedRevision: 0,
      deviceId: device.deviceId,
      generation: 1,
    });
    assert.throws(
      () => store.connectorLeases.acquire("101", "session_verify"),
      { code: "bridge_route_required" },
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
