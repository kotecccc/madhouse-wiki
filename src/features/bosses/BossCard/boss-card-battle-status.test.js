import test from "node:test";
import assert from "node:assert/strict";
import {
  activeBattleForBoss,
  bossHealthPercent,
} from "./boss-card-battle-status.js";

test("card battle status is scoped to its boss and active battle", () => {
  const battle = { id: "battle-1", status: "active" };
  const state = { boss: { id: 42 }, battle };

  assert.equal(activeBattleForBoss(state, 42), battle);
  assert.equal(activeBattleForBoss(state, 43), null);
  assert.equal(
    activeBattleForBoss({ ...state, battle: { ...battle, status: "won" } }, 42),
    null,
  );
});

test("terminal battle states never produce the active card indicator", () => {
  for (const status of ["won", "lost", "expired", "surrendered", "timed_out"]) {
    assert.equal(
      activeBattleForBoss({ boss: { id: 42 }, battle: { status } }, 42),
      null,
    );
  }
});

test("boss health percentage uses current battle health and handles missing data", () => {
  assert.equal(bossHealthPercent({ bossHealth: 725, bossMaxHealth: 1000 }), 72);
  assert.equal(bossHealthPercent({ bossHealth: 110, bossMaxHealth: 100 }), 100);
  assert.equal(bossHealthPercent({ bossHealth: 0, bossMaxHealth: 0 }), null);
  assert.equal(bossHealthPercent(null), null);
});
