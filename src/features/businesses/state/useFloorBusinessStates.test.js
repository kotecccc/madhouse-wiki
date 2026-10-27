import { test } from "node:test";
import { strict as assert } from "node:assert";
import { completedUpgradeNeedsFloorRefresh } from "./useFloorBusinessStates.js";

test("only a completed upgrade with a lower cached floor level requests a fresh read", () => {
  const run = {
    id: "run-1",
    businessId: "business:37",
    status: "completed",
    targetLevel: 1,
    config: { autoUpgrade: true },
  };
  assert.equal(
    completedUpgradeNeedsFloorRefresh(run, { 37: { level: 0 } }),
    true,
  );
  assert.equal(
    completedUpgradeNeedsFloorRefresh(run, { 37: { level: 1 } }),
    false,
  );
  assert.equal(
    completedUpgradeNeedsFloorRefresh(run, { 38: { level: 0 } }),
    false,
  );
  assert.equal(
    completedUpgradeNeedsFloorRefresh(
      { ...run, status: "running" },
      { 37: { level: 0 } },
    ),
    false,
  );
  assert.equal(
    completedUpgradeNeedsFloorRefresh(
      { ...run, config: {} },
      { 37: { level: 0 } },
    ),
    false,
  );
  assert.equal(
    completedUpgradeNeedsFloorRefresh(
      { ...run, businessId: "invalid" },
      { 37: { level: 0 } },
    ),
    false,
  );
});
