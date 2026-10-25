import assert from "node:assert/strict";
import test from "node:test";
import {
  businessIncomeField,
  normalizeBusinessState,
} from "./business-state.js";

const business = { apiId: 7 };
test("business income display uses rewards, omits zero currencies, and distinguishes unknown from zero", () => {
  assert.deepEqual(
    businessIncomeField([
      ["gold", 0],
      ["pills", 4],
      ["dollar", 2],
      ["exp", 0],
    ]),
    {
      id: "income",
      label: "Доход",
      value: "Доход —",
      content: undefined,
      rewards: [
        ["pill", "Таблетки", 4],
        ["banknote", "Доллары", 2],
      ],
    },
  );
  assert.deepEqual(businessIncomeField([["gold", 0]]), {
    id: "income",
    label: "Доход",
    value: "Доход —",
    content: "Доход —",
    rewards: undefined,
  });
  assert.deepEqual(businessIncomeField([]), {
    id: "income",
    label: "Доход",
    value: "Доход неизвестен",
    content: undefined,
    rewards: undefined,
  });
});
test("personal business level and scalar income come from the matching API entity", () => {
  assert.deepEqual(
    normalizeBusinessState(
      { id: 7, level: 3, currency: "gold", currentIncome: 1200 },
      business,
    ),
    { level: 3, income: [["gold", 1200]] },
  );
  assert.equal(
    normalizeBusinessState({ id: 8, level: 3, currentIncome: 1200 }, business),
    null,
  );
});
test("business income supports known currency maps and preserves confirmed zero", () => {
  assert.deepEqual(
    normalizeBusinessState(
      {
        id: 7,
        level: 0,
        currentIncome: {
          gold: 0,
          pills: 4,
          dollar: 2,
          exp: 9,
          privateField: 100,
        },
      },
      business,
    ),
    {
      level: 0,
      income: [
        ["gold", 0],
        ["pills", 4],
        ["dollar", 2],
        ["exp", 9],
      ],
    },
  );
});
test("missing or malformed business fields remain unknown rather than zero", () => {
  for (const currentIncome of [
    null,
    undefined,
    "120",
    -1,
    { gold: NaN, dollar: -1 },
    [],
    { gold: "3" },
  ]) {
    assert.deepEqual(
      normalizeBusinessState({ id: 7, currentIncome }, business),
      { level: null, income: [] },
    );
  }
});
