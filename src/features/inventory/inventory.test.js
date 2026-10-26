import test from "node:test";
import assert from "node:assert/strict";
import {
  inventoryPaths,
  inventoryCategoryOptions,
  inventoryItems,
  filterInventory,
} from "./inventory.js";
const references = [
  {
    id: "1",
    type: "clothing_item",
    name: "Куртка",
    categoryId: 3,
    facts: {
      purchasePrice: { amount: 20, currency: "gold" },
      stats: { rage: 1 },
    },
  },
  { id: "2", type: "ornament", zoneId: 4 },
  { id: "3", type: "ornament", zoneId: 4 },
  { id: "4", type: "ornament", zoneId: 9 },
  { id: "5", type: "ornament", zoneId: "invalid" },
];
test("inventory requests are bounded to the selected category and known zones", () => {
  assert.deepEqual(inventoryPaths("ornament", references), [
    "/api/ornaments/zones/4",
    "/api/ornaments/zones/9",
  ]);
  assert.deepEqual(inventoryPaths("weapon", references), [
    "/api/clothing/by-category/1",
  ]);
  assert.deepEqual(inventoryPaths("pet", references), [
    "/api/clothing/by-category/9",
  ]);
  assert.deepEqual(inventoryPaths("other", references), []);
});
test("ownership and purchase availability require explicit personal flags", () => {
  const responses = {
    "/api/clothing": {
      catalog: {
        sets: [
          {
            id: 3,
            items: [
              { id: 1, owned: true, equipped: true },
              {
                id: 2,
                owned: false,
                unlocked: true,
                price: { amount: 10, currency: "gold" },
              },
              { id: 3, owned: false, unlocked: false },
              {
                id: 4,
                price: { amount: 10, currency: "gold" },
                unlock: { required: false },
              },
              { id: 5, owned: false, unlocked: true },
              {
                id: 6,
                owned: false,
                unlocked: true,
                price: { amount: -1, currency: "gold" },
              },
            ],
          },
        ],
      },
    },
  };
  const items = inventoryItems("clothing_item", responses, references);
  assert.deepEqual(
    items.map((item) => item.status),
    ["owned", "buyable", "locked", "unknown", "unknown", "unknown"],
  );
  assert.equal(items[0].name, "Куртка");
  assert.equal(items[0].equipped, true);
  assert.deepEqual(items[0].facts.stats, { rage: 1 });
  assert.equal(filterInventory(items, { status: "buyable" }).length, 1);
  assert.equal(filterInventory(items, { status: "equipped" }).length, 1);
  assert.equal(
    filterInventory(items, { search: " КУРТ ", slot: "3", currency: "gold" })
      .length,
    1,
  );
});
test("missing sections do not create false absent items; identities are type scoped", () => {
  assert.deepEqual(inventoryItems("room", {}, references), []);
  const responses = {
    "/api/clothing/by-category/1": {
      items: [
        { weaponId: 2, owned: true },
        { petId: 2, kind: "pet", owned: true },
        { id: -1 },
      ],
    },
  };
  const items = inventoryItems("weapon", responses, references);
  assert.equal(items.length, 1);
  assert.equal(items[0].type, "weapon");
});
test("price sorting groups currencies and leaves unknown prices last without mutating input", () => {
  const items = [
    { id: "1", name: "А", facts: {} },
    {
      id: "2",
      name: "Б",
      facts: { purchasePrice: { currency: "gold", amount: 20 } },
    },
    {
      id: "3",
      name: "В",
      facts: { purchasePrice: { currency: "gold", amount: 5 } },
    },
    {
      id: "4",
      name: "Г",
      facts: { purchasePrice: { currency: "pills", amount: 1 } },
    },
  ];
  assert.deepEqual(
    filterInventory(items, { sort: "price" }).map((item) => item.id),
    ["3", "2", "4", "1"],
  );
  assert.equal(items[0].id, "1");
});

test("category counters include only confirmed purchases from fully loaded categories", () => {
  const price = { currency: "gold", amount: 10 };
  const responses = {
    "/api/rooms": {
      catalog: {
        rooms: [
          { id: 1, owned: false, unlocked: true, price },
          { id: 2, owned: true, unlocked: true, price },
          { id: 3, price },
        ],
      },
    },
    "/api/clothing/by-category/1": { items: [] },
    "/api/ornaments/zones/4": {
      items: [{ elementId: 2, owned: false, unlocked: true, price }],
    },
  };
  const labels = () =>
    Object.fromEntries(
      inventoryCategoryOptions(responses, references).map((option) => [
        option.value,
        option.label,
      ]),
    );
  assert.equal(labels().room, "Комнаты");
  assert.equal(
    inventoryCategoryOptions(responses, references).find(
      (option) => option.value === "room",
    ).count,
    1,
  );
  assert.equal(labels().weapon, "Оружие");
  assert.equal(
    inventoryCategoryOptions(responses, references).find(
      (option) => option.value === "weapon",
    ).count,
    undefined,
  );
  assert.equal(labels().pet, "Питомцы");
  assert.equal(labels().ornament, "Тату");
  responses["/api/ornaments/zones/9"] = { items: [] };
  assert.equal(labels().ornament, "Тату");
  assert.equal(
    inventoryCategoryOptions(responses, references).find(
      (option) => option.value === "ornament",
    ).count,
    1,
  );
  responses["/api/rooms"].catalog.rooms[0].owned = true;
  assert.equal(labels().room, "Комнаты");
});
