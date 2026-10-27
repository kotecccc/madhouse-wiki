import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { connect as connectTls } from "node:tls";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import test from "node:test";
import { WebSocket } from "ws";
import { createBridgeControlGateway } from "../../scripts/bridge/control-gateway.mjs";
import { createGameApiTunnelTransport } from "../../scripts/bridge/game-api-transport.mjs";
import { createGameApiClient } from "../../scripts/bridge/game-api-client.mjs";
import { createFakeCargo } from "./fake-cargo.mjs";

const cert = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const key = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("isolated devices perform simultaneous HTTPS reads over independent bridge tunnels", async () => {
  const cargo = createFakeCargo({
    certificate: cert,
    privateKey: key,
    onRequest: async (record, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          path: record.path,
          authorization: record.authorization,
        }),
      );
    },
  });
  const port = await cargo.listen();
  const sessions = new Map(
    Array.from({ length: 4 }, (_, i) => [
      `fake${i}.session.credential`,
      {
        ownerId: String(40001 + i),
        deviceId: uuid(i + 1),
        connectionId: uuid(i + 101),
        deviceGeneration: 1,
        routeEpoch: 1,
        expiresAtMs: Date.now() + 60_000,
        scopes: ["control", "data"],
      },
    ]),
  );
  const gateway = createBridgeControlGateway({
    enabled: true,
    sessionSigningKey: new Uint8Array(32).fill(77),
    registry: {
      authorizeDeviceSession: async (credential) => sessions.get(credential),
      getHelperPaused: () => false,
      setHelperPaused: (_owner, paused) => ({ paused }),
    },
  });
  const http = createServer();
  http.on("upgrade", (request, socket, head) => {
    gateway.handleUpgrade(request, socket, head).catch(() => socket.destroy());
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  const url = `ws://127.0.0.1:${http.address().port}`;
  const resources = new Set();
  try {
    const devices = await Promise.all(
      [...sessions].map(async ([credential, session]) => {
        const control = new WebSocket(`${url}/bridge/control`, {
          headers: { authorization: `Bearer ${credential}` },
        });
        resources.add(control);
        control.on("message", (bytes) => {
          const message = JSON.parse(bytes.toString());
          if (message.type !== "open_stream") return;
          const data = new WebSocket(`${url}/bridge/data`, {
            headers: {
              authorization: `Bearer ${credential}`,
              "x-madhouse-stream-ticket": message.streamTicket,
            },
          });
          resources.add(data);
          data.once("open", () => {
            const tcp = createConnection({ host: "127.0.0.1", port });
            resources.add(tcp);
            tcp.on("error", () => {});
            tcp.on("data", (chunk) => {
              if (data.readyState === WebSocket.OPEN)
                data.send(chunk, { binary: true });
            });
            data.on("message", (chunk) => {
              if (!tcp.destroyed) tcp.write(chunk);
            });
            data.once("close", () => tcp.destroy());
            tcp.once("connect", () =>
              control.send(
                JSON.stringify({
                  type: "stream_ready",
                  requestId: message.requestId,
                  streamId: message.streamId,
                }),
              ),
            );
          });
        });
        await once(control, "open");
        const hello = once(control, "message");
        control.send(
          JSON.stringify({
            type: "hello",
            protocolMajor: 1,
            protocolMinor: 0,
            clientVersion: "0.1.0",
            capabilities: ["cargo-byte-tunnel-v1"],
          }),
        );
        assert.equal(JSON.parse((await hello)[0].toString()).type, "hello_ok");
        const client = createGameApiClient({
          directTransport: async () => assert.fail("direct transport used"),
          resolveRoute: async () => ({
            policy: "bridge_required",
            playerId: session.ownerId,
            routeEpoch: 1,
            activeDeviceId: session.deviceId,
          }),
          bridgeTransport: createGameApiTunnelTransport({
            openStream: ({ route, signal }) =>
              gateway.openStream({
                ownerId: session.ownerId,
                deviceId: route.activeDeviceId,
                routeEpoch: route.routeEpoch,
                signal,
              }),
            tlsConnect: (options) => connectTls({ ...options, ca: cert }),
          }),
        });
        return { client, session };
      }),
    );
    assert.equal(gateway.activeConnectionCount, 4);
    const responses = await Promise.all(
      devices.map(({ client, session }) =>
        client.request({
          operation: { method: "GET", path: "/api/me", operationClass: "read" },
          path: "/api/me",
          headers: {
            Authorization: `Bearer fake.${session.ownerId}.signature`,
          },
        }),
      ),
    );
    for (const [index, response] of responses.entries()) {
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), {
        path: "/api/me",
        authorization: `Bearer fake.${devices[index].session.ownerId}.signature`,
      });
    }
    assert.equal(cargo.requests.length, 4);
    assert.deepEqual(
      cargo.requests.map((request) => request.authorization).sort(),
      devices
        .map(({ session }) => `Bearer fake.${session.ownerId}.signature`)
        .sort(),
    );
  } finally {
    gateway.close();
    for (const item of resources) {
      if (typeof item.terminate === "function") item.terminate();
      else item.destroy();
    }
    await new Promise((resolve) => http.close(resolve));
    await cargo.close();
  }
});
