import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";

test("connector direct activity fences bridge binding across processes and owners", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-owner-lease-"));
  const a = createBridgeStorage({ directory });
  const b = createBridgeStorage({ directory });
  try {
    const device = b.registry.redeemInvitation(
      b.registry.issueInvitation("101").invitation,
    );
    const lease = a.connectorLeases.acquire("101", "session_verify");
    a.connectorLeases.markDispatched("101", lease);
    assert.throws(
      () =>
        b.accounts.saveVerified({
          owner: "101",
          playerId: "42",
          authorization: "Bearer token",
          expectedRevision: 0,
          deviceId: device.deviceId,
          generation: 1,
        }),
      { code: "direct_requests_in_flight" },
    );
    assert.equal(
      a.connectorLeases.finish("102", lease, { definitelyFinished: true }),
      false,
    );
    assert.throws(() => a.connectorLeases.finish("101", lease), {
      code: "owner_lease_unresolved",
    });
    assert.equal(
      a.connectorLeases.finish("101", lease, { definitelyFinished: true }),
      true,
    );
    assert.deepEqual(
      b.accounts.saveVerified({
        owner: "101",
        playerId: "42",
        authorization: "Bearer token",
        expectedRevision: 0,
        deviceId: device.deviceId,
        generation: 1,
      }),
      { revision: 1 },
    );
    assert.throws(() => a.connectorLeases.acquire("101", "telegram_auth"), {
      code: "bridge_route_required",
    });
    const other = a.connectorLeases.acquire("102", "telegram_auth");
    assert.equal(
      a.connectorLeases.finish("102", other, { definitelyFinished: true }),
      true,
    );
    const raw = new DatabaseSync(join(directory, "devices.sqlite"));
    try {
      raw.exec("DELETE FROM mobile_bridge_accounts");
    } finally {
      raw.close();
    }
    assert.throws(() => a.connectorLeases.acquire("101", "telegram_auth"), {
      code: "bridge_route_required",
    });
  } finally {
    b.close();
    a.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a dispatched connector request is not automatically released after restart", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-owner-lease-"));
  let storage = createBridgeStorage({ directory });
  try {
    const lease = storage.connectorLeases.acquire("101", "telegram_auth");
    storage.connectorLeases.markDispatched("101", lease);
    storage.close();
    storage = createBridgeStorage({ directory });
    const pending = storage.connectorLeases.pending("101");
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, lease);
    assert.equal(pending[0].phase, "dispatched");
    assert.equal(pending[0].operation, "telegram_auth");
    assert.deepEqual(storage.connectorLeases.pending("102"), []);
  } finally {
    storage.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
