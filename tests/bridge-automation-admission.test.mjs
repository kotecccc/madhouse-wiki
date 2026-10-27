import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { connect as connectTls } from "node:tls";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import {
  createGameApiTunnelTransport,
  MAX_GAME_RESPONSE_BODY_BYTES,
} from "../scripts/bridge/game-api-transport.mjs";
import { createFakeCargo } from "./bridge/fake-cargo.mjs";

const ownerId = "7654321";
const playerId = "101";
const deviceId = "00000000-0000-4000-8000-000000000001";
const connectionId = "00000000-0000-4000-8000-000000000003";
const authOperationId = "00000000-0000-4000-8000-000000000002";
const renewedAuthOperationId = "00000000-0000-4000-8000-000000000005";
const authorization = "Bearer bridge-test.payload.sig";
const now = 1_000_000;

function battle(myDamage = 20) {
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

function completeFakeCredentialRenewal(store, timestamp) {
  const previous = store.readGameAuthRecovery(ownerId);
  let updatedAt = Math.max(timestamp, previous.updatedAt);
  let record = {
    ...previous,
    operationId: renewedAuthOperationId,
    authGeneration: previous.authGeneration + 1,
    consentGeneration: previous.consentGeneration + 1,
    expectedCredentialVersion: previous.credentialVersion,
    credentialVersion: null,
    state: "created",
    updatedAt: ++updatedAt,
  };
  store.startGameAuthRecovery(record, { expectedCurrent: previous });
  for (const state of [
    "launch_requested",
    "exchange_pending",
    "verification_pending",
  ]) {
    record = store.updateGameAuthRecovery(ownerId, renewedAuthOperationId, {
      ...record,
      state,
      updatedAt: ++updatedAt,
    });
  }
  record = store.updateGameAuthRecovery(ownerId, renewedAuthOperationId, {
    ...record,
    state: "credential_stored",
    credentialVersion: previous.credentialVersion + 1,
    updatedAt: ++updatedAt,
  });
  return store.updateGameAuthRecovery(ownerId, renewedAuthOperationId, {
    ...record,
    state: "ready",
    updatedAt: updatedAt + 1,
  });
}

function command(id, name, expectedVersion, args = {}) {
  return { id, command: name, expectedVersion, args };
}

class SocketDuplex extends Duplex {
  constructor(socket) {
    super();
    this.socket = socket;
    socket.on("data", (chunk) => {
      if (!this.push(chunk)) socket.pause();
    });
    socket.once("end", () => this.push(null));
    socket.once("error", (error) => this.destroy(error));
    socket.once("close", () => {
      if (!this.destroyed && !this.readableEnded) this.push(null);
    });
  }

  _read() {
    this.socket.resume();
  }

  _write(chunk, encoding, callback) {
    this.socket.write(chunk, encoding, callback);
  }

  _final(callback) {
    this.socket.end(callback);
  }

  _destroy(error, callback) {
    this.socket.destroy();
    callback(error);
  }
}

test("real TLS response failures keep applied attacks unknown until reconciliation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-tls-actor-overflow-"));
  const store = createAutomationStateStore({ directory });
  readyGameAuth(store);
  const cargoCertificate = await readFile(
    new URL("./bridge/fixtures/cargo-cert.pem", import.meta.url),
  );
  const cargoKey = await readFile(
    new URL("./bridge/fixtures/cargo-key.pem", import.meta.url),
  );
  const oversizedReply = gzipSync(
    Buffer.alloc(MAX_GAME_RESPONSE_BODY_BYTES + 1, 0x61),
  );
  let currentBattle = battle();
  let attackResponseMode = "gzip-overflow";
  let attackCount = 0;
  const attackDispatches = [];
  let directCount = 0;
  let service;
  const cargo = createFakeCargo({
    certificate: cargoCertificate,
    privateKey: cargoKey,
    onRequest: async (request, response) => {
      const pathname = new URL(request.path, "https://cargohustle.online")
        .pathname;
      if (pathname === "/api/me") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ playerId: Number(playerId), nickname: "Alice" }),
        );
        return;
      }
      if (pathname === "/api/me/bag") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ activityItems: [], combatItems: [] }));
        return;
      }
      if (pathname === "/api/bosses/invitations") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ items: [] }));
        return;
      }
      if (pathname === "/api/combat") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ activeBattle: null }));
        return;
      }
      if (pathname === "/api/bosses/7") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: 7,
            damageMax: 10,
            activeBattle: currentBattle,
            state: { canStartFight: false },
          }),
        );
        return;
      }
      if (pathname === "/api/bosses/battles/battle-1/attack") {
        attackCount += 1;
        attackDispatches.push({
          method: request.method,
          body: request.body.toString("utf8"),
          pending: store.read(playerId)?.assistant?.pending ?? null,
        });
        currentBattle = battle(currentBattle.myDamage + 12);
        if (attackResponseMode === "connection-reset") {
          response.socket.destroy();
          return;
        }
        if (attackResponseMode === "incomplete-headers") {
          response.socket.end("HTTP/1.1 200 OK\r\nContent-Length: ");
          return;
        }
        if (attackResponseMode === "gzip-overflow") {
          response.writeHead(200, {
            "content-encoding": "gzip",
            "content-type": "application/json",
            "content-length": String(oversizedReply.byteLength),
          });
          response.end(oversizedReply);
          return;
        }
        if (attackResponseMode === "partial-body") {
          response.socket.end(
            'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 256\r\n\r\n{"battle":',
          );
          return;
        }
        if (attackResponseMode === "no-content-204") {
          response.writeHead(204);
          response.end();
          return;
        }
        const redirectStatuses = {
          "redirect-301": 301,
          "redirect-302": 302,
          "redirect-303": 303,
          "redirect-307": 307,
          "redirect-308": 308,
        };
        if (Object.hasOwn(redirectStatuses, attackResponseMode)) {
          response.writeHead(redirectStatuses[attackResponseMode], {
            location:
              "https://cargohustle.online/api/bosses/battles/battle-1/attack",
          });
          response.end();
          return;
        }
        const statusByMode = {
          "http-400": 400,
          "http-401": 401,
          "http-403": 403,
          "http-404": 404,
          "http-502": 502,
          "http-503": 503,
          "http-504": 504,
          "http-500": 500,
          "accepted-202": 202,
          "partial-content-206": 206,
          "rate-limit-429": 429,
        };
        const headers =
          attackResponseMode === "rate-limit-429" ? { "retry-after": "2" } : {};
        response.writeHead(statusByMode[attackResponseMode], {
          "content-type": "application/json",
          ...headers,
        });
        response.end(JSON.stringify({ battle: currentBattle, hits: [] }));
        return;
      }
      if (pathname === "/api/bosses/battles/battle-1") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(currentBattle));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    },
  });
  const port = await cargo.listen();
  const bridgeTransport = createGameApiTunnelTransport({
    openStream: async () => {
      const tunnel = new SocketDuplex(
        createConnection({ host: "127.0.0.1", port }),
      );
      tunnel.bridgeConnectionId = connectionId;
      return tunnel;
    },
    bindMutationConnection: ({ admission, connectionId: boundId, route }) =>
      service?.bindGameMutationConnection({
        admission,
        connectionId: boundId,
        route,
      }) ?? false,
    tlsConnect(options) {
      return connectTls({ ...options, ca: cargoCertificate });
    },
  });
  const snapshots = createAccountSnapshots({
    store,
    now: () => now,
    fetcher: async () => {
      directCount += 1;
      throw new Error("bridge-required route attempted direct fallback");
    },
    bridgeTransport,
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
    commandAdmissionTtlMs: 30_000,
  });
  const assertAttackDispatch = (index) => {
    const dispatch = attackDispatches[index];
    assert.equal(dispatch?.method, "POST");
    const body = JSON.parse(dispatch?.body || "{}");
    assert.equal(typeof body.operationId, "string");
    assert.equal(dispatch?.pending?.operationId, body.operationId);
    assert.equal(dispatch?.pending?.deliveryStatus, "dispatching");
    assert.equal(dispatch?.pending?.admission?.connectionId, connectionId);
  };
  const executeCommand = async (entry, input) => {
    const ticket = await service.issueCommandTicket(entry, {
      command: input.command,
      expectedVersion: input.expectedVersion,
      args: input.args ?? {},
    });
    return service.command(entry, {
      ...input,
      id: ticket.id,
      admissionTicket: ticket.ticket,
      expectedVersion: ticket.intentVersion,
    });
  };
  const responseCases = [
    ["gzip-overflow", "gzip-overflow"],
    ["connection-reset", "connection-reset"],
    ["incomplete-headers", "incomplete-headers"],
    ["partial-body", "partial-body"],
    ["http-400", "http-400"],
    ["http-401", "http-401"],
    ["http-403", "http-403"],
    ["http-404", "http-404"],
    ["http-502", "http-502"],
    ["http-503", "http-503"],
    ["http-504", "http-504"],
    ["http-500", "http-500"],
    ["accepted-202", "accepted-202"],
    ["partial-content-206", "partial-206"],
    ["rate-limit-429", "rate-limit-429"],
    ["redirect-301", "redirect-301"],
    ["redirect-302", "redirect-302"],
    ["redirect-303", "redirect-303"],
    ["redirect-307", "redirect-307"],
    ["redirect-308", "redirect-308"],
    ["no-content-204", "no-content-204"],
  ];

  try {
    const entry = await service.identify(authorization);
    await executeCommand(
      entry,
      command("tls-overflow-open", "open", service.snapshot(entry).version, {
        bossId: 7,
      }),
    );
    for (let index = 0; index < responseCases.length; index += 1) {
      const [mode, label] = responseCases[index];
      attackResponseMode = mode;
      const attackResult = await executeCommand(
        entry,
        command(
          `tls-${label}-attack`,
          "attack",
          service.snapshot(entry).version,
        ),
      );
      assert.equal(attackResult.battle.healing.uncertain, true);
      assert.equal(store.read(playerId)?.assistant?.pending?.kind, "attack");
      assert.equal(
        store.read(playerId)?.assistant?.pending?.deliveryStatus,
        "unknown",
      );
      assert.equal(attackCount, index + 1);
      assert.equal(
        cargo.requests.filter(({ method }) => method === "POST").length,
        index + 1,
      );
      assertAttackDispatch(index);

      await assert.rejects(
        executeCommand(
          entry,
          command(
            `tls-${label}-no-retry`,
            "attack",
            service.snapshot(entry).version,
          ),
        ),
        (error) =>
          error.status === 409 && error.message === "battle_action_unresolved",
      );
      assert.equal(attackCount, index + 1);

      const reconciled = await executeCommand(
        entry,
        command(
          `tls-${label}-reconcile`,
          "refresh",
          service.snapshot(entry).version,
        ),
      );
      assert.equal(reconciled.battle.healing.uncertain, false);
      assert.equal(store.read(playerId)?.assistant?.pending, null);
      assert.equal(currentBattle.myDamage, 20 + 12 * (index + 1));
      assert.equal(attackCount, index + 1);
      assert.equal(
        cargo.requests.filter(({ method }) => method === "POST").length,
        index + 1,
      );
    }
    assert.equal(directCount, 0);
  } finally {
    service.close();
    store.close();
    await cargo.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bridge admits only a persisted actor attack and keeps an unknown attempt after restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-attack-admission-"));
  let store = createAutomationStateStore({ directory });
  let leaseNow = now;
  let competingStore = null;
  let failAttackIntentWrite = false;
  const failPendingIntentWrites = (targetStore) => {
    const writeIfVersion = targetStore.writeIfVersion.bind(targetStore);
    targetStore.writeIfVersion = (account, expectedVersion, value) => {
      if (
        failAttackIntentWrite &&
        account === playerId &&
        value?.assistant?.pending?.kind === "attack" &&
        !value.assistant.pending.admission
      )
        throw new Error("simulated durable intent write failure");
      return writeIfVersion(account, expectedVersion, value);
    };
  };
  failPendingIntentWrites(store);
  readyGameAuth(store);
  let currentBattle = battle();
  let attackResponseMode = "lost";
  let staleNextBattleRead = false;
  let holdFirstAttackReply = true;
  let holdNextSuccessfulReply = false;
  let releaseFirstAttackReply;
  let releaseNextSuccessfulReply;
  let markAttackDispatched;
  const attackDispatched = new Promise((resolve) => {
    markAttackDispatched = resolve;
  });
  let markNextAttackDispatched;
  const nextAttackDispatched = new Promise((resolve) => {
    markNextAttackDispatched = resolve;
  });
  const cargoCalls = [];
  const admissionAttempts = [];
  const routedRequests = [];
  let attackCount = 0;
  let directCount = 0;
  let switchRouteBeforeConnectionBind = false;
  const cargo = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    cargoCalls.push({ method, path: url.pathname });
    if (url.pathname === "/api/me")
      return Response.json({ playerId: Number(playerId), nickname: "Alice" });
    if (url.pathname === "/api/me/bag")
      return Response.json({ activityItems: [], combatItems: [] });
    if (url.pathname === "/api/bosses/invitations")
      return Response.json({ items: [] });
    if (url.pathname === "/api/combat")
      return Response.json({ activeBattle: null });
    if (url.pathname === "/api/bosses/7" && method === "GET")
      return Response.json({
        id: 7,
        damageMax: 10,
        activeBattle: currentBattle,
        state: { canStartFight: false },
      });
    if (url.pathname === "/api/bosses/battles/battle-1" && method === "GET") {
      if (staleNextBattleRead) {
        staleNextBattleRead = false;
        return Response.json(battle(20));
      }
      return Response.json(currentBattle);
    }
    if (
      url.pathname === "/api/bosses/battles/battle-1/attack" &&
      method === "POST"
    ) {
      attackCount += 1;
      const saved = store.read(playerId);
      const pending = saved?.assistant?.pending;
      assert.equal(pending?.kind, "attack");
      assert.equal(pending?.operationId, JSON.parse(init.body).operationId);
      assert.equal(pending?.admission?.action, "boss.attack");
      assert.equal(pending?.admission?.routeEpoch, 1);
      assert.equal(pending?.admission?.deviceId, deviceId);
      assert.equal(pending?.admission?.connectionId, connectionId);
      assert.match(
        pending?.admission?.argumentsDigest || "",
        /^[0-9a-f]{64}$/u,
      );
      currentBattle = battle(currentBattle.myDamage + 12);
      if (holdFirstAttackReply) {
        holdFirstAttackReply = false;
        markAttackDispatched();
        return new Promise((_resolve, reject) => {
          releaseFirstAttackReply = () =>
            reject(
              new Error("bridge stream closed after Cargo applied attack"),
            );
        });
      }
      if (holdNextSuccessfulReply) {
        holdNextSuccessfulReply = false;
        markNextAttackDispatched();
        return new Promise((resolve) => {
          releaseNextSuccessfulReply = () =>
            resolve(Response.json({ battle: currentBattle, hits: [] }));
        });
      }
      if (attackResponseMode === "lost")
        throw new Error("bridge stream closed after Cargo applied attack");
      if (attackResponseMode === "http_500")
        return Response.json({ error: "cargo_failure" }, { status: 500 });
      if (attackResponseMode === "http_429_retry_after")
        return Response.json(
          { error: "rate_limited" },
          { status: 429, headers: { "Retry-After": "0" } },
        );
      if (attackResponseMode === "partial_200")
        return Response.json({
          battle: {
            battleId: currentBattle.battleId,
            bossId: currentBattle.bossId,
            myDamage: currentBattle.myDamage,
          },
          hits: [],
        });
      if (attackResponseMode === "empty_200")
        return new Response(null, { status: 200 });
      if (attackResponseMode === "invalid_json_200")
        return new Response("not-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      if (attackResponseMode === "no_content_204")
        return new Response(null, { status: 204 });
      if (attackResponseMode === "accepted_json_202")
        return Response.json(
          { battle: currentBattle, hits: [] },
          { status: 202 },
        );
      if (attackResponseMode === "partial_content_206")
        return Response.json(
          { battle: currentBattle, hits: [] },
          { status: 206 },
        );
      if (attackResponseMode === "redirect_307")
        return new Response(null, {
          status: 307,
          headers: {
            Location:
              "https://cargohustle.online/api/bosses/battles/battle-1/attack",
          },
        });
      if (attackResponseMode === "redirect_308")
        return new Response(null, {
          status: 308,
          headers: {
            Location:
              "https://cargohustle.online/api/bosses/battles/battle-1/attack",
          },
        });
      if (attackResponseMode === "truncated")
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"battle":'));
              controller.error(new Error("simulated truncated Cargo body"));
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      return Response.json({ battle: currentBattle, hits: [] });
    }
    return Response.json({});
  };

  const makeRuntime = () => {
    let service;
    const snapshots = createAccountSnapshots({
      store,
      now: () => now,
      fetcher: async () => {
        directCount += 1;
        throw new Error("bridge-required route attempted direct fallback");
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
        assert.equal(route.policy, "bridge_required");
        routedRequests.push({
          deviceId: route.activeDeviceId,
          method,
          path: upstreamPath,
        });
        if (admission) {
          if (switchRouteBeforeConnectionBind) {
            switchRouteBeforeConnectionBind = false;
            store.selectRoutePolicy(playerId, {
              policy: "direct",
              activeDeviceId: null,
              expectedRouteEpoch: 1,
              updatedAt: now + 1,
            });
            assert.equal(
              service.bindGameMutationConnection({
                admission,
                connectionId,
                route,
              }),
              false,
            );
            throw new Error("bridge route changed before HTTP dispatch");
          }
          assert.equal(
            service.bindGameMutationConnection({
              admission,
              connectionId,
              route,
            }),
            true,
          );
        }
        return cargo(`https://cargohustle.online${upstreamPath}${search}`, {
          method,
          headers: Object.fromEntries(headers),
          ...(body == null ? {} : { body }),
        });
      },
      admitMutation: (request) => {
        admissionAttempts.push({
          route: request.route,
          operation: request.operation,
          accountId: request.request?.context?.accountId,
          attempt: request.request?.context?.automationAttempt,
          pending: store.read(playerId)?.assistant?.pending,
          actorBattlePending: store.read(playerId)?.battle?.pending,
        });
        return service?.admitGameMutation(request) ?? null;
      },
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
      now: () => leaseNow,
      random: () => 0,
      commandAdmissionTtlMs: 30_000,
    });
    return { service, snapshots };
  };

  let runtime = makeRuntime();
  let activeStore = store;
  const prepareCommand = async (entry, input) => {
    const admission = await runtime.service.issueCommandTicket(entry, {
      command: input.command,
      expectedVersion: input.expectedVersion,
      args: input.args ?? {},
    });
    return {
      ...input,
      id: admission.id,
      admissionTicket: admission.ticket,
      expectedVersion: admission.intentVersion,
    };
  };
  const executeCommand = async (entry, input) => {
    if (input.command === "auto.stop")
      return runtime.service.command(entry, input);
    return runtime.service.command(entry, await prepareCommand(entry, input));
  };
  try {
    let entry = await runtime.service.identify(authorization);
    await assert.rejects(
      runtime.service.command(
        entry,
        command(
          "old-client-command",
          "attack",
          runtime.service.snapshot(entry).version,
        ),
      ),
      (error) =>
        error.status === 409 &&
        error.message === "automation_command_admission_required",
    );
    assert.equal(attackCount, 0);
    await executeCommand(
      entry,
      command("open-boss-01", "open", runtime.service.snapshot(entry).version, {
        bossId: 7,
      }),
    );

    failAttackIntentWrite = true;
    await assert.rejects(
      executeCommand(
        entry,
        command(
          "attack-intent-write-fails",
          "attack",
          runtime.service.snapshot(entry).version,
        ),
      ),
      (error) =>
        error.status === 503 &&
        error.message === "automation_storage_unavailable",
    );
    assert.equal(attackCount, 0);
    assert.equal(store.read(playerId).assistant.pending, null);
    failAttackIntentWrite = false;

    runtime.service.close();
    store.close();
    store = createAutomationStateStore({ directory });
    failPendingIntentWrites(store);
    activeStore = store;
    runtime = makeRuntime();
    entry = await runtime.service.identify(authorization);
    const originalAttackCommand = await prepareCommand(
      entry,
      command(
        "attack-once-01",
        "attack",
        runtime.service.snapshot(entry).version,
      ),
    );
    const attackRequest = runtime.service.command(entry, originalAttackCommand);
    await attackDispatched;
    await assert.rejects(
      executeCommand(
        entry,
        command(
          "goal-during-attack",
          "goal.configure",
          runtime.service.snapshot(entry).version,
          { bossId: 7, kind: "battles", targetCount: 2 },
        ),
      ),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
    assert.throws(
      () =>
        runtime.service.issueCommandTicket(entry, {
          command: "auto.start",
          expectedVersion: runtime.service.snapshot(entry).version,
          args: {},
        }),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
    assert.equal(attackCount, 1);
    await executeCommand(
      entry,
      command(
        "stop-in-flight-01",
        "auto.stop",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");
    leaseNow = now + 16_000;
    competingStore = createAutomationStateStore({ directory });
    assert.equal(
      competingStore.acquireLease("competing-worker", leaseNow, 15_000),
      true,
    );
    releaseFirstAttackReply();
    await assert.rejects(
      attackRequest,
      (error) =>
        error.status === 503 &&
        error.message === "automation_storage_unavailable",
    );
    assert.equal(attackCount, 1);
    assert.equal(admissionAttempts.length, 1);
    assert.equal(admissionAttempts[0].attempt.kind, "boss.attack");
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");

    runtime.service.close();
    store.close();
    assert.equal(competingStore.releaseLease("competing-worker"), true);
    competingStore.close();
    competingStore = null;
    store = createAutomationStateStore({ directory });
    activeStore = store;
    runtime = makeRuntime();
    entry = await runtime.service.identify(authorization);
    assert.equal(
      runtime.service.snapshot(entry).battle.healing.uncertain,
      true,
    );
    await assert.rejects(
      executeCommand(
        entry,
        command(
          "attack-after-restart",
          "attack",
          runtime.service.snapshot(entry).version,
        ),
      ),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
    assert.equal(attackCount, 1);
    await assert.rejects(
      executeCommand(
        entry,
        command(
          "attack-again-01",
          "attack",
          runtime.service.snapshot(entry).version,
        ),
      ),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
    await assert.rejects(
      executeCommand(
        entry,
        command(
          "goal-after-unknown",
          "goal.configure",
          runtime.service.snapshot(entry).version,
          { bossId: 7, kind: "battles", targetCount: 2 },
        ),
      ),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");
    assert.equal(
      runtime.service.snapshot(entry).battle.healing.uncertain,
      true,
    );

    let issuedReadCommands = 0;
    for (let index = 0; index < 130; index += 1) {
      try {
        await executeCommand(
          entry,
          command(
            `rotate-receipt-${String(index).padStart(3, "0")}`,
            "invitations.refresh",
            runtime.service.snapshot(entry).version,
          ),
        );
        issuedReadCommands += 1;
      } catch (error) {
        assert.equal(error.status, 429);
        assert.equal(error.message, "automation_command_admissions_full");
        break;
      }
    }
    assert.ok(issuedReadCommands > 0 && issuedReadCommands < 130);
    assert.equal(store.read(playerId).commandAdmissions.length, 128);
    assert.equal(store.read(playerId).receipts.length, 128);
    assert.equal(
      store.read(playerId).receipts.includes(originalAttackCommand.id),
      true,
    );
    assert.equal(
      store.read(playerId).pendingReceiptId,
      originalAttackCommand.id,
    );
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");
    assert.equal(attackCount, 1);
    await assert.rejects(
      runtime.service.command(entry, originalAttackCommand),
      (error) =>
        error.status === 409 &&
        error.message === "automation_command_already_received",
    );
    assert.equal(attackCount, 1);

    leaseNow = now + 31_000;
    await assert.rejects(
      runtime.service.command(entry, originalAttackCommand),
      (error) =>
        error.status === 409 &&
        error.message === "automation_command_admission_expired",
    );
    assert.equal(attackCount, 1);
    staleNextBattleRead = true;
    const stale = await executeCommand(
      entry,
      command(
        "reconcile-stale-01",
        "refresh",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(stale.battle.healing.uncertain, true);
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");
    const recovered = await executeCommand(
      entry,
      command(
        "reconcile-attack-01",
        "refresh",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(recovered.battle.healing.uncertain, false);
    assert.equal(attackCount, 1);
    assert.equal(store.read(playerId).pendingReceiptId, null);
    assert.equal(
      store.read(playerId).receipts.includes(originalAttackCommand.id),
      true,
    );

    leaseNow = now + 62_000;
    for (let index = 0; index < 128; index += 1)
      await executeCommand(
        entry,
        command(
          `expire-receipt-${String(index).padStart(3, "0")}`,
          "invitations.refresh",
          runtime.service.snapshot(entry).version,
        ),
      );
    assert.equal(store.read(playerId).receipts.length, 128);
    assert.equal(
      store.read(playerId).receipts.includes(originalAttackCommand.id),
      false,
    );
    await assert.rejects(
      runtime.service.command(entry, originalAttackCommand),
      (error) =>
        error.status === 409 &&
        error.message === "automation_command_admission_expired",
    );
    assert.throws(
      () =>
        runtime.service.issueCommandTicket(entry, {
          id: originalAttackCommand.id,
          command: "attack",
          expectedVersion: runtime.service.snapshot(entry).version,
          args: {},
        }),
      (error) =>
        error.status === 400 &&
        error.message === "automation_command_id_server_generated",
    );
    leaseNow = now + 93_000;
    const newAttackTicket = await runtime.service.issueCommandTicket(entry, {
      command: "attack",
      expectedVersion: runtime.service.snapshot(entry).version,
      args: {},
    });
    assert.notEqual(newAttackTicket.id, originalAttackCommand.id);
    assert.equal(attackCount, 1);
    assert.equal(directCount, 0);
    assert.equal(
      cargoCalls.filter(
        ({ method, path }) => method === "POST" && path.endsWith("/attack"),
      ).length,
      1,
    );
    const storedAdmission = store.read(playerId).assistant.pending;
    assert.equal(storedAdmission, null);

    attackResponseMode = "http_500";
    const failedResponse = await executeCommand(
      entry,
      command(
        "attack-http500-after-apply",
        "attack",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(failedResponse.battle.healing.uncertain, true);
    assert.equal(attackCount, 2);
    await assert.rejects(
      executeCommand(
        entry,
        command(
          "attack-http500-no-retry",
          "attack",
          runtime.service.snapshot(entry).version,
        ),
      ),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
    const http500Recovered = await executeCommand(
      entry,
      command(
        "reconcile-http500-apply",
        "refresh",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(http500Recovered.battle.healing.uncertain, false);
    assert.equal(attackCount, 2);

    attackResponseMode = "partial_200";
    const partialResponse = await executeCommand(
      entry,
      command(
        "attack-partial-200-after-apply",
        "attack",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(partialResponse.battle.healing.uncertain, true);
    assert.equal(attackCount, 3);
    await assert.rejects(
      executeCommand(
        entry,
        command(
          "attack-partial-200-no-retry",
          "attack",
          runtime.service.snapshot(entry).version,
        ),
      ),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
    const partialRecovered = await executeCommand(
      entry,
      command(
        "reconcile-partial-200-apply",
        "refresh",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(partialRecovered.battle.healing.uncertain, false);
    assert.equal(attackCount, 3);

    attackResponseMode = "truncated";
    const truncatedResponse = await executeCommand(
      entry,
      command(
        "attack-truncated-after-apply",
        "attack",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(truncatedResponse.battle.healing.uncertain, true);
    assert.equal(attackCount, 4);
    await assert.rejects(
      executeCommand(
        entry,
        command(
          "attack-truncated-no-retry",
          "attack",
          runtime.service.snapshot(entry).version,
        ),
      ),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
    const truncatedRecovered = await executeCommand(
      entry,
      command(
        "reconcile-truncated-apply",
        "refresh",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(truncatedRecovered.battle.healing.uncertain, false);
    assert.equal(attackCount, 4);

    for (const [mode, label] of [
      ["empty_200", "empty"],
      ["invalid_json_200", "invalid-json"],
      ["no_content_204", "no-content-204"],
      ["accepted_json_202", "accepted-202"],
      ["partial_content_206", "partial-content-206"],
      ["http_429_retry_after", "http-429-retry-after"],
      ["redirect_307", "redirect-307"],
      ["redirect_308", "redirect-308"],
    ]) {
      attackResponseMode = mode;
      const unknownResponse = await executeCommand(
        entry,
        command(
          `attack-${label}-after-apply`,
          "attack",
          runtime.service.snapshot(entry).version,
        ),
      );
      assert.equal(unknownResponse.battle.healing.uncertain, true);
      const attemptCount = attackCount;
      await assert.rejects(
        executeCommand(
          entry,
          command(
            `attack-${label}-no-retry`,
            "attack",
            runtime.service.snapshot(entry).version,
          ),
        ),
        (error) =>
          error.status === 409 && error.message === "battle_action_unresolved",
      );
      const reconciled = await executeCommand(
        entry,
        command(
          `reconcile-${label}-apply`,
          "refresh",
          runtime.service.snapshot(entry).version,
        ),
      );
      assert.equal(reconciled.battle.healing.uncertain, false);
      assert.equal(attackCount, attemptCount);
    }

    holdNextSuccessfulReply = true;
    const lateResponseCommand = await prepareCommand(
      entry,
      command(
        "attack-late-result-commit",
        "attack",
        runtime.service.snapshot(entry).version,
      ),
    );
    const lateResponseRequest = runtime.service.command(
      entry,
      lateResponseCommand,
    );
    await nextAttackDispatched;
    leaseNow = now + 109_000;
    competingStore = createAutomationStateStore({ directory });
    assert.equal(
      competingStore.acquireLease("competing-worker", leaseNow, 15_000),
      true,
    );
    const takeoverState = competingStore.read(playerId);
    const takeoverExpectedVersion = takeoverState.version;
    takeoverState.version += 1;
    takeoverState.preferences.favoriteBossIds = [777];
    assert.equal(
      competingStore.writeIfVersion(
        playerId,
        takeoverExpectedVersion,
        takeoverState,
      ),
      true,
    );
    const takeoverVersion = takeoverState.version;
    assert.equal(competingStore.releaseLease("competing-worker"), true);
    releaseNextSuccessfulReply();
    await assert.rejects(
      lateResponseRequest,
      (error) =>
        error.status === 503 &&
        error.message === "automation_storage_unavailable",
    );
    assert.equal(attackCount, 13);
    assert.equal(store.read(playerId).version, takeoverVersion);
    assert.deepEqual(store.read(playerId).preferences.favoriteBossIds, [777]);
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");
    assert.equal(
      store.read(playerId).assistant.pending.deliveryStatus,
      "dispatching",
    );
    runtime.service.close();
    store.close();
    competingStore.close();
    competingStore = null;
    store = createAutomationStateStore({ directory });
    activeStore = store;
    runtime = makeRuntime();
    entry = await runtime.service.identify(authorization);
    const lateCommitRecovered = await executeCommand(
      entry,
      command(
        "reconcile-late-result-commit",
        "refresh",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(lateCommitRecovered.battle.healing.uncertain, false);
    assert.equal(attackCount, 13);

    attackResponseMode = "success";
    const successfulAttackCommand = await prepareCommand(
      entry,
      command(
        "attack-ui-response-lost",
        "attack",
        runtime.service.snapshot(entry).version,
      ),
    );
    const callsBeforeSuccessfulAttack = attackCount;
    await runtime.service.command(entry, successfulAttackCommand);
    assert.equal(attackCount, callsBeforeSuccessfulAttack + 1);
    assert.equal(store.read(playerId).assistant.pending, null);
    const replayReceipt = await runtime.service.command(
      entry,
      successfulAttackCommand,
    );
    assert.equal(replayReceipt.commandReceipt.id, successfulAttackCommand.id);
    assert.equal(replayReceipt.battle.healing.uncertain, false);
    assert.equal(attackCount, callsBeforeSuccessfulAttack + 1);
    await assert.rejects(
      runtime.service.command(entry, {
        ...successfulAttackCommand,
        args: { changed: true },
      }),
      (error) =>
        error.status === 403 &&
        error.message === "automation_command_admission_mismatch",
    );
    assert.equal(attackCount, callsBeforeSuccessfulAttack + 1);
    const attackCountBeforeRouteSwitch = attackCount;

    switchRouteBeforeConnectionBind = true;
    const routeSwitchResult = await executeCommand(
      entry,
      command(
        "attack-route-switch",
        "attack",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(routeSwitchResult.battle.healing.uncertain, true);
    assert.equal(store.readRoutePolicy(playerId).routeEpoch, 2);
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");
    assert.equal(attackCount, attackCountBeforeRouteSwitch);

    const proxyAttack = await runtime.snapshots.fetch(
      "https://cargohustle.online/api/bosses/battles/battle-1/attack",
      {
        method: "POST",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operationId: "00000000-0000-4000-8000-000000000099",
        }),
      },
    );
    assert.equal(proxyAttack.status, 503);
    assert.equal(attackCount, attackCountBeforeRouteSwitch);

    const replacementDeviceId = "00000000-0000-4000-8000-000000000007";
    const replacementRoute = store.selectRoutePolicy(playerId, {
      policy: "bridge_required",
      activeDeviceId: replacementDeviceId,
      expectedRouteEpoch: 2,
      updatedAt: now + 2,
    });
    assert.equal(replacementRoute.routeEpoch, 3);
    const routeRequestStart = routedRequests.length;
    const newDeviceRead = await executeCommand(
      entry,
      command(
        "route-switch-new-device-read",
        "refresh",
        runtime.service.snapshot(entry).version,
      ),
    );
    assert.equal(newDeviceRead.battle.healing.uncertain, true);
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");
    assert.equal(
      store.read(playerId).assistant.pending.deliveryStatus,
      "unknown",
    );
    assert.equal(attackCount, attackCountBeforeRouteSwitch);
    assert.ok(
      routedRequests
        .slice(routeRequestStart)
        .some(
          ({ deviceId, path, method }) =>
            deviceId === replacementDeviceId &&
            path === "/api/bosses/battles/battle-1" &&
            method === "GET",
        ),
    );
    await assert.rejects(
      executeCommand(
        entry,
        command(
          "route-switch-new-device-retry",
          "attack",
          runtime.service.snapshot(entry).version,
        ),
      ),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
    assert.equal(attackCount, attackCountBeforeRouteSwitch);
  } finally {
    releaseNextSuccessfulReply?.();
    runtime.service.close();
    try {
      competingStore?.releaseLease("competing-worker");
      competingStore?.close();
    } catch {
      /* already closed */
    }
    try {
      activeStore.close();
    } catch {
      /* already closed */
    }
    rmSync(directory, { recursive: true, force: true });
  }
});

test("credential renewal after attack admission rejects the stale stream without Cargo dispatch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-attack-auth-renewal-"));
  const store = createAutomationStateStore({ directory });
  readyGameAuth(store);
  let service;
  const currentBattle = battle();
  const cargoCalls = [];
  const cargo = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    cargoCalls.push({ method, path: url.pathname });
    if (url.pathname === "/api/me")
      return Response.json({ playerId: Number(playerId), nickname: "Alice" });
    if (url.pathname === "/api/me/bag")
      return Response.json({ activityItems: [], combatItems: [] });
    if (url.pathname === "/api/bosses/invitations")
      return Response.json({ items: [] });
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
    if (method === "POST")
      assert.fail(`unexpected Cargo mutation: ${url.pathname}`);
    return Response.json({});
  };
  const snapshots = createAccountSnapshots({
    store,
    now: () => now,
    fetcher: async () => assert.fail("bridge route must not use direct Cargo"),
    bridgeTransport: async ({
      route,
      upstreamPath,
      search,
      method,
      headers,
      body,
      admission,
    }) => {
      assert.equal(route.policy, "bridge_required");
      if (admission) {
        const renewed = completeFakeCredentialRenewal(store, now);
        assert.equal(renewed.state, "ready");
        assert.equal(renewed.authGeneration, admission.authGeneration + 1);
        assert.equal(
          service.bindGameMutationConnection({
            admission,
            connectionId,
            route,
          }),
          false,
        );
        throw new Error("credential_changed_before_http_dispatch");
      }
      return cargo(`https://cargohustle.online${upstreamPath}${search}`, {
        method,
        headers: Object.fromEntries(headers),
        ...(body == null ? {} : { body }),
      });
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
    commandAdmissionTtlMs: 30_000,
  });
  const executeCommand = async (entry, input) => {
    const ticket = await service.issueCommandTicket(entry, {
      command: input.command,
      expectedVersion: input.expectedVersion,
      args: input.args ?? {},
    });
    return service.command(entry, {
      ...input,
      id: ticket.id,
      admissionTicket: ticket.ticket,
      expectedVersion: ticket.intentVersion,
    });
  };

  try {
    const entry = await service.identify(authorization);
    await executeCommand(
      entry,
      command("renewal-open-boss", "open", service.snapshot(entry).version, {
        bossId: 7,
      }),
    );
    const result = await executeCommand(
      entry,
      command("renewal-attack", "attack", service.snapshot(entry).version),
    );

    assert.equal(result.battle.healing.uncertain, true);
    assert.equal(result.battle.healing.pendingKind, "attack");
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");
    assert.equal(
      store.read(playerId).assistant.pending.admission.authGeneration,
      1,
    );
    assert.equal(store.readGameAuthRecovery(ownerId).authGeneration, 2);
    assert.equal(
      cargoCalls.some(({ method }) => method === "POST"),
      false,
    );

    await executeCommand(
      entry,
      command(
        "renewal-reconcile-without-evidence",
        "refresh",
        service.snapshot(entry).version,
      ),
    );
    assert.equal(service.snapshot(entry).battle.healing.uncertain, true);
    assert.equal(store.read(playerId).assistant.pending.kind, "attack");
    assert.equal(
      cargoCalls.some(({ method }) => method === "POST"),
      false,
    );
    assert.throws(
      () =>
        service.issueCommandTicket(entry, {
          command: "healing.ack",
          expectedVersion: service.snapshot(entry).version,
        }),
      (error) =>
        error.status === 409 && error.message === "battle_action_unresolved",
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a queued automatic strike rejects a simultaneous manual attack command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-attack-overlap-"));
  let store = createAutomationStateStore({ directory });
  readyGameAuth(store);
  let service;
  let snapshots;
  let currentBattle = {
    ...battle(),
    cooldownUntilUtc: new Date(now + 30_000).toISOString(),
  };
  const gameCalls = [];
  const mutationAdmissions = [];
  const scheduled = [];
  const cargo = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    const method = (init.method || "GET").toUpperCase();
    gameCalls.push({ method, path: url.pathname });
    if (method === "POST")
      assert.fail(`unexpected Cargo mutation: ${url.pathname}`);
    if (url.pathname === "/api/me")
      return Response.json({ playerId: Number(playerId), nickname: "Alice" });
    if (url.pathname === "/api/me/bag")
      return Response.json({ activityItems: [], combatItems: [] });
    if (url.pathname === "/api/bosses/invitations")
      return Response.json({ items: [] });
    if (url.pathname === "/api/combat")
      return Response.json({ activeBattle: null });
    if (url.pathname === "/api/bosses/7")
      return Response.json({
        id: 7,
        damageMax: 10,
        activeBattle: currentBattle,
        state: { canStartFight: false },
      });
    if (url.pathname === "/api/bosses/battles/battle-1")
      return Response.json(currentBattle);
    return Response.json({});
  };
  const makeSnapshots = () =>
    createAccountSnapshots({
      store,
      now: () => now,
      fetcher: async () =>
        assert.fail("bridge route must not use direct Cargo"),
      bridgeTransport: async ({
        route,
        upstreamPath,
        search,
        method,
        headers,
        body,
        admission,
      }) => {
        assert.equal(route.policy, "bridge_required");
        if (admission) {
          assert.equal(
            service.bindGameMutationConnection({
              admission,
              connectionId,
              route,
            }),
            true,
          );
        }
        return cargo(`https://cargohustle.online${upstreamPath}${search}`, {
          method,
          headers: Object.fromEntries(headers),
          ...(body == null ? {} : { body }),
        });
      },
      admitMutation: (request) => {
        mutationAdmissions.push(request);
        return service?.admitGameMutation(request) ?? null;
      },
    });
  const makeService = () =>
    createAutomationService({
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
      schedule: (callback, delay) => {
        const handle = { callback, delay, cancelled: false };
        scheduled.push(handle);
        return handle;
      },
      cancel: (handle) => {
        if (handle) handle.cancelled = true;
      },
      random: () => 0,
      commandAdmissionTtlMs: 30_000,
    });
  snapshots = makeSnapshots();
  service = makeService();
  const executeCommand = async (entry, input) => {
    const ticket = service.issueCommandTicket(entry, {
      command: input.command,
      expectedVersion: input.expectedVersion,
      args: input.args ?? {},
    });
    return service.command(entry, {
      ...input,
      id: ticket.id,
      admissionTicket: ticket.ticket,
      expectedVersion: ticket.intentVersion,
    });
  };

  try {
    const entry = await service.identify(authorization);
    await executeCommand(
      entry,
      command("overlap-open-boss", "open", service.snapshot(entry).version, {
        bossId: 7,
      }),
    );
    const autoStarted = await executeCommand(
      entry,
      command(
        "overlap-auto-start",
        "auto.start",
        service.snapshot(entry).version,
      ),
    );
    assert.equal(autoStarted.auto.enabled, true);
    assert.equal(autoStarted.auto.nextAttackAt, now + 30_000);
    assert.ok(scheduled.some((handle) => !handle.cancelled));
    const cargoCallsBeforeManual = gameCalls.length;

    await assert.rejects(
      executeCommand(
        entry,
        command(
          "overlap-manual-attack",
          "attack",
          service.snapshot(entry).version,
        ),
      ),
      (error) =>
        error.status === 409 &&
        error.message === "automation_controls_the_battle",
    );
    assert.equal(gameCalls.length, cargoCallsBeforeManual);
    assert.equal(mutationAdmissions.length, 0);
    assert.equal(
      gameCalls.some(
        ({ method, path }) => method === "POST" && /attack$/u.test(path),
      ),
      false,
    );
    assert.equal(service.snapshot(entry).auto.enabled, true);
    await service.command(
      entry,
      command(
        "overlap-auto-stop",
        "auto.stop",
        service.snapshot(entry).version,
      ),
    );
    assert.equal(service.snapshot(entry).auto.enabled, false);

    service.close();
    store.close();
    store = createAutomationStateStore({ directory });
    snapshots = makeSnapshots();
    service = makeService();
    const restartedEntry = await service.identify(authorization);
    const restartedSnapshot = service.snapshot(restartedEntry);
    assert.equal(restartedSnapshot.auto.enabled, false);
    assert.equal(restartedSnapshot.auto.nextAttackAt, null);
    assert.equal(
      gameCalls.some(
        ({ method, path }) => method === "POST" && /attack$/u.test(path),
      ),
      false,
    );
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
