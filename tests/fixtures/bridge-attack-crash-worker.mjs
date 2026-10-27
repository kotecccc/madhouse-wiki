import { appendFileSync, writeFileSync, writeSync } from "node:fs";
import { createAccountSnapshots } from "../../scripts/account/snapshots.mjs";
import { createAutomationService } from "../../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../../scripts/automation/state-store.mjs";

const directory = process.env.BRIDGE_CRASH_DIRECTORY;
const markerPath = process.env.BRIDGE_CRASH_MARKER;
const cargoLogPath = process.env.BRIDGE_CRASH_CARGO_LOG;
const mode = process.env.BRIDGE_CRASH_MODE;
const ownerId = "7654321";
const playerId = "101";
const deviceId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000003";
const authOperationId = "00000000-0000-4000-8000-000000000002";
const authorization = "Bearer bridge-test.payload.sig";
const now = 1_000_000;
let currentBattle = battle(20);
let service;
let blockResultCommit = false;

function battle(myDamage) {
  return {
    battleId: "battle-1",
    bossId: 7,
    status: "active",
    serverTimeUtc: new Date(now).toISOString(),
    cooldownUntilUtc: new Date(now).toISOString(),
    expiresAtUtc: new Date(now + 120_000).toISOString(),
    retryAfterMilliseconds: 0,
    playerHealth: 80,
    playerMaxHealth: 100,
    bossHealth: 80,
    bossMaxHealth: 100,
    myDamage,
    participantCount: 1,
    participants: [
      { playerId: Number(playerId), nickname: "Alice", damageDealt: myDamage },
    ],
    actions: [],
  };
}

function readyGameAuth(store) {
  store.bindVerifiedGameAccount(ownerId, playerId, now);
  store.selectRoutePolicy(playerId, {
    policy: "bridge_required",
    activeDeviceId: deviceId,
    expectedRouteEpoch: 0,
    updatedAt: now,
  });
  let record = {
    schemaVersion: 1,
    ownerId,
    playerId,
    operationId: authOperationId,
    authGeneration: 1,
    consentGeneration: 1,
    routeEpoch: 1,
    state: "created",
    expectedCredentialVersion: 0,
    credentialVersion: null,
    updatedAt: now,
  };
  store.startGameAuthRecovery(record);
  for (const state of [
    "launch_requested",
    "exchange_pending",
    "verification_pending",
  ]) {
    record = store.updateGameAuthRecovery(ownerId, authOperationId, {
      ...record,
      state,
      updatedAt: record.updatedAt + 1,
    });
  }
  record = store.updateGameAuthRecovery(ownerId, authOperationId, {
    ...record,
    state: "credential_stored",
    credentialVersion: 1,
    updatedAt: record.updatedAt + 1,
  });
  store.updateGameAuthRecovery(ownerId, authOperationId, {
    ...record,
    state: "ready",
    updatedAt: record.updatedAt + 1,
  });
  store.write(playerId, {
    credential: authorization,
    player: { playerId: Number(playerId), nickname: "Alice" },
  });
}

function signalReady(stage) {
  writeFileSync(markerPath, stage);
  writeSync(1, `READY:${stage}\n`);
}

function cargo(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const method = (init.method || "GET").toUpperCase();
  if (url.pathname === "/api/me")
    return Response.json({ playerId: Number(playerId), nickname: "Alice" });
  if (url.pathname === "/api/me/bag")
    return Response.json({ activityItems: [], combatItems: [] });
  if (url.pathname === "/api/combat")
    return Response.json({ activeBattle: null });
  if (url.pathname === "/api/bosses/7" && method === "GET")
    return Response.json({
      id: 7,
      damageMax: 10,
      activeBattle: currentBattle,
      state: { canStartFight: false },
    });
  if (url.pathname === "/api/bosses/battles/battle-1" && method === "GET")
    return Response.json(currentBattle);
  if (
    url.pathname === "/api/bosses/battles/battle-1/attack" &&
    method === "POST"
  ) {
    appendFileSync(cargoLogPath, "POST /api/bosses/battles/battle-1/attack\n");
    currentBattle = battle(currentBattle.myDamage + 12);
    if (mode === "in-flight") {
      signalReady("cargo_applied_before_reply");
      return new Promise(() => {});
    }
    blockResultCommit = true;
    return Response.json({ battle: currentBattle, hits: [] });
  }
  return Response.json({});
}

if (
  !directory ||
  !markerPath ||
  !cargoLogPath ||
  !["admission", "in-flight", "response"].includes(mode)
)
  throw new Error("bridge_crash_fixture_arguments_invalid");

const store = createAutomationStateStore({ directory });
readyGameAuth(store);
const writeIfVersion = store.writeIfVersion.bind(store);
store.writeIfVersion = (account, expectedVersion, value) => {
  if (
    mode === "response" &&
    blockResultCommit &&
    account === playerId &&
    value?.assistant?.pending === null
  ) {
    signalReady("response_before_result_commit");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
  return writeIfVersion(account, expectedVersion, value);
};

const snapshots = createAccountSnapshots({
  store,
  now: () => now,
  fetcher: async () => {
    throw new Error("bridge_required_route_attempted_direct_fallback");
  },
  bridgeTransport: async ({
    route,
    upstreamPath,
    search,
    method,
    headers,
    body,
    admission,
  }) => {
    if (route.policy !== "bridge_required")
      throw new Error("bridge_required_route_missing");
    if (admission) {
      if (
        !service.bindGameMutationConnection({
          admission,
          connectionId,
          route,
        })
      )
        throw new Error("mutation_connection_binding_rejected");
      if (mode === "admission") {
        signalReady("admission_before_http_dispatch");
        await new Promise(() => {});
      }
    }
    const response = cargo(
      `https://cargohustle.online${upstreamPath}${search}`,
      {
        method,
        headers: Object.fromEntries(headers),
        ...(body == null ? {} : { body }),
      },
    );
    return response;
  },
  admitMutation: (request) => service?.admitGameMutation(request) ?? null,
});

service = createAutomationService({
  store,
  getBoss: (id) => ({ numericId: id, name: "Boss" }),
  fetcher: snapshots.liveFetch,
  snapshotFetch: snapshots.fetch,
  accountHealth: snapshots.health,
  identifyPlayer: async (token) => {
    const response = await snapshots.verifyIdentity(token);
    if (!response.ok) throw new Error("identity_unavailable");
    return response.json();
  },
  now: () => now,
  random: () => 0,
});

const entry = await service.identify(authorization);
async function execute(command, args = {}) {
  const admission = service.issueCommandTicket(entry, {
    command,
    expectedVersion: service.snapshot(entry).version,
    args,
  });
  return service.command(entry, {
    id: admission.id,
    admissionTicket: admission.ticket,
    expectedVersion: admission.intentVersion,
    command,
    args,
  });
}

await execute("open", { bossId: 7 });
await execute("attack");

throw new Error("bridge_crash_fixture_did_not_reach_crash_window");
