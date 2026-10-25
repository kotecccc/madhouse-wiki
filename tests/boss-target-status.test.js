import test from "node:test";
import assert from "node:assert/strict";
import { remainingBossWins } from "../src/features/bosses/DepartmentBossCard/boss-target-status.js";

test("remaining boss wins is the maximum remaining across targets", () => {
  assert.equal(
    remainingBossWins([
      { required: 5, current: 2 },
      { required: 3, current: 1 },
    ]),
    3,
  );
});

test("remaining boss wins returns null when any target count is unknown", () => {
  assert.equal(remainingBossWins([{ required: 5 }]), null);
  assert.equal(
    remainingBossWins([
      { required: 5, current: 2 },
      { required: 3, current: "unknown" },
    ]),
    null,
  );
  assert.equal(remainingBossWins([]), null);
});

test("remaining boss wins accepts completion and rejects unsafe or negative counts", () => {
  assert.equal(remainingBossWins([{ required: 4, current: 4 }]), 0);
  assert.equal(remainingBossWins([{ required: 4, current: 7 }]), 0);
  assert.equal(remainingBossWins([{ required: 4, current: -1 }]), null);
  assert.equal(
    remainingBossWins([{ required: Number.MAX_SAFE_INTEGER + 1, current: 0 }]),
    null,
  );
});
