import test from "node:test";
import assert from "node:assert/strict";
import {
  detectedRaids,
  observeRaids,
} from "../scripts/automation/raid-observations.mjs";

const base = 10_000_000;
const invitation = (battleId, extra = {}) => ({
  battleId,
  bossId: 7,
  leaderPlayerId: 42,
  available: true,
  expiresAt: base + 100_000,
  bossName: "Босс",
  sender: "Лидер",
  ...extra,
});

test("detects three different battles only for a currently invited leader and boss", () => {
  let history = observeRaids([], [invitation("one")], base);
  history = observeRaids(
    history,
    [invitation("one"), invitation("two")],
    base + 1,
  );
  assert.equal(detectedRaids(history, [invitation("two")], base + 1).length, 0);
  history = observeRaids(history, [invitation("three")], base + 2);
  assert.equal(
    detectedRaids(history, [invitation("three")], base + 2)[0].count,
    3,
  );
  assert.equal(
    detectedRaids(
      history,
      [invitation("three", { leaderPlayerId: 43 })],
      base + 2,
    ).length,
    0,
  );
  assert.equal(
    detectedRaids(history, [invitation("three", { bossId: 8 })], base + 2)
      .length,
    0,
  );
  assert.equal(detectedRaids(history, [], base + 2).length, 0);
});

test("expires old observations and ignores unsafe or inactive invitations", () => {
  let history = observeRaids(
    [],
    [
      invitation("one"),
      invitation("two", { leaderPlayerId: null }),
      invitation("three", { available: false }),
    ],
    base,
  );
  assert.equal(history.length, 1);
  assert.deepEqual(observeRaids(history, [], base + 2 * 60 * 60 * 1000), []);
  history = observeRaids(
    [],
    Array.from({ length: 510 }, (_, i) => invitation(`b${i}`)),
    base,
  );
  assert.equal(history.length, 500);
});
