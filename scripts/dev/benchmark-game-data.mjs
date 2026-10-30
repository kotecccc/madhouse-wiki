// Deterministic fake comparison against the review revision. No live traffic.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createAccountSnapshots } from "../account/snapshots.mjs";
import { createAccountDataService } from "../account/data-service.mjs";
import { createBridgeAccountService } from "../bridge/account-service.mjs";
import { createBridgeAwareAccountFetch } from "../bridge/bridge-aware-fetch.mjs";
import { createSessionApi } from "../../shared/session-api.js";
import { createAutomationService } from "../automation/service.mjs";
import { createAutomationHttp } from "../automation/http.mjs";
import { createAutomationStateStore } from "../automation/state-store.mjs";

const baseline = "636a71e4";
const files = [
  "package.json",
  "shared/session-api.js",
  "shared/auth-session.js",
  "shared/game-health-warning.js",
  "shared/game-health-features.js",
  "shared/telegram-context.js",
  "shared/active-boss-battle.js",
  "scripts/account/snapshots.mjs",
  "scripts/automation/inventory-actions.mjs",
  "scripts/bridge/bridge-aware-fetch.mjs",
  "scripts/bridge/account-service.mjs",
  "scripts/bridge/game-router.mjs",
  "scripts/bridge/profile-client.mjs",
  "scripts/bridge/game-read-paths.mjs",
  "scripts/bridge/tls-duplex-connector.mjs",
];
const directory = mkdtempSync(join(tmpdir(), "madhouse-data-benchmark-"));
try {
  for (const file of files) {
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, execFileSync("git", ["show", `${baseline}:${file}`]));
  }
  const load = (path) => import(pathToFileURL(join(directory, path)).href);
  const oldSnapshots = await load("scripts/account/snapshots.mjs");
  const oldBridge = await load("scripts/bridge/bridge-aware-fetch.mjs");
  const oldAccount = await load("scripts/bridge/account-service.mjs");
  const oldSession = await load("shared/session-api.js");
  const before = await measure({
    snapshotsFactory: oldSnapshots.createAccountSnapshots,
    bridgeFactory: oldBridge.createBridgeAwareAccountFetch,
    accountFactory: oldAccount.createBridgeAccountService,
    sessionFactory: oldSession.createSessionApi,
  });
  const after = await measure({
    snapshotsFactory: createAccountSnapshots,
    bridgeFactory: createBridgeAwareAccountFetch,
    accountFactory: createBridgeAccountService,
    sessionFactory: createSessionApi,
    dataFactory: createAccountDataService,
  });
  console.log(
    JSON.stringify(
      {
        baseline,
        scenario: "controlled bridge resource and stalled read",
        before,
        after,
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

async function measure({
  snapshotsFactory,
  bridgeFactory,
  accountFactory,
  sessionFactory,
  dataFactory,
}) {
  let clock = 1000;
  let gameRequests = 0;
  const records = new Map();
  const store = {
    readSnapshots: () =>
      [...records.values()].map((value) => structuredClone(value)),
    writeSnapshot: (id, value) =>
      records.set(String(id), structuredClone(value)),
    list: () => [],
  };
  const token = "Bearer benchmark-token";
  const owner = "101";
  const deviceId = "00000000-0000-4000-8000-000000000001";
  const path = "/api/me/bag";
  const url = `https://cargohustle.online${path}`;
  const snapshots = snapshotsFactory({ store, now: () => clock, ttl: 100 });
  snapshots.saveBridgeProfile(token, { playerId: 42, telegramId: 101 });
  const ticket = snapshots.beginBridgeObservation(token, path, {
    verifiedPlayerId: 42,
  });
  if (!snapshots.commitBridgeObservation(ticket, [{ id: 7 }]))
    throw new Error("seed failed");
  const accounts = {
    resolveCredential: (value) =>
      value === token
        ? {
            policy: "bridge_required",
            owner,
            epoch: 1,
            credentialCurrent: true,
          }
        : null,
    read: () => ({ authorization: token, playerId: "42", revision: 1 }),
    getRevision: () => 1,
  };
  const devices = {
    listDevice: () => ({ deviceId, generation: 1 }),
    open: async () => ({}),
  };
  const registry = { ownerKey: (value) => value, isActive: () => true };
  const accountService = accountFactory({
    accounts,
    devices,
    registry,
    readProfile: async () => {
      throw new Error("unexpected profile read");
    },
    readGame: async ({ openTunnel, validateTunnel }) => {
      await openTunnel();
      if (!(await validateTunnel())) throw new Error("invalid fake route");
      gameRequests++;
      await new Promise((resolve) => setImmediate(resolve));
      clock += 25;
      return { status: 200, body: Buffer.from('[{"id":7}]') };
    },
  });
  const directRoutes = {
    resolve: () => null,
    registerVerifiedDirect() {},
    withDirectLease() {
      throw new Error("unexpected direct route");
    },
  };
  const boundary = bridgeFactory({
    snapshots,
    accounts,
    directRoutes,
    accountService,
  });
  const events = [];
  const data = dataFactory
    ? dataFactory({
        transport: boundary,
        snapshots,
        now: () => clock,
        onDiagnostic: (event) => events.push(event),
      })
    : boundary;
  const headers = { Authorization: token };
  const snapshotStart = clock;
  const stored = await data.fetch(url, {
    headers: { ...headers, "X-Madhouse-Snapshot-Only": "1" },
  });
  if (!stored.ok) throw new Error("stored display failed");
  const snapshotMs = clock - snapshotStart;
  const beforeOrdinary = gameRequests;
  await data.fetch(url, { headers });
  const cacheHits = 1 + Number(gameRequests === beforeOrdinary);
  clock += 101;
  const responses = await Promise.all([
    data.fetch(url, { headers }),
    data.fetch(url, { headers }),
  ]);
  const statuses = responses.map((response) => response.status);
  const commandAcceptanceMs = await commandLatency(sessionFactory);
  return {
    gameRequests,
    cacheHits,
    joinedReads: events.filter((event) => event.cache === "joined").length,
    snapshotMs,
    commandAcceptanceMs,
    concurrentStatuses: statuses,
  };
}

async function commandLatency(factory) {
  let clock = 1_000_000;
  const start = clock;
  let release;
  let acceptedAt = null;
  const directory = mkdtempSync(join(tmpdir(), "madhouse-command-benchmark-"));
  const store = createAutomationStateStore({ directory });
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id, name: "Fake boss" }),
    identifyPlayer: async () => ({ playerId: 1 }),
    fetcher: async () => {
      throw new Error("unexpected game request");
    },
    now: () => clock,
    schedule: () => ({}),
    cancel: () => {},
  });
  const entry = await service.identify("Bearer fake");
  const http = createAutomationHttp({ service });
  const api = factory({
    now: () => clock,
    pause: async (delay) => {
      clock += delay;
    },
    authorize: (request) => ({
      ...request,
      headers: { Authorization: "Bearer fake" },
    }),
    fetcher: async (path, options) => {
      if (path === "/api/me")
        await new Promise((resolve) => {
          release = resolve;
        });
      else {
        const response = await http(
          new Request(`https://wiki.test${path}`, options),
        );
        if (!response.ok)
          throw new Error(`fake command failed: ${response.status}`);
        acceptedAt = clock;
        return response;
      }
      return Response.json({ playerId: 1 });
    },
  });
  const read = api.get("/api/me", { fresh: true });
  await new Promise((resolve) => setImmediate(resolve));
  const command = api.post("/api/automation/commands", {
    id: "benchmark-command-1",
    command: "queue.enqueue",
    expectedVersion: service.snapshot(entry).version,
    args: {
      type: "auto.start",
      action: {
        settings: {
          bossId: 7,
          kind: "battles",
          targetCount: 1,
          durationHours: null,
        },
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  clock = start + 4000;
  release();
  try {
    await Promise.all([read, command]);
    return acceptedAt - start;
  } finally {
    api.clear();
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}
