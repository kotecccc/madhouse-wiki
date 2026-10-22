import test from "node:test";
import assert from "node:assert/strict";
import {
  formatRequirementAmount,
  readOpeningConditionProgress,
} from "./opening-condition-data.js";

test("formats known requirement quantities without treating missing values as zero", () => {
  assert.equal(
    formatRequirementAmount({ type: "business_level", required: 5 }),
    "5 ур.",
  );
  assert.equal(
    formatRequirementAmount({
      type: "business_level",
      requiredLevel: 3,
      required: 5,
    }),
    "3 ур.",
  );
  assert.equal(
    formatRequirementAmount({ type: "work_completions", required: 0 }),
    "×0",
  );
  assert.equal(
    formatRequirementAmount({ type: "boss_kills", required: 4 }),
    "×4",
  );
  assert.equal(
    formatRequirementAmount({ type: "player_level", required: 10 }),
    "10 ур.",
  );
  assert.equal(
    formatRequirementAmount({ type: "combat_rating", required: 120 }),
    "120",
  );
  assert.equal(
    formatRequirementAmount({ type: "rage_total", required: 7 }),
    "7",
  );
  assert.equal(
    formatRequirementAmount({ type: "dice_level", required: 2 }),
    "2 ур.",
  );
  assert.equal(formatRequirementAmount({ type: "work_completions" }), null);
  assert.equal(
    formatRequirementAmount({ type: "unmapped", required: 8 }),
    null,
  );
  assert.equal(formatRequirementAmount({ type: "department_open" }), null);
  assert.equal(formatRequirementAmount({ type: "stash_medallion" }), null);
});

test("progress is shown only for explicit nonnegative numeric values", () => {
  assert.deepEqual(readOpeningConditionProgress({ current: 2, total: 5 }), {
    current: 2,
    total: 5,
  });
  assert.deepEqual(readOpeningConditionProgress({ current: 0, total: 0 }), {
    current: 0,
    total: 0,
  });
  assert.equal(readOpeningConditionProgress(undefined), null);
  assert.equal(readOpeningConditionProgress({ current: 1 }), null);
  assert.equal(readOpeningConditionProgress({ current: -1, total: 2 }), null);
  assert.equal(readOpeningConditionProgress({ current: "1", total: 2 }), null);
});
