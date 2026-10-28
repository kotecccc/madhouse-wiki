import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createDeviceRegistry } from "../../scripts/bridge/device-registry.mjs";
import { createBridgeDeviceService } from "../../scripts/bridge/device-service.mjs";

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  terminate() {
    this.readyState = 3;
    this.emit("close");
  }
  close() {
    this.terminate();
  }
  pause() {}
  resume() {}
  send(_data, _options, callback) {
    callback();
  }
}

test("registered device serves only its verified owner and revocation closes it", async () => {
  const db = new DatabaseSync(":memory:");
  const registry = createDeviceRegistry({ db, hmacKey: randomBytes(32) });
  const service = createBridgeDeviceService({ registry });
  try {
    const invite = service.issueInvitation("101");
    const device = service.redeemInvitation(invite.invitation);
    const socket = new FakeSocket();
    assert.equal(await service.status("101"), "offline");
    await service.admit(device, socket);
    assert.equal(await service.status("101"), "online");
    assert.equal(await service.status("102"), "offline");
    await assert.rejects(service.open("102"), { code: "bridge_offline" });
    const stream = await service.open("101");
    assert.equal(service.revoke("102", device.deviceId), false);
    assert.equal(socket.readyState, 1);
    assert.equal(service.revoke("101", device.deviceId), true);
    assert.equal(socket.readyState, 3);
    assert.equal(await service.status("101"), "offline");
    const rejected = new FakeSocket();
    await assert.rejects(service.admit(device, rejected), {
      message: "bridge_unavailable",
    });
    assert.equal(rejected.readyState, 3);
    stream.destroy();
  } finally {
    service.close();
    db.close();
  }
});
