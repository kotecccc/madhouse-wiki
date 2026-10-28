import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTOMATION_STATE_SCHEMA_VERSION,
  migrateAutomationState,
} from "./state-migrations.mjs";

test("legacy state receives a schema marker without changing checkpoints", () => {
  const checkpoint = { operationId: "accepted-once", status: "pending" };
  const migrated = migrateAutomationState({
    version: 7,
    manualBattle: { pending: checkpoint },
  });

  assert.equal(migrated.changed, true);
  assert.equal(migrated.value.schemaVersion, AUTOMATION_STATE_SCHEMA_VERSION);
  assert.deepEqual(migrated.value.manualBattle.pending, checkpoint);
});

test("current state is unchanged and future schemas fail closed", () => {
  const current = { schemaVersion: AUTOMATION_STATE_SCHEMA_VERSION };
  assert.deepEqual(migrateAutomationState(current), {
    value: current,
    changed: false,
  });
  assert.throws(
    () =>
      migrateAutomationState({
        schemaVersion: AUTOMATION_STATE_SCHEMA_VERSION + 1,
      }),
    /version_unsupported/u,
  );
});
