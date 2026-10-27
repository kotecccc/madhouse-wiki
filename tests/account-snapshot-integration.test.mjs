import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import { createAutomationHttp } from "../scripts/automation/http.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createRestoreOperationGuard } from "../scripts/automation/runtime.mjs";

const origin = "https://cargohustle.online";
const authorization = "Bearer integration-session";
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("restore confirmation gate flows through account snapshots to the shared mutation boundary", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "madhouse-account-restore-gate-"),
  );
  const store = createAutomationStateStore({ directory });
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  store.write("319", { credential: authorization });
  store.activateRestoreGuard({ activatedAt: 10_000 });
  const upstreamCalls = [];
  const snapshots = createAccountSnapshots({
    store,
    fetcher: async (...args) => {
      upstreamCalls.push(args);
      return json({ playerId: 319 });
    },
    allowOperation: createRestoreOperationGuard(store),
  });

  const request = () =>
    snapshots.liveFetch(`${origin}/api/bosses/7/battles`, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
  const unknownRoute = await request();
  assert.equal(unknownRoute.status, 503);
  assert.equal(upstreamCalls.length, 0);
  store.selectRoutePolicy("319", {
    policy: "direct",
    activeDeviceId: null,
    expectedRouteEpoch: 0,
    updatedAt: 10001,
  });
  const response = await request();
  assert.equal(response.status, 409);
  assert.equal(
    (await response.json()).error,
    "game_restore_confirmation_required",
  );
  assert.equal(upstreamCalls.length, 0);
  const beforeConfirmation = await snapshots.liveFetch(`${origin}/api/me`, {
    headers: { Authorization: authorization },
  });
  assert.equal(beforeConfirmation.status, 409);
  assert.equal(upstreamCalls.length, 0);
  const identityBefore = await snapshots.verifyIdentity(authorization);
  assert.equal(identityBefore.status, 409);
  assert.equal(upstreamCalls.length, 0);
  store.bindVerifiedGameAccount("54321", "319", 10002);
  store.confirmRestoredAccount({
    ownerId: "54321",
    playerId: "319",
    verifiedAt: 10003,
  });
  store.write("319", {
    credential: authorization,
    characterUpgrade: { pending: { id: "uncertain" } },
  });
  assert.equal(store.isRestoreRequired("319"), true);
  const allowedRead = await snapshots.liveFetch(`${origin}/api/me`, {
    headers: { Authorization: authorization },
  });
  assert.equal(allowedRead.status, 200);
  assert.equal(upstreamCalls.length, 1);
  const identityAfter = await snapshots.verifyIdentity(authorization);
  assert.equal(identityAfter.status, 200);
  assert.equal(upstreamCalls.length, 2);
  const blockedWrite = await request();
  assert.equal(blockedWrite.status, 409);
  assert.equal(
    (await blockedWrite.json()).error,
    "game_restore_confirmation_required",
  );
  assert.equal(upstreamCalls.length, 2);
});

test("restarted gateway serves saved identity offline, accepts queued work intent, and accepts a safe preference command", async (t) => {
  const directory = mkdtempSync(
    join(tmpdir(), "madhouse-account-snapshot-integration-"),
  );
  let store;
  let service;
  t.after(() => {
    service?.close();
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  });

  let now = 10_000;
  let offline = false;
  const upstreamCalls = [];
  const fetcher = async (url, init = {}) => {
    const path = new URL(url).pathname;
    upstreamCalls.push({ path, method: (init.method || "GET").toUpperCase() });
    if (path === "/api/me")
      return offline
        ? json({ error: "maintenance" }, 503)
        : json({ playerId: 319, nickname: "Test Player" });
    if (path === "/api/combat") return json({});
    return json({ error: "unexpected fake route" }, 404);
  };
  const identifyPlayer = async (credential) => {
    const response = await snapshots.read(`${origin}/api/me`, {
      headers: { Authorization: credential },
    });
    if (!response.ok)
      throw Object.assign(new Error("identity_unavailable"), {
        status: response.status,
      });
    return response.json();
  };

  store = createAutomationStateStore({ directory });
  let snapshots = createAccountSnapshots({
    store,
    fetcher,
    now: () => now,
    ttl: 0,
    cooldown: 60_000,
  });
  service = createAutomationService({
    store,
    fetcher: snapshots.liveFetch,
    identifyPlayer,
    accountHealth: snapshots.health,
    getBoss: async () => null,
    now: () => now,
  });
  await service.boot();
  let gateway = createAutomationHttp({ service });

  let response = await gateway(
    new Request("http://wiki.test/api/automation/state", {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).gameHealth.status, "available");

  // Force an upstream failure so the store has both a good snapshot and unavailable health.
  offline = true;
  now += 1;
  response = await snapshots.read(`${origin}/api/me`, {
    headers: { Authorization: authorization },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(snapshots.health(authorization).status, "unavailable");

  service.close();
  store.close();

  store = createAutomationStateStore({ directory });
  snapshots = createAccountSnapshots({
    store,
    fetcher,
    now: () => now,
    ttl: 0,
    cooldown: 60_000,
  });
  service = createAutomationService({
    store,
    fetcher: snapshots.liveFetch,
    identifyPlayer,
    accountHealth: snapshots.health,
    getBoss: async () => null,
    now: () => now,
  });
  await service.boot();
  gateway = createAutomationHttp({ service });

  response = await gateway(
    new Request("http://wiki.test/api/automation/state", {
      headers: { Authorization: authorization },
    }),
  );
  assert.equal(response.status, 200);
  const state = await response.json();
  assert.equal(state.gameHealth.status, "unavailable");
  assert.equal(state.preferences.favoriteBossIds.length, 0);

  response = await gateway(
    new Request("http://wiki.test/api/automation/commands", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "blocked-start-0001",
        command: "work.start",
        args: {
          workId: 7,
          targetCycles: 1,
          mode: "energy",
          maxActions: 10,
          maxBoosters: 0,
          maxDollar: 0,
          allowPurchase: false,
        },
        expectedVersion: state.version,
      }),
    }),
  );
  assert.equal(response.status, 200);
  const queuedState = await response.json();
  assert.equal(queuedState.workFarm.run.status, "running");
  assert.equal(
    upstreamCalls.some(({ method }) => method === "POST"),
    false,
  );

  response = await gateway(
    new Request("http://wiki.test/api/automation/commands", {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: "favorites-set-0001",
        command: "favorites.set",
        args: { bossIds: [44] },
        expectedVersion: queuedState.version,
      }),
    }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).preferences.favoriteBossIds, [44]);
  assert.equal(
    upstreamCalls.some(({ method }) => method === "POST"),
    false,
  );
});
