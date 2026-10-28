import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBridgeStorage } from "../../scripts/bridge/device-storage.mjs";

test("protected device identity survives a storage restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-storage-"));
  try {
    let storage = createBridgeStorage({ directory: dir });
    const invite = storage.registry.issueInvitation("123");
    const device = storage.registry.redeemInvitation(invite.invitation);
    storage.close();
    storage = createBridgeStorage({ directory: dir });
    assert.ok(
      storage.registry.authenticateDevice(device.deviceId, device.deviceKey),
    );
    storage.close();
    assert.equal(
      readFileSync(join(dir, "devices.sqlite")).includes(
        Buffer.from(device.deviceKey),
      ),
      false,
    );
    chmodSync(join(dir, "device-hmac.key"), 0o644);
    assert.throws(() => createBridgeStorage({ directory: dir }), {
      message: "bridge_storage_permissions_invalid",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing key does not silently reinitialize an existing registry", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-storage-"));
  try {
    const storage = createBridgeStorage({ directory: dir });
    storage.close();
    unlinkSync(join(dir, "device-hmac.key"));
    assert.throws(() => createBridgeStorage({ directory: dir }), {
      message: "bridge_storage_incomplete",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
