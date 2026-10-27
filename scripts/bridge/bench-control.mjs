import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readdirSync } from "node:fs";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { WebSocket } from "ws";
import { createBridgeControlGateway } from "./control-gateway.mjs";

// Local-only control-channel exercise; fake credentials, no Cargo backend.
const count = 8;
const cycles = 3;
const sessions = new Map();
const key = new Uint8Array(32).fill(99);
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
for (let i = 0; i < count; i++) {
  sessions.set(`fake${i}.session.credential`, {
    ownerId: String(10000 + i),
    deviceId: uuid(i + 1),
    deviceGeneration: 1,
    connectionId: uuid(i + 101),
    routeEpoch: 1,
    expiresAtMs: Date.now() + 120_000,
    scopes: ["control", "data"],
  });
}
const gateway = createBridgeControlGateway({
  enabled: true,
  sessionSigningKey: key,
  registry: {
    authorizeDeviceSession: async (credential) => sessions.get(credential),
    getHelperPaused: () => false,
    setHelperPaused: (_owner, paused) => ({ paused }),
  },
});
const server = createServer();
server.on("upgrade", (req, socket, head) => {
  gateway.handleUpgrade(req, socket, head).catch(() => socket.destroy());
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `ws://127.0.0.1:${server.address().port}/bridge/control`;
const delays = monitorEventLoopDelay({ resolution: 10 });
const fds = () => {
  try {
    return readdirSync("/dev/fd").length;
  } catch {
    return null;
  }
};
const started = performance.now();
const initialRss = process.memoryUsage().rss;
const initialFds = fds();
const latencies = [];
let observedRss = initialRss;
let observedFds = initialFds;
delays.enable();
try {
  await new Promise((resolve) => setTimeout(resolve, 20));
  for (let cycle = 0; cycle < cycles; cycle++) {
    const sockets = await Promise.all(
      [...sessions.keys()].map(async (credential) => {
        const time = performance.now();
        const ws = new WebSocket(url, {
          headers: { authorization: `Bearer ${credential}` },
        });
        await once(ws, "open");
        const result = once(ws, "message");
        ws.send(
          JSON.stringify({
            type: "hello",
            protocolMajor: 1,
            protocolMinor: 0,
            clientVersion: "0.1.0",
            capabilities: ["cargo-byte-tunnel-v1"],
          }),
        );
        const [data] = await result;
        assert.equal(JSON.parse(data.toString()).type, "hello_ok");
        latencies.push(performance.now() - time);
        return ws;
      }),
    );
    assert.equal(gateway.activeConnectionCount, count);
    observedRss = Math.max(observedRss, process.memoryUsage().rss);
    const activeFds = fds();
    if (activeFds !== null) observedFds = Math.max(observedFds ?? 0, activeFds);
    await Promise.all(
      sockets.map(async (ws) => {
        const closed = once(ws, "close");
        ws.close();
        await closed;
      }),
    );
    for (let i = 0; gateway.activeConnectionCount && i < 100; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    assert.equal(gateway.activeConnectionCount, 0);
  }
  await new Promise((resolve) => setTimeout(resolve, 20));
} finally {
  gateway.close();
  server.close();
  await once(server, "close");
  delays.disable();
}
latencies.sort((a, b) => a - b);
console.log(
  JSON.stringify({
    devices: count,
    cycles,
    platform: process.platform,
    architecture: process.arch,
    node: process.version,
    connections: latencies.length,
    durationMs: Number((performance.now() - started).toFixed(1)),
    helloMedianMs: Number(
      latencies[Math.floor(latencies.length / 2)].toFixed(2),
    ),
    helloMaxMs: Number(latencies.at(-1).toFixed(2)),
    rssStartBytes: initialRss,
    rssEndBytes: process.memoryUsage().rss,
    rssObservedBytes: observedRss,
    fdsStart: initialFds,
    fdsObserved: observedFds,
    fdsEnd: fds(),
    eventLoopMaxMs: Number((delays.max / 1e6).toFixed(2)),
    activeConnections: gateway.activeConnectionCount,
    activeStreams: gateway.activeStreamCount,
  }),
);
