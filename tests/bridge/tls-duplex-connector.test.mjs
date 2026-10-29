import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { createServer, connect as connectTls } from "node:tls";
import { test } from "node:test";
import {
  CARGO_HOST,
  createGameTlsDuplexConnector,
} from "../../scripts/bridge/tls-duplex-connector.mjs";

const cert = await readFile(
  new URL("./fixtures/cargo-cert.pem", import.meta.url),
);
const key = await readFile(
  new URL("./fixtures/cargo-key.pem", import.meta.url),
);

async function startFakeGame() {
  const server = createServer({ cert, key }, (socket) => {
    socket.on("data", (data) => socket.write(data));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

function dial(connector, options = {}) {
  return new Promise((resolve, reject) => {
    connector(
      { protocol: "https:", hostname: CARGO_HOST, port: 443, ...options },
      (error, socket) => (error ? reject(error) : resolve(socket)),
    );
  });
}

test("verifies TLS over the provided tunnel and exchanges bytes", async () => {
  const server = await startFakeGame();
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => createConnection(server.address().port, "127.0.0.1"),
    tlsConnect: (options) => connectTls({ ...options, ca: cert }),
  });
  try {
    const socket = await dial(connector);
    assert.equal(socket.authorized, true);
    const response = new Promise((resolve) => socket.once("data", resolve));
    socket.write("fake-profile");
    assert.equal((await response).toString(), "fake-profile");
    socket.destroy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rejects an untrusted certificate without opening a direct fallback", async () => {
  const server = await startFakeGame();
  let opened = 0;
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => {
      opened += 1;
      return createConnection(server.address().port, "127.0.0.1");
    },
  });
  try {
    await assert.rejects(dial(connector), { code: "tls_failed" });
    assert.equal(opened, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rejects arbitrary destinations before opening a tunnel", async () => {
  let opened = 0;
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => {
      opened += 1;
    },
  });
  await assert.rejects(dial(connector, { hostname: "elsewhere.test" }), {
    code: "target_forbidden",
  });
  await assert.rejects(dial(connector, { port: 8443 }), {
    code: "target_forbidden",
  });
  assert.equal(opened, 0);
});

test("fails closed when the device is offline", async () => {
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => Promise.reject(new Error("offline")),
  });
  await assert.rejects(dial(connector), { code: "bridge_offline" });
});

test("a slow game TLS handshake can complete after ten seconds", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const tunnel = new PassThrough();
  const tlsSocket = new EventEmitter();
  tlsSocket.authorized = true;
  tlsSocket.destroy = () => {};
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => tunnel,
    tlsConnect: () => tlsSocket,
  });
  const outcome = dial(connector).then(
    (socket) => ({ socket }),
    (error) => ({ error }),
  );
  t.mock.timers.tick(11_000);
  tlsSocket.emit("secureConnect");
  assert.equal((await outcome).socket, tlsSocket);
  tunnel.destroy();
});

test("rejects the tunnel if authorization changes before TLS is ready", async () => {
  const server = await startFakeGame();
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => createConnection(server.address().port, "127.0.0.1"),
    tlsConnect: (options) => connectTls({ ...options, ca: cert }),
    validateTunnel: () => false,
  });
  try {
    await assert.rejects(dial(connector), {
      code: "bridge_mutation_not_admitted",
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("cancellation during a delayed TLS guard never releases the socket to HTTP", async () => {
  const controller = new AbortController();
  const tunnel = new PassThrough();
  const tlsSocket = new EventEmitter();
  tlsSocket.authorized = true;
  tlsSocket.destroy = () => {};
  let allow;
  const pending = new Promise((resolve) => (allow = resolve));
  let ready = 0;
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => tunnel,
    tlsConnect: () => tlsSocket,
    validateTunnel: () => pending,
    signal: controller.signal,
    onReady: () => ready++,
  });
  const outcome = dial(connector);
  tlsSocket.emit("secureConnect");
  await Promise.resolve();
  controller.abort();
  allow(true);
  await assert.rejects(outcome, { code: "bridge_cancelled" });
  await Promise.resolve();
  assert.equal(ready, 0);
  assert.equal(tunnel.destroyed, true);
});

test("request log omits query and only appears after tunnel authorization", async () => {
  const server = await startFakeGame();
  const messages = [];
  const connector = createGameTlsDuplexConnector({
    openTunnel: () => {
      const socket = createConnection(server.address().port, "127.0.0.1");
      socket.socket = {
        bridgeRequestLog: true,
        readyState: 1,
        send: (message) => messages.push(JSON.parse(message)),
      };
      return socket;
    },
    tlsConnect: (options) => connectTls({ ...options, ca: cert }),
    validateTunnel: () => true,
    requestInfo: { method: "GET", path: "/api/bosses/7?private=token" },
  });
  try {
    const socket = await dial(connector);
    assert.deepEqual(messages, [
      { type: "request", method: "GET", path: "/api/bosses/7" },
    ]);
    socket.destroy();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
