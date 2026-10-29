import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationService } from "../../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../../scripts/automation/state-store.mjs";
import { createBridgeAccountService } from "../../scripts/bridge/account-service.mjs";
import { createBridgeAwareAccountFetch } from "../../scripts/bridge/bridge-aware-fetch.mjs";
import { createQueueActionGate } from "../../scripts/bridge/queue-action-gate.mjs";
import { createDirectBoundary } from "../../scripts/game/direct-boundary.mjs";

const authorization = "Bearer recovery.actor.fake";
const deviceId = "00000000-0000-4000-8000-000000000001";
const owner = "owner-1";
const battleId = "battle-1";
const boundaryEnv = {
  MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
  MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
  MADHOUSE_GAME_DEVICE_INTERVAL_MS: "1",
};

function battle(status = "active", myDamage = 10) {
  const now = Date.now();
  return {
    battleId,
    bossId: 7,
    status,
    serverTimeUtc: new Date(now).toISOString(),
    cooldownUntilUtc: new Date(now - 5000).toISOString(),
    expiresAtUtc: new Date(now + 120_000).toISOString(),
    retryAfterMilliseconds: 0,
    playerHealth: 100,
    playerMaxHealth: 100,
    bossHealth: 90,
    bossMaxHealth: 100,
    myDamage,
    participantCount: 1,
    participants: [{ playerId: 101, nickname: "Fake" }],
    actions: [],
    reward: { drops: [] },
  };
}

function makeBridge({
  store,
  boundary,
  gate,
  mutationCounter,
  readCounter,
  readPaths,
  now,
}) {
  const accounts = {
    resolveCredential(value) {
      return value === authorization
        ? {
            policy: "bridge_required",
            owner,
            epoch: 1,
            credentialCurrent: true,
          }
        : null;
    },
    read(value) {
      return value === owner
        ? { authorization, playerId: "101", revision: 1 }
        : null;
    },
    getRevision(value) {
      return value === owner ? 1 : 0;
    },
  };
  const devices = {
    listDevice(value) {
      return value === owner ? { deviceId, generation: 1 } : null;
    },
    async open(value) {
      assert.equal(value, owner);
      return {};
    },
  };
  const registry = {
    ownerKey: (value) => value,
    isActive: (identity) =>
      identity.owner === owner &&
      identity.device === deviceId &&
      identity.generation === 1,
  };
  const readGame = async ({ path, openTunnel, validateTunnel }) => {
    await openTunnel();
    assert.equal(await validateTunnel(), true);
    readCounter.count++;
    readPaths.push(path);
    if (path === "/api/bosses/7")
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({
            id: 7,
            damageMax: 10,
            activeBattle: battle(),
            state: { canStartFight: false },
          }),
        ),
      };
    if (path === `/api/bosses/battles/${battleId}`)
      return { status: 200, body: Buffer.from(JSON.stringify(battle())) };
    if (path === "/api/combat")
      return {
        status: 200,
        body: Buffer.from(JSON.stringify({ activeBattle: null })),
      };
    if (path === "/api/bosses/invitations")
      return { status: 200, body: Buffer.from(JSON.stringify({ items: [] })) };
    if (path === "/api/me/bag")
      return {
        status: 200,
        body: Buffer.from(
          JSON.stringify({ activityItems: [], consumables: [] }),
        ),
      };
    throw new Error(`unexpected fake bridge read: ${path}`);
  };
  const accountService = createBridgeAccountService({
    accounts,
    devices,
    registry,
    queueActionGate: gate,
    coordinate: (attempt) => boundary.bridge(attempt),
    readProfile: async () => ({
      status: 200,
      body: Buffer.from(JSON.stringify({ playerId: 101, telegramId: owner })),
    }),
    readGame,
    sendAction: async ({ validateTunnel, onTransportStopped }) => {
      assert.equal(await validateTunnel(), true);
      mutationCounter.count++;
      onTransportStopped();
      throw new TypeError("fake bridge reply lost after transport stopped");
    },
  });
  const snapshots = {
    identity: () => ({ playerId: 101 }),
    routingIdentity: () => ({ playerId: 101 }),
    fetch: async () => Response.json({}),
    liveFetch: async () => Response.json({}),
  };
  const directRoutes = {
    resolve: () => null,
    registerVerifiedDirect() {
      throw new Error("direct route must not be registered");
    },
    withDirectLease() {
      throw new Error("direct route must not be selected");
    },
  };
  const transport = createBridgeAwareAccountFetch({
    snapshots,
    accounts,
    directRoutes,
    accountService,
    canonicalCredential: (value) => value,
  });
  const service = createAutomationService({
    store,
    queueActionGate: gate,
    identifyPlayer: async () => ({ playerId: 101 }),
    getBoss: (id) => ({ numericId: id, name: "Fake boss", possibleDrops: [] }),
    fetcher: (url, init) => transport.liveFetch(url, init),
    snapshotFetch: (url, init) => transport.fetch(url, init),
    schedule: (callback, delay) => setTimeout(callback, delay),
    cancel: clearTimeout,
    random: () => 0,
    ...(now ? { now } : {}),
  });
  return { service, transport };
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("server actor reconciles a stopped uncertain bridge attack after restart without replay", async () => {
  const directory = mkdtempSync(join(tmpdir(), "automation-actor-recovery-"));
  let store = createAutomationStateStore({ directory });
  let boundary = createDirectBoundary({
    env: boundaryEnv,
    requireBridgeJournal: true,
  });
  boundary.installBridgeStore(store);
  let gate = createQueueActionGate();
  const mutationCounter = { count: 0 };
  const readCounter = { count: 0 };
  const readPaths = [];
  let nowOffset = 0;
  const now = () => Date.now() + nowOffset;
  let { service } = makeBridge({
    store,
    boundary,
    gate,
    mutationCounter,
    readCounter,
    readPaths,
    now,
  });
  let restarted = null;
  try {
    const entry = await service.identify(authorization);
    await service.command(entry, {
      id: "open-recovery-boss",
      command: "open",
      expectedVersion: service.snapshot(entry).version,
      args: { bossId: 7 },
    });
    await service.boot();
    await service.command(entry, {
      id: "queue-recovery-attack",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(entry).version,
      args: {
        type: "battle.attack",
        action: { bossId: 7, battleId },
      },
    });
    await waitFor(
      () => service.snapshot(entry).queuedActions[0]?.status === "reconciling",
      `actor did not persist the uncertain queued attack: ${JSON.stringify(service.snapshot(entry))}`,
    );
    const saved = store.read("101");
    assert.equal(saved.manualBattle.pending.id, "queue-recovery-attack");
    assert.equal(saved.queuedActions[0].status, "reconciling");
    const attempt = store.readActiveBridgeAttempts();
    assert.equal(attempt.length, 1);
    assert.equal(attempt[0].phase, "uncertain");
    assert.ok(attempt[0].transportStoppedAt);
    assert.equal(mutationCounter.count, 1);

    service.close();
    service = null;
    boundary.close();
    store.close();
    nowOffset = 20_000;
    store = createAutomationStateStore({ directory });
    boundary = createDirectBoundary({
      env: boundaryEnv,
      requireBridgeJournal: true,
    });
    boundary.installBridgeStore(store);
    gate = createQueueActionGate();
    ({ service: restarted } = makeBridge({
      store,
      boundary,
      gate,
      mutationCounter,
      readCounter,
      readPaths,
      now,
    }));
    const readsBefore = readCounter.count;
    await restarted.boot();
    await waitFor(
      () => readCounter.count > readsBefore,
      "restored actor did not issue its checkpoint-scoped bridge read",
    );
    const restoredEntry = await restarted.readStored(authorization);
    assert.ok(
      readPaths.slice(readsBefore).includes(`/api/bosses/battles/${battleId}`),
    );
    assert.equal(mutationCounter.count, 1);
    assert.equal(
      restarted.snapshot(restoredEntry).queuedActions[0].status,
      "reconciling",
    );
    assert.equal(
      store.read("101").manualBattle.pending.id,
      "queue-recovery-attack",
    );
    assert.equal(store.readActiveBridgeAttempts().length, 1);
    await restarted.command(restoredEntry, {
      id: "cancel-uncertain-attack",
      command: "queue.cancel",
      expectedVersion: restarted.snapshot(restoredEntry).version,
      args: { id: "queue-recovery-attack" },
    });
    assert.equal(store.read("101").queuedActions[0].cancelRequested, true);
    assert.equal(mutationCounter.count, 1);
    restarted.close();
    restarted = null;
    boundary.close();
    store.close();
    store = createAutomationStateStore({ directory });
    boundary = createDirectBoundary({ requireBridgeJournal: true });
    boundary.installBridgeStore(store);
    assert.equal(store.read("101").queuedActions[0].cancelRequested, true);
    assert.equal(store.readActiveBridgeAttempts().length, 1);
  } finally {
    restarted?.close();
    if (service && service !== restarted) service.close();
    boundary.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
