import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createDirectBoundary } from "../scripts/game/direct-boundary.mjs";

const tokens = [
  "Bearer priority.player101.signature",
  "Bearer priority.player202.signature",
  "Bearer priority.player303.signature",
];
const players = new Map(
  tokens.map((token, index) => [token, 101 + index * 101]),
);

function response(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function battle(id = "manual-battle") {
  const now = Date.now();
  return {
    battleId: id,
    bossId: 7,
    status: "active",
    serverTimeUtc: new Date(now).toISOString(),
    cooldownUntilUtc: new Date(now).toISOString(),
    expiresAtUtc: new Date(now + 120_000).toISOString(),
    retryAfterMilliseconds: 0,
    playerHealth: 100,
    playerMaxHealth: 100,
    bossHealth: 100,
    bossMaxHealth: 100,
    myDamage: 0,
    participants: [{ playerId: 101, nickname: "Player", damageDealt: 0 }],
    actions: [],
    reward: { drops: [] },
  };
}

async function until(predicate, label) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("manual battle urgency reaches the physical scheduler without interrupting work or trusting request data", async () => {
  const directory = mkdtempSync(join(tmpdir(), "manual-priority-direct-"));
  const store = createAutomationStateStore({ directory });
  const physical = [];
  let heldToken = null;
  let releaseHeld;
  let heldEntered;
  const heldStarted = new Promise((resolve) => (heldEntered = resolve));
  const heldGate = new Promise((resolve) => (releaseHeld = resolve));
  const executor = createDirectBoundary({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "50",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
      MADHOUSE_GAME_DEVICE_INTERVAL_MS: "1",
      MADHOUSE_GAME_DIRECT_CONCURRENCY: "1",
    },
    resolvePlayer: (authorization) => players.get(authorization) ?? null,
    fetcher: async (url, init = {}) => {
      const parsed = new URL(url);
      const authorization = new Headers(init.headers).get("authorization");
      const playerId = players.get(authorization);
      const method = String(init.method || "GET").toUpperCase();
      const call = { playerId, method, path: parsed.pathname, init };
      physical.push(call);
      if (
        heldToken === authorization &&
        parsed.pathname === "/api/bosses/7" &&
        method === "GET"
      ) {
        heldToken = null;
        heldEntered();
        await heldGate;
      }
      if (parsed.pathname === "/api/bosses/7/battles" && method === "POST")
        return response({ battle: battle() });
      if (parsed.pathname === "/api/bosses/battles/manual-battle")
        return response(battle());
      if (parsed.pathname === "/api/bosses/7")
        return response({
          id: 7,
          damageMax: 10,
          activeBattle: null,
          state: { canStartFight: true },
        });
      if (parsed.pathname === "/api/combat")
        return response({ activeBattle: null });
      if (parsed.pathname === "/api/bosses/invitations")
        return response({ items: [] });
      return response({});
    },
  });
  const service = createAutomationService({
    store,
    getBoss: (id) => ({ numericId: id, name: "Boss", possibleDrops: [] }),
    fetcher: (url, init) => executor.request(url, init, "automation"),
    verifyQueuedCredential: async (authorization) => ({
      playerId: players.get(authorization),
      nickname: "Player",
    }),
    identifyPlayer: async (authorization) => ({
      playerId: players.get(authorization),
      nickname: "Player",
    }),
    schedule: () => ({ unref() {} }),
    cancel: () => {},
  });

  try {
    const entries = [];
    for (const token of tokens) {
      const entry = await service.identifyForQueue(token);
      await entry.controller.open({ numericId: 7, name: "Boss" });
      entries.push(entry);
    }
    physical.length = 0;

    heldToken = tokens[2];
    const alreadyRunning = entries[2].controller.refresh({ discover: true });
    await heldStarted;
    const runningCall = physical.at(-1);
    assert.equal(runningCall.playerId, 303);
    assert.equal(executor.diagnostics().activeDirect, 1);

    const background = entries[1].controller.refresh({ discover: true });
    await until(
      () => executor.diagnostics().queued >= 1,
      "background request queued",
    );

    const manualEntry = entries[0];
    const manualCommand = {
      id: "manual-priority-enqueue",
      command: "queue.enqueue",
      expectedVersion: service.snapshot(manualEntry).version,
      args: { type: "battle.start", action: { bossId: 7 } },
    };
    await service.command(manualEntry, manualCommand);
    const manualExecution = manualEntry.actionQueue.tick();
    await until(
      () => executor.diagnostics().queued >= 2,
      "manual preflight queued",
    );

    assert.equal(
      physical.length,
      1,
      "queued urgency must not interrupt the running operation",
    );
    assert.equal(runningCall.init.signal?.aborted, false);
    assert.equal(
      physical.filter(
        (call) =>
          call.path === "/api/bosses/7/battles" && call.method === "POST",
      ).length,
      0,
      "the mutation must wait for the current physical request",
    );

    releaseHeld();
    await until(
      () =>
        physical.some(
          (call) =>
            call.path === "/api/bosses/7/battles" && call.method === "POST",
        ),
      "manual mutation dispatched",
    );
    await Promise.all([alreadyRunning, background, manualExecution]);

    const operationOrder = physical.map(
      ({ playerId, method, path }) => `${playerId}:${method}:${path}`,
    );
    const manualMutationIndex = operationOrder.indexOf(
      "101:POST:/api/bosses/7/battles",
    );
    const backgroundReadIndex = operationOrder.indexOf("202:GET:/api/bosses/7");
    assert.ok(manualMutationIndex > 0);
    assert.ok(
      backgroundReadIndex > manualMutationIndex,
      operationOrder.join("\n"),
    );
    assert.equal(
      physical.filter(
        (call) =>
          call.path === "/api/bosses/7/battles" && call.method === "POST",
      ).length,
      1,
      "the manual action must submit one mutation",
    );

    const mutation = physical.find(
      (call) => call.path === "/api/bosses/7/battles" && call.method === "POST",
    );
    const headers = new Headers(mutation.init.headers);
    assert.equal(headers.has("x-priority"), false);
    assert.deepEqual(JSON.parse(mutation.init.body), {
      operationId: JSON.parse(mutation.init.body).operationId,
    });
    assert.equal(Object.hasOwn(manualCommand.args, "priority"), false);
  } finally {
    releaseHeld();
    service.close();
    executor.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
