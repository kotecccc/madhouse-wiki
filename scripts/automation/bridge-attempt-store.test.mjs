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
