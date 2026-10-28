import test from "node:test";
import assert from "node:assert/strict";
import { bossTargetAction, battleCountLabel } from "./boss-target-action.js";

test("target actions count remaining confirmed wins and do not invent unknown progress", () => {
  const boss = { apiId: 55 };
  const target = { category: "bosses", required: 10, current: 4 };
  assert.deepEqual(bossTargetAction(boss, [target]), {
    remaining: 6,
    settings: {
      bossId: 55,
      kind: "battles",
      targetCount: 6,
      countWins: true,
      durationHours: null,
      maxAttempts: null,
    },
  });
  assert.equal(
    bossTargetAction(boss, [{ ...target, current: undefined }]),
    null,
  );
  assert.equal(bossTargetAction(boss, [{ ...target, current: 10 }]), null);
  assert.equal(bossTargetAction(boss, [{ ...target, category: "work" }]), null);
  assert.equal(battleCountLabel(1), "1 бой");
  assert.equal(battleCountLabel(3), "3 боя");
  assert.equal(battleCountLabel(11), "11 боёв");
});
