import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAutomationStateStore } from "../automation/state-store.mjs";
import { withWorkerLease } from "../automation/worker-lease-context.mjs";
import { createDirectBoundary } from "./direct-boundary.mjs";

const deviceId = "00000000-0000-4000-8000-000000000001";
const options = {
  authorization: "Bearer fake",
  playerId: "42",
  deviceId,
  method: "POST",
  kind: "mutation",
  operationId: "operation_1",
  checkpointOperationId: "game-operation-1",
  bindingRevision: 1,
  deviceGeneration: 1,
};
const env = {
  MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
  MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
  MADHOUSE_GAME_DEVICE_INTERVAL_MS: "1",
};

test("journal precedes possible send and restores account/device restriction after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-journal-"));
  let store = createAutomationStateStore({ directory: dir });
  let boundary = createDirectBoundary({
    env,
    requireBridgeJournal: true,
    fetcher: async () => new Response("{}"),
    resolvePlayer: () => 42,
  });
  try {
    boundary.installBridgeStore(store);
    let sends = 0;
    await assert.rejects(
      boundary.bridge({
        ...options,
        execute: () => {
          const active = store.readActiveBridgeAttempts();
          assert.equal(active.length, 1);
          assert.equal(active[0].phase, "dispatched");
          assert.equal(active[0].checkpointOperationId, "game-operation-1");
          sends++;
          throw new Error("lost response");
        },
      }),
    );
    assert.equal(sends, 1);
    assert.equal(store.readActiveBridgeAttempts()[0].phase, "uncertain");
    boundary.close();
    store.close();
    store = createAutomationStateStore({ directory: dir });
    boundary = createDirectBoundary({
      env,
      requireBridgeJournal: true,
      fetcher: async () => new Response("{}"),
      resolvePlayer: () => 42,
    });
    boundary.installBridgeStore(store);
    assert.equal(boundary.diagnostics().durableBlocks, 1);
    const controller = new AbortController();
    const blocked = boundary.bridge({
      ...options,
      signal: controller.signal,
      execute: () => {
        sends++;
      },
    });
    controller.abort();
    await assert.rejects(blocked, (error) => error.notDispatched);
    assert.equal(sends, 1);
    const independent = await boundary.bridge({
      ...options,
      authorization: "Bearer another-fake",
      playerId: "43",
      deviceId: "00000000-0000-4000-8000-000000000002",
      execute: () => ({ status: 200 }),
    });
    assert.equal(independent.status, 200);
  } finally {
    boundary.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing durable store refuses a mutation before its send function", async () => {
  const boundary = createDirectBoundary({ env, requireBridgeJournal: true });
  let sends = 0;
  try {
    await assert.rejects(
      boundary.bridge({
        ...options,
        execute: () => {
          sends++;
        },
      }),
      (error) => error.notDispatched,
    );
    await assert.rejects(
      boundary.request("https://cargohustle.online/api/me"),
      (error) =>
        error.notDispatched && error.message === "bridge_recovery_not_ready",
    );
    assert.equal(sends, 0);
  } finally {
    boundary.close();
  }
});

test("restart rejects a prepared attempt that could not yet be sent", () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-prepared-"));
  let store = createAutomationStateStore({ directory: dir });
  store.createBridgeAttempt({
    id: "00000000-0000-4000-8000-000000000003",
    playerId: "42",
    operationId: "operation_1",
    deviceId,
    bindingRevision: 1,
    deviceGeneration: 1,
    action: "mutation",
    phase: "prepared",
    createdAt: 1,
    updatedAt: 1,
  });
  store.close();
  store = createAutomationStateStore({ directory: dir });
  const boundary = createDirectBoundary({ env, requireBridgeJournal: true });
  try {
    boundary.installBridgeStore(store);
    assert.equal(boundary.diagnostics().durableBlocks, 0);
    assert.deepEqual(store.readActiveBridgeAttempts(), []);
  } finally {
    boundary.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage write failure cannot dispatch and blocks that scope", async () => {
  const boundary = createDirectBoundary({ env, requireBridgeJournal: true });
  boundary.installBridgeStore({
    readActiveBridgeAttempts: () => [],
    createBridgeAttempt: () => {
      throw new Error("disk failure");
    },
    compareAndSetBridgeAttempt: () => {
      throw new Error("unexpected");
    },
  });
  let sent = 0;
  try {
    await assert.rejects(
      boundary.bridge({
        ...options,
        execute: () => {
          sent++;
        },
      }),
      (error) => error.notDispatched,
    );
    assert.equal(sent, 0);
    assert.equal(boundary.diagnostics().durableBlocks, 1);
  } finally {
    boundary.close();
  }
});

test("late transport callbacks cannot clear a journal fence after lease takeover and restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridge-late-callback-"));
  const firstStore = createAutomationStateStore({ directory: dir });
  const secondStore = createAutomationStateStore({ directory: dir });
  const oldBoundary = createDirectBoundary({
    env,
    requireBridgeJournal: true,
    fetcher: async () => new Response("{}"),
    resolvePlayer: () => 42,
  });
  let markDispatched;
  let resolveTransport;
  let onTransportStopped;
  let leaseNow;
  const dispatched = new Promise((resolve) => {
    markDispatched = resolve;
  });
  const transportResponse = new Promise((resolve) => {
    resolveTransport = resolve;
  });
  let restartedBoundary;
  try {
    const leaseStart = Date.now();
    leaseNow = leaseStart;
    assert.equal(firstStore.acquireLease("owner-a", leaseStart, 10), true);
    oldBoundary.installBridgeStore(firstStore);
    const oldRequest = withWorkerLease(
      "owner-a",
      () => leaseNow,
      () =>
        oldBoundary.bridge({
          ...options,
          execute: (stopTransport) => {
            onTransportStopped = stopTransport;
            markDispatched();
            return transportResponse;
          },
        }),
    );
    await dispatched;
    const beforeRestart = secondStore.readActiveBridgeAttempts();
    assert.equal(beforeRestart.length, 1);
    assert.equal(beforeRestart[0].phase, "dispatched");

    // Fake-clock lease takeover invalidates callbacks from worker A.
    leaseNow = leaseStart + 11;
    assert.equal(
      secondStore.acquireLease("owner-b", leaseStart + 11, 10),
      true,
    );
    const afterTakeover = secondStore.readActiveBridgeAttempts();
    assert.equal(afterTakeover.length, 1);
    assert.equal(afterTakeover[0].revision, beforeRestart[0].revision + 1);
    restartedBoundary = createDirectBoundary({
      env,
      requireBridgeJournal: true,
      fetcher: async () => new Response("{}"),
      resolvePlayer: () => 42,
    });
    restartedBoundary.installBridgeStore(secondStore);
    assert.equal(restartedBoundary.diagnostics().durableBlocks, 1);

    // The old transport reports stop and then returns its late HTTP response.
    // Neither callback may make the restored durable attempt appear resolved.
    assert.throws(onTransportStopped, /bridge_attempt_stale/u);
    const afterLateStop = secondStore.readActiveBridgeAttempts();
    resolveTransport({ status: 200 });
    await oldRequest.catch(() => {});
    const afterLateResponse = secondStore.readActiveBridgeAttempts();

    assert.deepEqual(afterLateStop, afterTakeover);
    assert.deepEqual(afterLateResponse, afterTakeover);

    const finalStore = createAutomationStateStore({ directory: dir });
    const finalBoundary = createDirectBoundary({
      env,
      requireBridgeJournal: true,
      fetcher: async () => new Response("{}"),
      resolvePlayer: () => 42,
    });
    try {
      finalBoundary.installBridgeStore(finalStore);
      assert.equal(finalBoundary.diagnostics().durableBlocks, 1);
      assert.deepEqual(finalStore.readActiveBridgeAttempts(), afterTakeover);
    } finally {
      finalBoundary.close();
      finalStore.close();
    }
  } finally {
    oldBoundary.close();
    restartedBoundary?.close();
    firstStore.close();
    secondStore.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
