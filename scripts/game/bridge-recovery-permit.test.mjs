import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createAutomationStateStore } from "../automation/state-store.mjs";
import { createQueueActionGate } from "../bridge/queue-action-gate.mjs";
import { createDirectBoundary } from "./direct-boundary.mjs";

const deviceId = "00000000-0000-4000-8000-000000000001";
const id = "00000000-0000-4000-8000-000000000002";
const authorization = "Bearer fake-token";
const path = "/api/bosses/battles/battle-1";
const job = {
  id: "battle-job-1",
  type: "battle.attack",
  status: "reconciling",
  args: { bossId: 7, battleId: "battle-1" },
};
const base = {
  authorization,
  playerId: "42",
  deviceId,
  bindingRevision: 1,
  deviceGeneration: 1,
  method: "GET",
  path,
};
function fixture({ stopped = true, second = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "bridge-recovery-permit-"));
  const store = createAutomationStateStore({ directory });
  let record = store.createBridgeAttempt({
    id,
    playerId: "42",
    deviceId,
    operationId: job.id,
    checkpointOperationId: "game-operation-1",
    bindingRevision: 1,
    deviceGeneration: 1,
    action: "mutation",
    phase: "prepared",
    createdAt: 1,
    updatedAt: 1,
  });
  record = store.compareAndSetBridgeAttempt(id, record.revision, {
    phase: "dispatched",
    updatedAt: 2,
  });
  record = store.compareAndSetBridgeAttempt(id, record.revision, {
    phase: "uncertain",
    updatedAt: 3,
  });
  if (stopped)
    assert.ok(store.confirmBridgeTransportStop(id, record.revision, 4));
  if (second)
    store.createBridgeAttempt({
      id: "00000000-0000-4000-8000-000000000003",
      playerId: "42",
      deviceId,
      operationId: "other-job-1",
      checkpointOperationId: "other-operation-1",
      bindingRevision: 1,
      deviceGeneration: 1,
      action: "mutation",
      phase: "uncertain",
      createdAt: 1,
      updatedAt: 1,
    });
  const boundary = createDirectBoundary({
    env: {
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
      MADHOUSE_GAME_DEVICE_INTERVAL_MS: "1",
    },
    requireBridgeJournal: true,
  });
  boundary.installBridgeStore(store);
  const gate = createQueueActionGate();
  const checkpoint = {
    id: job.id,
    kind: "attack",
    bossId: 7,
    battleId: "battle-1",
    operationId: "game-operation-1",
  };
  return {
    store,
    boundary,
    gate,
    checkpoint,
    close() {
      boundary.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("a live actor capability permits only its stopped-tunnel battle read and retains the unresolved fence", async () => {
  const f = fixture();
  try {
    let permit;
    await f.gate.run(
      job,
      true,
      authorization,
      async () => {
        permit = f.gate.battleRecoveryPermit({
          authorization,
          method: "GET",
          path,
        });
        assert.ok(permit);
        assert.equal(
          f.gate.battleRecoveryPermit({ authorization, method: "POST", path }),
          null,
        );
        assert.equal(
          f.gate.battleRecoveryPermit({
            authorization,
            method: "GET",
            path: "/api/me",
          }),
          null,
        );
        let calls = 0;
        const result = await f.boundary.bridge({
          ...base,
          recoveryPermit: permit,
          execute: () => {
            calls++;
            return { status: 200 };
          },
        });
        assert.equal(result.status, 200);
        assert.equal(calls, 1);
        assert.equal(f.store.readActiveBridgeAttempts().length, 1);
        await assert.rejects(
          f.boundary.bridge({
            ...base,
            path: "/api/me",
            recoveryPermit: permit,
            execute: () => {
              throw new Error("must not send");
            },
          }),
          (error) => error.notDispatched,
        );
      },
      () => true,
      () => f.checkpoint,
      () => true,
    );
    await assert.rejects(
      f.boundary.bridge({
        ...base,
        recoveryPermit: permit,
        execute: () => {
          throw new Error("must not send");
        },
      }),
      (error) => error.notDispatched,
    );
  } finally {
    f.close();
  }
});

test("missing stop evidence, forged and mismatched checkpoint capabilities fail closed", async () => {
  const f = fixture({ stopped: false });
  try {
    const forged = {
      operationId: job.id,
      checkpointOperationId: "game-operation-1",
      validate: () => true,
    };
    await assert.rejects(
      f.boundary.bridge({
        ...base,
        recoveryPermit: forged,
        execute: () => {
          throw new Error("must not send");
        },
      }),
      (error) => error.notDispatched,
    );
    await f.gate.run(
      job,
      true,
      authorization,
      async () => {
        const permit = f.gate.battleRecoveryPermit({
          authorization,
          method: "GET",
          path,
        });
        assert.ok(permit);
        await assert.rejects(
          f.boundary.bridge({
            ...base,
            recoveryPermit: permit,
            execute: () => {
              throw new Error("must not send");
            },
          }),
          (error) => error.notDispatched,
        );
        f.checkpoint.operationId = "different-operation";
        assert.equal(permit.validate(path), false);
      },
      () => true,
      () => f.checkpoint,
      () => true,
    );
  } finally {
    f.close();
  }
});

test("one recovery permit never bypasses another unresolved attempt", async () => {
  const f = fixture({ second: true });
  try {
    await f.gate.run(
      job,
      true,
      authorization,
      async () => {
        const permit = f.gate.battleRecoveryPermit({
          authorization,
          method: "GET",
          path,
        });
        const controller = new AbortController();
        let sends = 0;
        const waiting = f.boundary.bridge({
          ...base,
          recoveryPermit: permit,
          signal: controller.signal,
          execute: () => {
            sends++;
            return { status: 200 };
          },
        });
        for (let i = 0; i < 10; i++) await Promise.resolve();
        assert.equal(f.boundary.diagnostics().queued, 1);
        controller.abort();
        await assert.rejects(waiting, (error) => error.notDispatched);
        assert.equal(sends, 0);
        assert.equal(f.store.readActiveBridgeAttempts().length, 2);
      },
      () => true,
      () => f.checkpoint,
      () => true,
    );
  } finally {
    f.close();
  }
});
