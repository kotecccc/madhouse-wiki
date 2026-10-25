import test from "node:test";
import assert from "node:assert/strict";
import { bossLevelStatus } from "./boss-level-status.js";

test("boss level status distinguishes entry and reward thresholds", () => {
  const boss = { requiredLevel: 7, rewardUntilLevel: 15 };
  assert.deepEqual(bossLevelStatus(boss, 6), { kind: "underlevel", level: 7 });
  assert.equal(bossLevelStatus(boss, 7), null);
  assert.equal(bossLevelStatus(boss, 15), null);
  assert.deepEqual(bossLevelStatus(boss, 16), { kind: "overlevel", level: 15 });
});

test("unknown player level or unknown thresholds do not invent a status", () => {
  for (const level of [null, undefined, 0, -1, NaN, "16"])
    assert.equal(
      bossLevelStatus({ requiredLevel: 7, rewardUntilLevel: 15 }, level),
      null,
    );
  assert.equal(bossLevelStatus({}, 100), null);
  assert.equal(bossLevelStatus({ rewardUntilLevel: null }, 100), null);
});
