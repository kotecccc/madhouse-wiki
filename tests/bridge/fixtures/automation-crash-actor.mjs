import { createServer } from "node:http";
import { connect as connectTls } from "node:tls";
import { readFile } from "node:fs/promises";
import { createDeviceGateway } from "../../../scripts/bridge/device-gateway.mjs";
import { createDeviceTunnelPool } from "../../../scripts/bridge/device-tunnel-pool.mjs";
import { createBridgeAccountService } from "../../../scripts/bridge/account-service.mjs";
import { createBridgeAwareAccountFetch } from "../../../scripts/bridge/bridge-aware-fetch.mjs";
import { createQueueActionGate } from "../../../scripts/bridge/queue-action-gate.mjs";
import {
  readGameOverBridge,
  sendFriendResponseOverBridge,
} from "../../../scripts/bridge/profile-client.mjs";
import { createGameTlsDuplexConnector } from "../../../scripts/bridge/tls-duplex-connector.mjs";
import { createDirectBoundary } from "../../../scripts/game/direct-boundary.mjs";
import { createAutomationStateStore } from "../../../scripts/automation/state-store.mjs";
import { createAutomationService } from "../../../scripts/automation/service.mjs";

const [port, directory, gameCertificate] = process.argv.slice(2);
if (!/^\d+$/.test(port || "") || !directory || !gameCertificate)
  throw new Error("invalid_fixture_arguments");
const deviceId = "00000000-0000-4000-8000-000000000001";
const deviceKey = "A".repeat(43);
const authorization = "Bearer actor-crash-fixture";
const owner = "actor-owner";
const cert = await readFile(gameCertificate);
const registry = {
  ownerKey: (value) => value,
  authenticateDevice: (id, token) =>
    id === deviceId && token === deviceKey
      ? { owner, device: deviceId, generation: 1 }
      : null,
  isActive: (identity) =>
    identity.owner === owner &&
    identity.device === deviceId &&
    identity.generation === 1,
};
const pool = createDeviceTunnelPool({ authorize: registry.isActive });
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
const accounts = {
  resolveCredential: (value) =>
    value === authorization
      ? {
          policy: "bridge_required",
          owner,
          epoch: 1,
          credentialCurrent: true,
        }
      : null,
  read: (value) =>
    value === owner ? { authorization, playerId: "42", revision: 1 } : null,
  getRevision: (value) => (value === owner ? 1 : 0),
};
const devices = {
  listDevice: (value) => (value === owner ? { deviceId, generation: 1 } : null),
  open: (value, options) => pool.open(value, options),
};
const connector = ({
  openTunnel,
  validateTunnel,
  signal,
  onTransportStopped,
  method,
  path,
}) =>
  createGameTlsDuplexConnector({
    openTunnel,
    tlsConnect: (config) => connectTls({ ...config, ca: cert }),
    validateTunnel,
    signal,
    onTransportStopped,
    requestInfo: { method, path },
  });
const accountService = createBridgeAccountService({
  accounts,
  devices,
  registry,
  queueActionGate: gate,
  coordinate: (attempt) => boundary.bridge(attempt),
  readProfile: async () => ({
    status: 200,
    body: Buffer.from(JSON.stringify({ playerId: 42, telegramId: owner })),
  }),
  readGame: (options) =>
    readGameOverBridge({ ...options, connector: connector(options) }),
  sendAction: (options) =>
    sendFriendResponseOverBridge({ ...options, connector: connector(options) }),
});
const snapshots = {
  identity: () => ({ playerId: 42 }),
  routingIdentity: () => ({ playerId: 42 }),
  fetch: async () => Response.json({}),
  liveFetch: async () => Response.json({}),
};
const directRoutes = {
  resolve: () => null,
  registerVerifiedDirect() {
    throw new Error("direct_route_must_not_be_selected");
  },
  withDirectLease() {
    throw new Error("direct_route_must_not_be_selected");
  },
};
const transport = createBridgeAwareAccountFetch({
  snapshots,
  accounts,
  directRoutes,
  accountService,
});
const service = createAutomationService({
  store,
  queueActionGate: gate,
  identifyPlayer: async () => ({ playerId: 42 }),
  getBoss: (id) => ({
    numericId: id,
    name: "Fake actor boss",
    possibleDrops: [],
  }),
  fetcher: (url, init) => transport.liveFetch(url, init),
  snapshotFetch: (url, init) => transport.fetch(url, init),
});
await service.boot();
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
  const send = (status, value) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(value));
  };
  try {
    if (req.method === "GET" && req.url === "/health") {
      send(200, { ok: true, tunnelReady: await pool.online(owner) });
      return;
    }
    const entry = await service.identify(authorization);
    if (req.method === "GET" && req.url === "/state") {
      send(200, {
        snapshot: service.snapshot(entry),
        activeAttempts: store.readActiveBridgeAttempts(),
        diagnostics: boundary.diagnostics(),
      });
      return;
    }
    if (req.method === "POST" && req.url === "/enqueue") {
      await service.command(entry, {
        id: "crash-open-boss",
        command: "open",
        expectedVersion: service.snapshot(entry).version,
        args: { bossId: 7 },
      });
      await service.command(entry, {
        id: "crash-attack-job",
        command: "queue.enqueue",
        expectedVersion: service.snapshot(entry).version,
        args: {
          type: "battle.attack",
          action: { bossId: 7, battleId: "battle-1" },
        },
      });
      send(200, { accepted: true, snapshot: service.snapshot(entry) });
      return;
    }
    if (req.method === "POST" && req.url === "/cancel") {
      const snapshot = await service.command(entry, {
        id: "crash-local-cancel",
        command: "queue.cancel",
        expectedVersion: service.snapshot(entry).version,
        args: { id: "crash-attack-job" },
      });
      send(200, { snapshot });
      return;
    }
    send(404, { error: "not_found" });
  } catch (error) {
    send(500, { error: error?.code || error?.message || "actor_error" });
  }
});
server.on(
  "upgrade",
  (req, socket, head) => void gateway.upgrade(req, socket, head, "127.0.0.1"),
);
server.listen(Number(port), "127.0.0.1");
