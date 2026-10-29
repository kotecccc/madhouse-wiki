import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomationStateStore } from "./state-store.mjs";

const attempt = (overrides = {}) => ({
  id: "123e4567-e89b-42d3-a456-426614174000",
  playerId: "42",
  operationId: "job_abcdefgh-1234",
  deviceId: "123e4567-e89b-42d3-a456-426614174002",
  bindingRevision: 3,
  deviceGeneration: 2,
  action: "work.perform",
  phase: "prepared",
  createdAt: 1000,
  updatedAt: 1000,
  ...overrides,
});

test("actor journal writes require a current worker lease in the same transaction", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-lease-fence-"));
  const store = createAutomationStateStore({ directory });
  let time = 1000;
  const context = { owner: "worker-a", now: () => time };
  try {
    assert.equal(store.acquireLease("worker-a", time, 100), true);
    const created = store.createBridgeAttempt(attempt(), context);
    const dispatched = store.compareAndSetBridgeAttempt(
      created.id,
      created.revision,
      { phase: "dispatched", updatedAt: 1001 },
      context,
    );
    time = 1100;
    assert.throws(
      () =>
        store.createBridgeAttempt(
          attempt({ id: "123e4567-e89b-42d3-a456-426614174003" }),
          context,
        ),
      /automation_worker_unavailable/,
    );
    assert.throws(
      () =>
        store.confirmBridgeTransportStop(
          dispatched.id,
          dispatched.revision,
          1100,
          context,
        ),
      /automation_worker_unavailable/,
    );
    assert.throws(
      () =>
        store.compareAndSetBridgeAttempt(
          dispatched.id,
          dispatched.revision,
          { phase: "completed", updatedAt: 1100 },
          context,
        ),
      /automation_worker_unavailable/,
    );
    assert.deepEqual(store.readActiveBridgeAttempts(), [dispatched]);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bridge attempt journal survives restart, uses CAS, and refuses overwrite", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-attempt-store-"));
  let store = createAutomationStateStore({ directory });
  try {
    const created = store.createBridgeAttempt(attempt());
    assert.equal(created.revision, 1);
    assert.deepEqual(store.readActiveBridgeAttempts(), [created]);
    assert.throws(
      () => store.createBridgeAttempt(attempt()),
      /UNIQUE constraint/,
    );

    store.close();
    store = createAutomationStateStore({ directory });
    assert.deepEqual(store.readActiveBridgeAttempts(), [created]);

    const dispatched = store.compareAndSetBridgeAttempt(
      created.id,
      created.revision,
      { phase: "dispatched", updatedAt: 1100 },
    );
    assert.deepEqual(dispatched, {
      ...created,
      phase: "dispatched",
      updatedAt: 1100,
      revision: 2,
    });
    assert.equal(
      store.compareAndSetBridgeAttempt(created.id, 1, {
        phase: "uncertain",
        updatedAt: 1200,
      }),
      null,
    );
    assert.deepEqual(store.readActiveBridgeAttempts(), [dispatched]);

    const completed = store.compareAndSetBridgeAttempt(
      dispatched.id,
      dispatched.revision,
      { phase: "completed", updatedAt: 1300 },
    );
    assert.equal(completed.revision, 3);
    assert.deepEqual(store.readActiveBridgeAttempts(), []);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bridge attempt journal rejects credentials, bodies, and unsafe transitions", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-attempt-validation-"));
  const store = createAutomationStateStore({ directory });
  try {
    assert.throws(
      () =>
        store.createBridgeAttempt({
          ...attempt(),
          credential: "Bearer secret",
        }),
      /invalid_bridge_attempt/,
    );
    assert.throws(
      () => store.createBridgeAttempt({ ...attempt(), body: "{}" }),
      /invalid_bridge_attempt/,
    );
    assert.throws(
      () =>
        store.createBridgeAttempt({ ...attempt(), url: "https://host/api/me" }),
      /invalid_bridge_attempt/,
    );
    const created = store.createBridgeAttempt(attempt());
    assert.throws(
      () =>
        store.compareAndSetBridgeAttempt(created.id, created.revision, {
          phase: "completed",
          updatedAt: 1100,
        }),
      /invalid_bridge_attempt_transition/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("checkpoint operation identity survives restart and CAS without changing legacy records", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-checkpoint-store-"));
  let store = createAutomationStateStore({ directory });
  try {
    const linked = store.createBridgeAttempt(
      attempt({ checkpointOperationId: "game-operation-1" }),
    );
    store.createBridgeAttempt(
      attempt({ id: "123e4567-e89b-42d3-a456-426614174001" }),
    );
    store.close();
    store = createAutomationStateStore({ directory });
    const restored = store.readActiveBridgeAttempts();
    assert.equal(
      restored.find((item) => item.id === linked.id).checkpointOperationId,
      "game-operation-1",
    );
    assert.equal(
      Object.hasOwn(
        restored.find((item) => item.id !== linked.id),
        "checkpointOperationId",
      ),
      false,
    );
    const dispatched = store.compareAndSetBridgeAttempt(
      linked.id,
      linked.revision,
      { phase: "dispatched", updatedAt: 1100 },
    );
    assert.equal(dispatched.checkpointOperationId, "game-operation-1");
    assert.throws(
      () =>
        store.createBridgeAttempt(
          attempt({
            id: "123e4567-e89b-42d3-a456-426614174004",
            checkpointOperationId: "Bearer secret",
          }),
        ),
      /invalid_bridge_attempt/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("transport stop is a separate CAS fact and leaves the game outcome unresolved", () => {
  const directory = mkdtempSync(join(tmpdir(), "bridge-stop-store-"));
  let store = createAutomationStateStore({ directory });
  try {
    assert.throws(
      () => store.createBridgeAttempt(attempt({ transportStoppedAt: 1000 })),
      /invalid_bridge_attempt/,
    );
    const created = store.createBridgeAttempt(attempt());
    assert.throws(
      () =>
        store.confirmBridgeTransportStop(created.id, created.revision, 1100),
      /invalid_bridge_transport_stop/,
    );
    const dispatched = store.compareAndSetBridgeAttempt(
      created.id,
      created.revision,
      { phase: "dispatched", updatedAt: 1100 },
    );
    assert.equal(
      store.confirmBridgeTransportStop(created.id, created.revision, 1200),
      null,
    );
    const stopped = store.confirmBridgeTransportStop(
      created.id,
      dispatched.revision,
      1200,
    );
    assert.equal(stopped.phase, "dispatched");
    assert.equal(stopped.transportStoppedAt, 1200);
    store.close();
    store = createAutomationStateStore({ directory });
    assert.deepEqual(store.readActiveBridgeAttempts(), [stopped]);
    assert.throws(
      () =>
        store.confirmBridgeTransportStop(stopped.id, stopped.revision, 1300),
      /invalid_bridge_transport_stop/,
    );
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
