import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import { createDeviceRegistry } from "../../scripts/bridge/device-registry.mjs";
import { createBridgeDeviceService } from "../../scripts/bridge/device-service.mjs";
import { createDeviceGateway } from "../../scripts/bridge/device-gateway.mjs";

async function fixture() {
  const db = new DatabaseSync(":memory:");
  const registry = createDeviceRegistry({ db, hmacKey: randomBytes(32) });
  const service = createBridgeDeviceService({ registry });
  const gateway = createDeviceGateway({
    service,
    registry,
    consume: () => true,
  });
  const server = createServer();
  server.on(
    "upgrade",
    (req, socket, head) => void gateway.upgrade(req, socket, head, "127.0.0.1"),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const device = service.redeemInvitation(
    service.issueInvitation("101").invitation,
  );
  return {
    server,
    service,
    gateway,
    device,
    close: async () => {
      gateway.close();
      service.close();
      await new Promise((resolve) => server.close(resolve));
      db.close();
    },
  };
}

test("WSS admission requires valid device identity and revocation closes it", async () => {
  const f = await fixture();
  const base = `ws://127.0.0.1:${f.server.address().port}/bridge/data`;
  const unauthorized = new WebSocket(base, {
    headers: {
      Authorization: `MadhouseBridge ${f.device.deviceId}.${"A".repeat(43)}`,
    },
  });
  try {
    const failed = await once(unauthorized, "error");
    assert.ok(failed[0]);
    const authorized = new WebSocket(base, {
      headers: {
        Authorization: `MadhouseBridge ${f.device.deviceId}.${f.device.deviceKey}`,
      },
    });
    await once(authorized, "open");
    // Admission is asynchronous; wait until the registry-backed pool accepts it.
    let stream;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        stream = await f.service.open("101");
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    assert.ok(stream);
    const closed = once(authorized, "close");
    assert.equal(f.service.revoke("101", f.device.deviceId), true);
    await closed;
    stream.destroy();
  } finally {
    unauthorized.terminate();
    await f.close();
  }
});

test("valid devices can reconnect more than 30 times through the shared proxy", async () => {
  const { createBridgeRateLimiter } =
    await import("../../scripts/bridge/rate-limiter.mjs");
  const limiter = createBridgeRateLimiter({ now: () => 100 });
  const gateway = createDeviceGateway({
    registry: { authenticateDevice: () => true },
    service: { admit: async (_identity, ws) => ws.close() },
    consume: (ip, device) => limiter.consume(ip, "/bridge/data", device),
  });
  const server = createServer();
  server.on(
    "upgrade",
    (req, socket, head) => void gateway.upgrade(req, socket, head, "127.0.0.1"),
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    for (let i = 0; i < 40; i++) {
      const ws = new WebSocket(
        `ws://127.0.0.1:${server.address().port}/bridge/data`,
        {
          headers: {
            Authorization: `MadhouseBridge 11111111-1111-4111-8111-111111111111.${"A".repeat(43)}`,
          },
        },
      );
      await once(ws, "open");
      await once(ws, "close");
    }
  } finally {
    gateway.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
