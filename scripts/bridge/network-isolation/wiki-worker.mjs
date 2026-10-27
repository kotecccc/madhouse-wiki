import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { connect as connectTls } from "node:tls";
import {
  classifyGameOperation,
  createGameApiClient,
} from "../game-api-client.mjs";
import { createGameApiTunnelTransport } from "../game-api-transport.mjs";
import { createBridgeControlGateway } from "../control-gateway.mjs";

const deviceId = "00000000-0000-4000-8000-000000000401";
const connectionId = "00000000-0000-4000-8000-000000000402";
const ownerId = "54321";
const routeEpoch = 1;
const sessionCredential = "fixture.device.session";
const session = Object.freeze({
  ownerId,
  deviceId,
  deviceGeneration: 1,
  connectionId,
  routeEpoch,
  expiresAtMs: Date.now() + 120_000,
  scopes: ["control", "data"],
});
const sessionSigningKey = new Uint8Array(32).fill(79);
const cargoCertificate = readFileSync(
  "/wiki/tests/bridge/fixtures/cargo-cert.pem",
);

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function waitFor(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("desktop_ready_timeout")),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function probeDirectCargoPath() {
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection(443, "cargohustle.online");
    const timer = setTimeout(
      () => finish({ connected: false, reason: "timeout" }),
      1000,
    );
    function finish(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }
    socket.once("connect", () => finish({ connected: true }));
    socket.once("error", (error) =>
      finish({ connected: false, reason: error.code || "socket_error" }),
    );
  });
}

const gateway = createBridgeControlGateway({
  registry: {
    async authorizeDeviceSession(credential) {
      if (credential !== sessionCredential)
        throw new Error("device_session_invalid");
      return session;
    },
    getHelperPaused() {
      return false;
    },
    setHelperPaused(_ownerId, paused) {
      return { paused };
    },
  },
  sessionSigningKey,
  enabled: true,
});
const desktopReady = deferred();
const server = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/desktop-online") {
    desktopReady.resolve();
    response.writeHead(204);
    response.end();
    return;
  }
  response.writeHead(404, { "Content-Length": "0" });
  response.end();
});
server.on("upgrade", (request, socket, head) => {
  gateway.handleUpgrade(request, socket, head).catch(() => socket.destroy());
});
server.on("error", (error) => {
  console.error(`WIKI_SERVER_FAILURE ${error.code || "server_error"}`);
});
let directCalls = 0;

const gameApi = createGameApiClient({
  directTransport: async (...args) => {
    directCalls += 1;
    return fetch(...args);
  },
  bridgeTransport: createGameApiTunnelTransport({
    async openStream({ route, signal }) {
      console.log("WIKI_OPEN_STREAM_REQUESTED");
      console.log(
        `WIKI_GATEWAY_STATE before_connections=${gateway.activeConnectionCount} signal_aborted=${signal?.aborted === true}`,
      );
      try {
        const stream = await gateway.openStream({
          ownerId,
          deviceId: route.activeDeviceId,
          routeEpoch: route.routeEpoch,
          signal,
        });
        console.log("WIKI_STREAM_OPENED");
        return stream;
      } catch (error) {
        console.error(
          `WIKI_STREAM_FAILURE ${error.code || error.message || "unknown"} connections=${gateway.activeConnectionCount}`,
        );
        throw error;
      }
    },
    tlsConnect: (options) => connectTls({ ...options, ca: cargoCertificate }),
  }),
  resolveRoute: async () => ({
    policy: "bridge_required",
    routeEpoch,
    activeDeviceId: deviceId,
  }),
});

try {
  server.listen(8787, "0.0.0.0");
  await once(server, "listening");
  console.log("WIKI_READY");
  await waitFor(desktopReady.promise, 15_000);

  const directProbe = await probeDirectCargoPath();
  assert.equal(directProbe.connected, false);

  const response = await gameApi.request({
    operation: {
      method: "GET",
      path: "/api/me",
      operationClass: classifyGameOperation({ method: "GET", path: "/api/me" }),
    },
    path: "/api/me",
    method: "GET",
    headers: { Authorization: "Bearer fixture.game.token" },
    signal: AbortSignal.timeout(10_000),
    context: { accountId: ownerId },
  });
  assert.equal(response.status, 200);
  const profile = await response.json();
  assert.deepEqual(profile, { playerId: 54321, nickname: "fixture" });
  assert.equal(directCalls, 0);
  console.log(
    `T15_RESULT ${JSON.stringify({
      directProbe,
      directTransportCalls: directCalls,
      playerId: profile.playerId,
    })}`,
  );
} catch (error) {
  console.error(`WIKI_FAILURE ${error.code || error.message || "unknown"}`);
  process.exitCode = 1;
} finally {
  gateway.close();
  await new Promise((resolve) => server.close(resolve));
}
