import test from "node:test";
import assert from "node:assert/strict";
import { raidDropOutcome } from "./raid-drop-outcome.mjs";

test("raid drop goal stops only on confirmed matching collectible rewards", () => {
  const subscription = {
    enabled: true,
    battleId: "b1",
    dropKeys: ["weapon:7"],
  };
  const won = {
    id: "b1",
    status: "won",
    rewardKnown: true,
    rewardFlagsKnown: true,
    grantedDrops: [],
  };
  assert.equal(
    raidDropOutcome(subscription, { ...won, rewardKnown: false }),
    "reward_unknown",
  );
  assert.equal(
    raidDropOutcome(subscription, { ...won, rewardFlagsKnown: false }),
    "reward_unknown",
  );
  assert.equal(
    raidDropOutcome(subscription, { ...won, id: "other" }),
    "uncertain",
  );
  assert.equal(
    raidDropOutcome(subscription, {
      ...won,
      grantedDrops: [{ type: "weapon" }],
    }),
    "uncertain",
  );
  assert.equal(
    raidDropOutcome(subscription, {
      ...won,
      grantedDrops: [{ type: "activity_item", itemId: 7 }],
    }),
    "finished",
  );
  assert.equal(
    raidDropOutcome(subscription, {
      ...won,
      grantedDrops: [{ type: "weapon", itemId: 7 }],
    }),
    "finished_drop",
  );
  assert.equal(
    raidDropOutcome(subscription, {
      ...won,
      status: "lost",
      rewardKnown: false,
    }),
    "finished",
  );
});
