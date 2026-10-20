import assert from "node:assert/strict";
import test from "node:test";
import {
  findItemBosses,
  getBusinessUpgradeTotals,
} from "../src/lib/business-upgrades.js";

const upgrade = {
  businessId: 12,
  departmentId: 3,
  items: [
    { entityId: 20, name: "Parts", levels: [2, 3, 5] },
    { entityId: 21, name: "Fuel", levels: [4, 1] },
  ],
};

test("upgrade totals sum only the requested complete level prefix", () => {
  assert.deepEqual(getBusinessUpgradeTotals(upgrade, 2), [
    { ...upgrade.items[0], requiredAmount: 5 },
    { ...upgrade.items[1], requiredAmount: 5 },
  ]);
  assert.equal(getBusinessUpgradeTotals(upgrade, 1)[0].requiredAmount, 2);
  assert.equal(getBusinessUpgradeTotals(upgrade, 3)[1].requiredAmount, null);
});

test("missing, null, invalid, and incomplete counts stay unknown", () => {
  const data = {
    ...upgrade,
    items: [
      { entityId: 1, name: "Missing", levels: [1] },
      { entityId: 2, name: "Null", levels: [1, null] },
      { entityId: 3, name: "Negative", levels: [1, -1] },
      { entityId: 4, name: "Infinite", levels: [1, Infinity] },
    ],
  };
  assert.deepEqual(
    getBusinessUpgradeTotals(data, 2).map(
      ({ requiredAmount }) => requiredAmount,
    ),
    [null, null, null, null],
  );
  assert.deepEqual(getBusinessUpgradeTotals(null, 1), []);
  assert.deepEqual(getBusinessUpgradeTotals(undefined, 1), []);
  assert.deepEqual(getBusinessUpgradeTotals({ items: null }, 1), []);
});

test("zero counts are valid and invalid targets never produce totals", () => {
  const zero = { items: [{ entityId: 1, name: "Free", levels: [0, 0] }] };
  assert.equal(getBusinessUpgradeTotals(zero, 2)[0].requiredAmount, 0);
  for (const target of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    assert.equal(
      getBusinessUpgradeTotals(zero, target)[0].requiredAmount,
      null,
    );
});

test("boss matching uses exact entity IDs and does not infer kill counts", () => {
  const bosses = [
    { id: 9, name: "Second", dropItems: [{ entityId: 202, name: "Part" }] },
    { id: 4, name: "First", dropItems: [{ entityId: "101", name: "Part" }] },
    { id: 7, name: "Neighbor", dropItems: [{ entityId: 102, name: "Other" }] },
  ];
  assert.deepEqual(findItemBosses(bosses, 101), [bosses[1]]);
  assert.deepEqual(findItemBosses(bosses, "202"), [bosses[0]]);
  assert.deepEqual(findItemBosses(bosses, 3), []);
  assert.deepEqual(findItemBosses(null, 101), []);
  assert.deepEqual(
    findItemBosses([{ id: 1, dropItems: [{ entityId: 101 }] }], 101),
    [{ id: 1, dropItems: [{ entityId: 101 }] }],
  );
});
