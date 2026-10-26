import test from "node:test";
import assert from "node:assert/strict";
import {
  buildBusinessAssistantPlan,
  normalizeBusinessDetails,
  normalizeBusinessInventory,
} from "../src/lib/business-assistant.js";

const business = { id: "business:17", apiId: "17", title: "Мастерская" };

function fixture(overrides = {}) {
  return {
    business,
    upgrade: {
      items: [
        { entityId: 51, name: "Болт", levels: [2, 3, 5] },
        { entityId: 52, name: "Ключ", levels: [1, 0, 2] },
      ],
      sourceTotals: [
        { itemName: "Болт", declared: 11, computed: 10, matches: false },
      ],
    },
    bosses: [
      {
        id: "boss:901",
        numericId: 901,
        name: "Сборщик",
        image: "/boss.webp",
        dropItems: [{ entityId: 51 }],
      },
      {
        id: "boss:902",
        apiId: 902,
        name: "Смотритель",
        possibleDrops: [{ type: "activity_item", entityId: 52 }],
      },
    ],
    config: { targetLevel: 2, currentLevelOverride: null },
    resources: {
      details: {
        [business.id]: {
          level: 1,
          quote: { currency: "gold", amount: 100 },
        },
      },
      inventory: { stock: { 51: 1, 52: 0 }, complete: true },
      updatedAt: "2026-10-24T00:00:00Z",
    },
    ...overrides,
  };
}

test("business details strictly bind API ID and normalize known quote and required stock", () => {
  const normalized = normalizeBusinessDetails(
    {
      id: 17,
      level: 3,
      maxLevel: 8,
      currency: "pills",
      nextUpgradeCurrency: "gold",
      nextUpgradePrice: 0,
      requiredItems: [
        { itemId: 51, requiredAmount: 99, playerAmount: 4 },
        { itemId: 52, requiredAmount: 88, playerAmount: 0 },
      ],
    },
    business,
  );
  assert.deepEqual(normalized, {
    level: 3,
    maxLevel: 8,
    quote: { currency: "gold", amount: 0 },
    requiredStock: { 51: 4, 52: 0 },
    nextRequirements: [
      { entityId: 51, requiredAmount: 99 },
      { entityId: 52, requiredAmount: 88 },
    ],
  });
  assert.equal(
    normalizeBusinessDetails({ id: "17", level: 3 }, business),
    null,
  );
  assert.equal(normalizeBusinessDetails({ id: 18, level: 3 }, business), null);
});

test("missing catalogue recipe uses verified next-level requirements only", () => {
  const details = normalizeBusinessDetails(
    {
      id: 17,
      level: 1,
      maxLevel: 8,
      requiredItems: [{ itemId: 52, requiredAmount: 4, playerAmount: 1 }],
    },
    business,
  );
  const plan = buildBusinessAssistantPlan(
    fixture({
      business: { ...business, maxLevel: 8 },
      upgrade: null,
      config: { targetLevel: 5 },
      resources: {
        details: { [business.id]: details },
        inventory: { stock: { 52: 1 }, complete: true },
      },
    }),
  );
  assert.equal(plan.canCreateGoals, true);
  assert.equal(plan.materials[0].requiredAmount, 4);
  assert.equal(plan.materials[0].missingAmount, 3);
  assert.equal(plan.materials[0].bosses[0].id, 902);
  assert.ok(plan.notes.some((note) => note.includes("следующего уровня")));
  const invalid = normalizeBusinessDetails(
    { id: 17, level: 1, requiredItems: [{ itemId: 52, playerAmount: 1 }] },
    business,
  );
  assert.equal(invalid.nextRequirements, null);
});

test("unknown price formats or explicit unknown currencies produce no quote", () => {
  assert.equal(
    normalizeBusinessDetails(
      { id: 17, nextUpgradePrice: "100", currency: "gold" },
      business,
    ).quote,
    null,
  );
  assert.equal(
    normalizeBusinessDetails(
      {
        id: 17,
        nextUpgradePrice: 100,
        nextUpgradeCurrency: "credits",
        currency: "gold",
      },
      business,
    ).quote,
    null,
  );
  assert.deepEqual(
    normalizeBusinessDetails(
      { id: 17, nextUpgradePrice: 100, currency: "pills" },
      business,
    ).quote,
    { currency: "pills", amount: 100 },
  );
});

test("inventory distinguishes absent, valid empty, invalid and duplicate rows", () => {
  assert.deepEqual(normalizeBusinessInventory(null), {
    stock: {},
    complete: false,
  });
  assert.deepEqual(normalizeBusinessInventory({ activityItems: [] }), {
    stock: {},
    complete: true,
  });
  assert.deepEqual(
    normalizeBusinessInventory({
      activityItems: [
        { itemId: 51, quantity: 2 },
        { itemId: 52, quantity: -1 },
      ],
    }),
    { stock: { 51: 2 }, complete: false },
  );
  assert.deepEqual(
    normalizeBusinessInventory({
      activityItems: [
        { itemId: 51, quantity: 2 },
        { itemId: 51, quantity: 3 },
      ],
    }),
    { stock: {}, complete: false },
  );
});

test("complete empty inventory means known zero for unlisted materials", () => {
  const data = fixture();
  data.resources.inventory = normalizeBusinessInventory({ activityItems: [] });
  const plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.inventoryKnown, true);
  assert.equal(plan.materials[0].ownedAmount, 0);
  assert.equal(plan.materials[0].missingAmount, 3);
});

test("plan uses verified level, sums range, subtracts inventory and maps bosses", () => {
  const plan = buildBusinessAssistantPlan(fixture());
  assert.equal(plan.currentLevelSource, "game");
  assert.equal(plan.currentLevel, 1);
  assert.equal(plan.maxLevel, 3);
  assert.deepEqual(
    plan.materials.map(({ requiredAmount, ownedAmount, missingAmount }) => [
      requiredAmount,
      ownedAmount,
      missingAmount,
    ]),
    [
      [3, 1, 2],
      [0, 0, 0],
    ],
  );
  assert.deepEqual(
    plan.materials.map((item) => item.bosses[0]?.id),
    [901, 902],
  );
  assert.deepEqual(plan.cost, {
    total: 100,
    currency: "gold",
    nextAmount: 100,
    nextCurrency: "gold",
    complete: true,
  });
  assert.equal(plan.sourceNotes.length, 1);
});

test("unknown current level is never assumed to be zero; manual level takes precedence", () => {
  const data = fixture();
  data.resources.details[business.id].level = null;
  let plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.currentLevel, null);
  assert.equal(plan.currentLevelSource, "unknown");
  assert.equal(plan.requirementsKnown, false);
  data.config.currentLevelOverride = 0;
  plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.currentLevel, 0);
  assert.equal(plan.currentLevelSource, "manual");
});

test("partial inventory keeps known stock but leaves unobserved deficits unknown", () => {
  const data = fixture();
  data.resources.inventory = normalizeBusinessInventory({
    activityItems: [
      { itemId: 51, quantity: 2 },
      { itemId: 52, quantity: -1 },
    ],
  });
  const plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.inventoryKnown, false);
  assert.equal(plan.materials[0].missingAmount, 1);
  assert.equal(plan.materials[1].missingAmount, 0);
  assert.equal(plan.canCreateGoals, false);
});

test("single-level and zero-level cost totals are exact; multi-level total is unknown", () => {
  const data = fixture();
  data.config.targetLevel = 2;
  let plan = buildBusinessAssistantPlan(data);
  assert.deepEqual(plan.cost, {
    total: 100,
    currency: "gold",
    nextAmount: 100,
    nextCurrency: "gold",
    complete: true,
  });
  data.config.targetLevel = 1;
  plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.cost.total, 0);
  assert.equal(plan.cost.complete, true);
  data.config.targetLevel = 3;
  plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.cost.total, null);
  assert.equal(plan.cost.nextAmount, 100);
  assert.equal(plan.cost.complete, false);
});

test("max attempts is metadata and does not clamp target level", () => {
  const data = fixture();
  data.config.targetLevel = 3;
  data.config.maxAttempts = 1;
  const before = structuredClone(data);
  const plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.targetLevel, 3);
  assert.equal(plan.config.targetLevel, 3);
  assert.deepEqual(data, before);
});

test("manual level differing from game level makes the quote unknown", () => {
  const data = fixture();
  data.config.currentLevelOverride = 0;
  data.config.targetLevel = 1;
  const plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.cost.total, null);
  assert.equal(plan.cost.nextAmount, null);
  assert.equal(plan.cost.nextCurrency, null);
});

test("unknown current level still returns material rows with unknown quantities", () => {
  const data = fixture();
  data.resources.details[business.id].level = null;
  const plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.requirementsKnown, false);
  assert.deepEqual(
    plan.materials.map(({ entityId, requiredAmount, bosses }) => [
      entityId,
      requiredAmount,
      bosses.length,
    ]),
    [
      [51, null, 1],
      [52, null, 1],
    ],
  );
});

test("current target level needs no recipe rows and has zero requirements", () => {
  const data = fixture();
  data.upgrade.items = [];
  data.resources.details[business.id].level = 1;
  data.config.targetLevel = 1;
  const plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.requirementsKnown, true);
  assert.deepEqual(plan.materials, []);
  assert.equal(plan.cost.total, 0);
});

test("known API max level wins over shorter catalogue recipe range", () => {
  const data = fixture();
  data.business.maxLevel = 6;
  data.config.targetLevel = 6;
  const plan = buildBusinessAssistantPlan(data);
  assert.equal(plan.maxLevel, 6);
  assert.equal(plan.targetLevel, 6);
  assert.equal(plan.requirementsKnown, false);
  assert.ok(plan.materials.every((item) => item.requiredAmount === null));
});

test("duplicate rows with the same material merge; conflicting names are ambiguous", () => {
  const data = fixture();
  data.upgrade.items.push(
    { entityId: 51, name: "Болт", levels: [1, 1, 1] },
    { entityId: 51, name: "Другой предмет", levels: [1, 1, 1] },
  );
  const plan = buildBusinessAssistantPlan(data);
  const bolt = plan.materials.find((item) => item.entityId === 51);
  assert.equal(bolt.requiredAmount, null);
  assert.equal(bolt.ambiguous, true);
  assert.ok(plan.notes.some((note) => note.includes("неоднозначные")));
});

test("a target already passed needs no materials and an absent target is not known", () => {
  const business = {
    id: "business:1",
    apiId: "1",
    title: "Бизнес",
    maxLevel: 5,
  };
  const upgrade = {
    items: [{ entityId: 55, name: "Материал", levels: [2, 3, 4] }],
  };
  const resources = {
    details: {
      "business:1": { level: 3, quote: { amount: 100, currency: "gold" } },
    },
  };
  const plan = buildBusinessAssistantPlan({
    business,
    upgrade,
    resources,
    config: { targetLevel: 2 },
  });
  assert.equal(plan.achieved, true);
  assert.equal(plan.materials[0].missingAmount, 0);
  assert.equal(plan.cost.total, 0);
  const unknown = buildBusinessAssistantPlan({ business, upgrade, resources });
  assert.equal(unknown.requirementsKnown, false);
});
