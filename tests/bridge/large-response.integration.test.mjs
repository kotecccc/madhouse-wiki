import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer as createHttpsServer } from "node:https";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { connect as connectTls } from "node:tls";
import { test } from "node:test";
import { createDeviceGateway } from "../../scripts/bridge/device-gateway.mjs";
import { createDeviceTunnelPool } from "../../scripts/bridge/device-tunnel-pool.mjs";
import { createGameTlsDuplexConnector } from "../../scripts/bridge/tls-duplex-connector.mjs";
import { readGameOverBridge } from "../../scripts/bridge/profile-client.mjs";

const cert = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const key = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);
const deviceId = "00000000-0000-4000-8000-000000000001";
const deviceKey = "A".repeat(43);
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve) => server.close(resolve));

for (const { length, tooLarge, chunked } of [
  { length: 3500000, tooLarge: false },
  { length: 4500000, tooLarge: true },
  { length: 350000, tooLarge: false, chunked: true },
])
  test(
    `installed Python relay ${tooLarge ? "rejects oversized" : "preserves large"} ${chunked ? "streamed" : "fixed-length"} fake clothing responses over TLS`,
    { skip: !process.env.MADHOUSE_TEST_BRIDGE_AGENT },
    async () => {
      const body = JSON.stringify({
        catalog: { sets: [{ items: [{ id: 1, name: "x".repeat(length) }] }] },
        player: {},
      });
      const game = createHttpsServer({ cert, key }, (_req, res) => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          ...(chunked ? {} : { "Content-Length": Buffer.byteLength(body) }),
        });
        if (!chunked) res.end(body);
        else
          void (async () => {
            for (let offset = 0; offset < body.length; offset += 16384) {
              if (res.destroyed) return;
              res.write(body.slice(offset, offset + 16384));
              await new Promise((resolve) => setTimeout(resolve, 5));
            }
            res.end();
          })();
      });
      await listen(game);
      const registry = {
        ownerKey: (owner) => owner,
        authenticateDevice(id, token) {
          return id === deviceId && token === deviceKey
            ? { owner: "test-owner", device: id, generation: 1 }
            : null;
        },
        isActive: () => true,
      };
      const pool = createDeviceTunnelPool({
        authorize: registry.isActive,
        reconnectWaitMs: 50,
      });
      const service = {
        admit: ({ deviceId: id, deviceKey: token }, socket) =>
          pool.admit(registry.authenticateDevice(id, token), socket),
      };
      const gateway = createDeviceGateway({
        service,
        registry,
        consume: async () => true,
        heartbeatMs: 60000,
      });
      const bridge = createHttpsServer({ cert, key });
      bridge.on(
        "upgrade",
        (req, socket, head) =>
          void gateway.upgrade(req, socket, head, "127.0.0.1"),
      );
      await listen(bridge);
      const python = spawn(
        "python3",
        [
          fileURLToPath(new URL("./fixtures/python-relay.py", import.meta.url)),
          process.env.MADHOUSE_TEST_BRIDGE_AGENT,
          String(bridge.address().port),
          String(game.address().port),
          "tls",
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        await new Promise((resolve, reject) => {
          let output = "";
          python.stdout.on("data", (data) => {
            output += data.toString();
            if (output.includes("RELAY_READY")) resolve();
          });
          python.once("error", reject);
          python.once("exit", (code) =>
            reject(new Error(`relay exited: ${code}`)),
          );
        });
        const connector = createGameTlsDuplexConnector({
          openTunnel: () => pool.open("test-owner"),
          tlsConnect: (config) => connectTls({ ...config, ca: cert }),
        });
        const request = readGameOverBridge({
          authorization: "Bearer fake-token",
          path: "/api/clothing",
          connector,
        });
        if (tooLarge)
          await assert.rejects(request, { code: "profile_too_large" });
        else {
          const result = await request;
          assert.equal(result.status, 200);
          assert.equal(result.body.length, Buffer.byteLength(body));
          assert.equal(result.body.toString(), body);
        }
      } finally {
        python.kill();
        gateway.close();
        pool.close();
        await close(bridge);
        await close(game);
      }
    },
  );
