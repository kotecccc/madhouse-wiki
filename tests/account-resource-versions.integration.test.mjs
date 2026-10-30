import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import { createAutomationHttp } from "../scripts/automation/http.mjs";
import { createAutomationService } from "../scripts/automation/service.mjs";
import { createAutomationStateStore } from "../scripts/automation/state-store.mjs";
import { createSessionApi } from "../shared/session-api.js";
import { inventoryGame } from "./helpers/inventory-game.mjs";
import { createDirectBoundary } from "../scripts/game/direct-boundary.mjs";

test("stored actor state drives only subscribed resource refreshes after a server mutation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "resource-versions-"));
  const store = createAutomationStateStore({ directory });
  const credential = "Bearer resource-test";
  const gameOrigin = "https://cargohustle.online";
  let clock = 1000;
  let revision = 1;
  let bagReads = 0;
  const game = async (url) => {
    if (new URL(url).pathname === "/api/me/bag") {
      bagReads++;
      return Response.json({ revision });
    }
    return Response.json({ playerId: 42 });
  };
  const snapshots = createAccountSnapshots({
    store,
    fetcher: game,
    now: () => clock,
  });
  snapshots.saveBridgeProfile(credential, { playerId: 42, nickname: "Test" });
  await snapshots.liveFetch(`${gameOrigin}/api/me/bag`, {
    headers: { Authorization: credential },
  });
  const service = createAutomationService({
    store,
    getBoss: () => null,
    fetcher: game,
    identifyPlayer: async () => ({ playerId: 42, nickname: "Test" }),
    accountResourceVersions: snapshots.resourceVersions,
    now: () => clock,
    schedule: () => ({}),
    cancel: () => {},
  });
  try {
    await service.identify(credential);
    const http = createAutomationHttp({ service });
    const api = createSessionApi({
      now: () => clock,
      authorize: (request) => ({
        ...request,
        headers: { Authorization: credential },
      }),
      fetcher: (path, options) => {
        if (path === "/api/automation/state")
          return http(new Request(`https://wiki.test${path}`, options));
        const url = `${gameOrigin}${path}`;
        return options.headers["X-Madhouse-Stored-Only"]
          ? snapshots.readStored(url, options)
          : snapshots.read(url, options);
      },
    });
    const updates = [];
    const unsubscribe = api.subscribe(
      (event) => {
        if (event.path === "/api/me/bag") updates.push(event.data.revision);
      },
      { resources: ["/api/me/bag"] },
    );
    await api.get("/api/me/bag", { fresh: true });
    await api.readStored("/api/automation/state");
    const barrier = snapshots.beginMutation(
      credential,
      "POST",
      "/api/me/bag/boosters/use",
    );
    assert.equal(snapshots.commitMutationBarrier(barrier), true);
    revision = 2;
    clock++;
    await api.readStored("/api/automation/state");
    for (let attempt = 0; attempt < 10 && bagReads < 2; attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bagReads, 2);
    assert.equal(updates.at(-1), 2);
    revision = 3;
    clock++;
    await snapshots.liveFetch(`${gameOrigin}/api/me/bag`, {
      headers: { Authorization: credential },
    });
    await api.readStored("/api/automation/state");
    for (let attempt = 0; attempt < 10 && updates.at(-1) !== 3; attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates.at(-1), 3);
    assert.equal(bagReads, 3);
    unsubscribe();
    const secondBarrier = snapshots.beginMutation(
      credential,
      "POST",
      "/api/me/bag/boosters/use",
    );
    assert.equal(snapshots.commitMutationBarrier(secondBarrier), true);
    await api.readStored("/api/automation/state");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(bagReads, 3);
    api.clear();
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a real queued worker publishes its saved observation to an active inventory consumer", async () => {
  const directory = mkdtempSync(join(tmpdir(), "resource-worker-"));
  const store = createAutomationStateStore({ directory });
  const credential = "Bearer resource-worker";
  const gameOrigin = "https://cargohustle.online";
  const path = "/api/clothing/by-category/1";
  const game = inventoryGame();
  const snapshots = createAccountSnapshots({ store, fetcher: game.fetcher });
  const gameInit = { headers: { Authorization: credential } };
  await snapshots.read(`${gameOrigin}/api/me`, gameInit);
  await snapshots.liveFetch(`${gameOrigin}${path}`, gameInit);
  const service = createAutomationService({
    store,
    getBoss: () => null,
    fetcher: snapshots.liveFetch,
    snapshotFetch: snapshots.fetch,
    identifyPlayer: async () => ({ playerId: 1 }),
    accountResourceVersions: snapshots.resourceVersions,
  });
  try {
    await service.identify(credential);
    const http = createAutomationHttp({ service });
    const api = createSessionApi({
      authorize: (request) => ({
        ...request,
        headers: { Authorization: credential },
      }),
      fetcher: (target, options) => {
        if (target.startsWith("/api/automation/"))
          return http(new Request(`https://wiki.test${target}`, options));
        return options.headers["X-Madhouse-Stored-Only"]
          ? snapshots.readStored(`${gameOrigin}${target}`, options)
          : snapshots.read(`${gameOrigin}${target}`, options);
      },
    });
    const updates = [];
    const unsubscribe = api.subscribe(
      (event) => {
        if (event.path === path) updates.push(event.data.items[0].owned);
      },
      { resources: [path] },
    );
    await api.get(path);
    const saved = await api.readStored("/api/automation/state");
    await api.post("/api/automation/commands", {
      id: "purchase-worker-test",
      command: "queue.enqueue",
      expectedVersion: saved.data.version,
      args: {
        type: "inventory",
        action: {
          type: "weapon",
          id: 1,
          action: "buy",
          price: { amount: 100, currency: "gold" },
        },
      },
    });
    await service.boot();
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const state = await service.readStored(credential);
      if (service.snapshot(state).queuedActions[0]?.status === "completed")
        break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      service.snapshot(await service.readStored(credential)).queuedActions[0]
        .status,
      "completed",
    );
    assert.equal(game.mutations().length, 1);
    const readsBeforePoll = game.calls.length;
    await api.readStored("/api/automation/state");
    for (let attempt = 0; attempt < 20 && updates.at(-1) !== true; attempt++)
      await new Promise((resolve) => setImmediate(resolve));
    assert.equal(updates.at(-1), true);
    assert.equal(game.calls.length, readsBeforePoll);
    unsubscribe();
    api.clear();
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a queued worker bounds coordinator-proven unsent retries and resumes only on command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "resource-unsent-budget-"));
  const store = createAutomationStateStore({ directory });
  const game = inventoryGame();
  let clock = 1_000_000;
  let allowMutation = false;
  const boundary = createDirectBoundary({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
    },
    fetcher: game.fetcher,
  });
  const snapshots = createAccountSnapshots({
    store,
    now: () => clock,
    fetcher: (url, init) =>
      boundary.request(url, {
        ...init,
        canDispatch: async () =>
          (!init.canDispatch || (await init.canDispatch())) &&
          ((init.method || "GET") === "GET" || allowMutation),
      }),
  });
  const credential = "Bearer budget-worker";
  await snapshots.read("https://cargohustle.online/api/me", {
    headers: { Authorization: credential },
  });
  const service = createAutomationService({
    store,
    getBoss: () => null,
    identifyPlayer: async () => ({ playerId: 1 }),
    fetcher: snapshots.liveFetch,
    now: () => clock,
    random: () => 0,
    schedule: () => ({}),
    cancel: () => {},
  });
  try {
    const entry = await service.identify(credential);
    await service.command(entry, {
      id: "budget-worker-job",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.enqueue",
      args: {
        type: "inventory",
        action: {
          type: "weapon",
          id: 1,
          action: "buy",
          price: { amount: 100, currency: "gold" },
        },
      },
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      await entry.actionQueue.tick();
      const job = service.snapshot(entry).queuedActions[0];
      if (job.nextAt) clock = job.nextAt;
    }
    const paused = service.snapshot(entry).queuedActions[0];
    assert.equal(paused.status, "paused");
    assert.equal(paused.reason, "unsent_retry_budget");
    assert.equal(paused.unsentMutationAttempts, 3);
    assert.equal(game.mutations().length, 0);
    assert.equal(entry.actionQueue.hasDue(), false);
    allowMutation = true;
    const resume = {
      id: "budget-resume-command",
      expectedVersion: service.snapshot(entry).version,
      command: "queue.resume",
      args: { id: paused.id },
    };
    await service.command(entry, resume);
    await service.command(entry, resume);
    clock += 3_600_001;
    assert.equal(entry.actionQueue.hasDue(), true);
    await entry.actionQueue.tick();
    assert.equal(service.snapshot(entry).queuedActions[0].status, "completed");
    assert.equal(game.mutations().length, 1);
    assert.equal(
      boundary
        .diagnostics()
        .recent.filter(
          (event) => event.outcome === "DIRECT_REQUEST_NOT_DISPATCHED",
        ).length,
      3,
    );
  } finally {
    service.close();
    boundary.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
