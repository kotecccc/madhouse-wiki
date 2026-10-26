import test from "node:test";
import assert from "node:assert/strict";
import { inventoryGame } from "../../tests/helpers/inventory-game.mjs";
import { recoverBrokenWeapon } from "./weapon-recovery.mjs";
for (const [label, options, expected] of [
  ["strictly above reserve", { pills: 5001, cost: 100 }, "repair"],
  ["exactly reserve", { pills: 5000, cost: 100 }, "unequip"],
  ["below reserve", { pills: 4999, cost: 100 }, "unequip"],
  ["price exceeds balance", { pills: 6000, cost: 7000 }, "unequip"],
  ["unknown repair cost", { pills: 6000, unknownCost: true }, "unequip"],
  ["zero-cost above reserve", { pills: 6000, cost: 0 }, "repair"],
])
  test(`broken weapon recovery: ${label}`, async () => {
    const entry = { credential: "Bearer fake", equipment: { pending: null } };
    const game = inventoryGame({
      owned: true,
      equipped: true,
      broken: true,
      ...options,
    });
    const result = await recoverBrokenWeapon({
      entry,
      fetcher: game.fetcher,
      save() {},
      makeId: () => "recovery123",
    });
    assert.equal(result.action, expected);
    assert.equal(result.confirmed, true);
    assert.equal(entry.equipment.pending, null);
    assert.equal(game.mutations().length, 1);
    assert.equal(
      game.mutations()[0].path,
      expected === "repair" ? "/api/weapons/repair" : "/api/weapons/select",
    );
    assert.equal(
      game.mutations()[0].method,
      expected === "repair" ? "POST" : "DELETE",
    );
  });
test("healthy, unselected, stale and uncertain weapons cannot trigger automatic spend", async () => {
  for (const options of [{ broken: false }, { equipped: false }]) {
    const entry = { credential: "Bearer fake", equipment: { pending: null } };
    const game = inventoryGame({
      owned: true,
      equipped: true,
      broken: true,
      ...options,
    });
    assert.equal(
      await recoverBrokenWeapon({ entry, fetcher: game.fetcher, save() {} }),
      null,
    );
    assert.equal(game.mutations().length, 0);
  }
  const game = inventoryGame({
    owned: true,
    equipped: true,
    broken: true,
    stale: true,
  });
  await assert.rejects(
    recoverBrokenWeapon({
      entry: { credential: "fake" },
      fetcher: game.fetcher,
      save() {},
    }),
    /unavailable/,
  );
  assert.equal(game.mutations().length, 0);
});
test("lost repair response preserves checkpoint and is never replaced by an automatic removal", async () => {
  const entry = { credential: "Bearer fake", equipment: { pending: null } };
  const game = inventoryGame({
    owned: true,
    equipped: true,
    broken: true,
    failMutation: true,
  });
  await assert.rejects(
    recoverBrokenWeapon({ entry, fetcher: game.fetcher, save() {} }),
    /submission_lost/,
  );
  assert.ok(entry.equipment.pending);
  assert.equal(game.mutations().length, 1);
  assert.equal(
    await recoverBrokenWeapon({ entry, fetcher: game.fetcher, save() {} }),
    null,
  );
  assert.equal(game.mutations().length, 1);
});
