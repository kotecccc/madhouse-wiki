import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createDeviceRegistry } from "../../scripts/bridge/device-registry.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "bridge-registry-"));
  const path = join(directory, "test.sqlite");
  let db = new DatabaseSync(path);
  const key = randomBytes(32);
  let timestamp = 1000;
  const open = () =>
    createDeviceRegistry({ db, hmacKey: key, now: () => timestamp });
  return {
    path,
    registry: open(),
    setTime(value) {
      timestamp = value;
    },
    reopen() {
      db.close();
      db = new DatabaseSync(path);
      return open();
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("one-use invitation creates a durable credential scoped to verified owner", () => {
  const f = fixture();
  try {
    const invite = f.registry.issueInvitation("123");
    const device = f.registry.redeemInvitation(invite.invitation);
    assert.throws(() => f.registry.redeemInvitation(invite.invitation), {
      code: "invalid_invitation",
    });
    const registry = f.reopen();
    assert.equal(
      registry.authenticate("123", device.deviceId, device.deviceKey, 1),
      true,
    );
    assert.equal(
      registry.authenticate("456", device.deviceId, device.deviceKey, 1),
      false,
    );
    assert.deepEqual(
      registry.authenticateDevice(device.deviceId, device.deviceKey),
      {
        owner: registry.ownerKey("123"),
        device: device.deviceId,
        generation: 1,
      },
    );
    assert.equal(
      registry.authenticateDevice(device.deviceId, "A".repeat(43)),
      null,
    );
    const bytes = readFileSync(f.path);
    assert.equal(bytes.includes(Buffer.from(invite.invitation)), false);
    assert.equal(bytes.includes(Buffer.from(device.deviceKey)), false);
  } finally {
    f.close();
  }
});

test("expired and replaced invitations cannot be redeemed", () => {
  const f = fixture();
  try {
    const first = f.registry.issueInvitation("123");
    const second = f.registry.issueInvitation("123");
    assert.throws(() => f.registry.redeemInvitation(first.invitation), {
      code: "invalid_invitation",
    });
    f.setTime(second.expiresAt);
    assert.throws(() => f.registry.redeemInvitation(second.invitation), {
      code: "invalid_invitation",
    });
  } finally {
    f.close();
  }
});

test("active device cannot be replaced silently; revocation invalidates it", () => {
  const f = fixture();
  try {
    const device = f.registry.redeemInvitation(
      f.registry.issueInvitation("123").invitation,
    );
    assert.deepEqual(f.registry.listDevice("123"), {
      deviceId: device.deviceId,
      generation: 1,
    });
    assert.equal(f.registry.listDevice("456"), null);
    const next = f.registry.issueInvitation("123");
    assert.throws(() => f.registry.redeemInvitation(next.invitation), {
      code: "device_already_active",
    });
    assert.equal(f.registry.revoke("456", device.deviceId), false);
    assert.equal(f.registry.revoke("123", device.deviceId), true);
    assert.equal(
      f.registry.authenticateDevice(device.deviceId, device.deviceKey),
      null,
    );
    const replacement = f.registry.redeemInvitation(next.invitation);
    assert.notEqual(device.deviceId, replacement.deviceId);
    assert.equal(
      f.registry.authenticate(
        "123",
        replacement.deviceId,
        replacement.deviceKey,
        1,
      ),
      true,
    );
    assert.equal(
      f.registry.authenticate("123", device.deviceId, device.deviceKey, 1),
      false,
    );
  } finally {
    f.close();
  }
});
