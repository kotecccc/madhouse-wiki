import test from "node:test";
import assert from "node:assert/strict";
import { workMaxStartArgs } from "./work-max-start.js";

test("MAX queues current-energy mode without refills or stale energy budget", () => {
  const result = workMaxStartArgs(7, {
    workId: 7,
    completedCycles: 12,
    energy: { current: 80 },
  });
  assert.deepEqual(result, {
    workId: 7,
    targetCycles: 13,
    expectedCompletedCycles: 12,
    mode: "energy",
    maxActions: 30000,
    durationHours: null,
    maxBoosters: 0,
    maxDollar: 0,
    allowPurchase: false,
  });
  assert.equal(
    workMaxStartArgs(7, { workId: 8, completedCycles: 12 })
      .expectedCompletedCycles,
    0,
  );
  assert.equal(workMaxStartArgs(0, null), null);
  assert.equal(
    workMaxStartArgs(7, {
      workId: 7,
      completedCycles: Number.MAX_SAFE_INTEGER,
    }),
    null,
  );
});
