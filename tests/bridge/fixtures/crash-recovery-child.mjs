import { createServer } from "node:http";
import { connect as connectTls } from "node:tls";
import { readFile } from "node:fs/promises";
import { createDeviceGateway } from "../../../scripts/bridge/device-gateway.mjs";
import { createDeviceTunnelPool } from "../../../scripts/bridge/device-tunnel-pool.mjs";
import { createBridgeAccountService } from "../../../scripts/bridge/account-service.mjs";
import { createQueueActionGate } from "../../../scripts/bridge/queue-action-gate.mjs";
import { sendFriendResponseOverBridge } from "../../../scripts/bridge/profile-client.mjs";
import { createGameTlsDuplexConnector } from "../../../scripts/bridge/tls-duplex-connector.mjs";
import { createDirectBoundary } from "../../../scripts/game/direct-boundary.mjs";
import { createAutomationStateStore } from "../../../scripts/automation/state-store.mjs";

const [port, directory, gameCertificate] = process.argv.slice(2);
if (!/^\d+$/.test(port || "") || !directory || !gameCertificate)
  throw new Error("invalid_fixture_arguments");
const deviceId = "00000000-0000-4000-8000-000000000001";
const deviceKey = "A".repeat(43);
const authorization = "Bearer crash-recovery-fixture";
const cert = await readFile(gameCertificate);
const registry = {
  ownerKey: (owner) => owner,
  authenticateDevice: (id, token) =>
    id === deviceId && token === deviceKey
      ? { owner: "test-owner", device: deviceId, generation: 1 }
      : null,
  isActive: (identity) =>
    identity.owner === "test-owner" && identity.device === deviceId,
};
const pool = createDeviceTunnelPool({
  authorize: registry.isActive,
  reconnectWaitMs: 1500,
});
const store = createAutomationStateStore({ directory });
const boundary = createDirectBoundary({
  env: {
    MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
    MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
    MADHOUSE_GAME_DEVICE_INTERVAL_MS: "1",
    MADHOUSE_GAME_QUEUE_WAIT_MS: "5000",
  },
  requireBridgeJournal: true,
});
boundary.installBridgeStore(store);
const gate = createQueueActionGate();
const accountService = createBridgeAccountService({
  accounts: {
    read: () => ({ authorization, playerId: "42", revision: 1 }),
    getRevision: () => 1,
  },
  devices: {
    listDevice: () => ({ deviceId, generation: 1 }),
    open: (owner, options) => pool.open(owner, options),
  },
  registry,
  queueActionGate: gate,
  coordinate: (attempt) => boundary.bridge(attempt),
  sendAction: (options) => {
    const connector = createGameTlsDuplexConnector({
      openTunnel: options.openTunnel,
      tlsConnect: (config) => connectTls({ ...config, ca: cert }),
      validateTunnel: options.validateTunnel,
    });
    return sendFriendResponseOverBridge({ ...options, connector });
  },
});
const gateway = createDeviceGateway({
  service: {
    admit: ({ deviceId: id, deviceKey: token }, socket) => {
      const identity = registry.authenticateDevice(id, token);
      if (!identity) return socket.terminate();
      return pool.admit(identity, socket);
    },
  },
  registry,
  consume: async () => true,
  heartbeatMs: 60_000,
});
const server = createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        tunnelReady: await pool.online("test-owner"),
      }),
    );
    return;
  }
  if (req.method === "GET" && req.url === "/state") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        activeAttempts: store.readActiveBridgeAttempts(),
        diagnostics: boundary.diagnostics(),
      }),
    );
    return;
  }
  if (req.method === "POST" && req.url === "/attempt") {
    const controller = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const job = {
      id: "attack-job-1",
      type: "battle.attack",
      status: "running",
      args: { bossId: 7, battleId: "battle-1" },
    };
    const pending = {
      id: job.id,
      kind: "attack",
      bossId: 7,
      battleId: "battle-1",
      operationId: "attack-operation-1",
    };
    try {
      await gate.run(
        job,
        false,
        authorization,
        () =>
          accountService.send(
            "test-owner",
            "POST",
            "/api/bosses/battles/battle-1/attack",
            {
              body: JSON.stringify({ operationId: pending.operationId }),
              callerAuthorization: authorization,
              signal: controller.signal,
            },
          ),
        () => true,
        () => pending,
      );
      res.writeHead(200).end("completed");
    } catch (error) {
      res
        .writeHead(error?.notDispatched ? 409 : 502)
        .end(error?.code || "failed");
    }
    return;
  }
  res.writeHead(404).end();
});
server.on(
  "upgrade",
  (req, socket, head) => void gateway.upgrade(req, socket, head, "127.0.0.1"),
);
server.listen(Number(port), "127.0.0.1", () => {
  process.stdout.write("READY\n");
});

function shutdown() {
  gateway.close();
  pool.close();
  boundary.close();
  store.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
