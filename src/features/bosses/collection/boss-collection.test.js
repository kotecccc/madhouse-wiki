import assert from "node:assert/strict";
import test from "node:test";
import {
  getBossCollectibleDrops,
  getCollectionRequests,
  summarizeBossCollection,
} from "./boss-collection.js";

test("collectible extraction whitelists collectible types and deduplicates by type and ID", () => {
  const drops = getBossCollectibleDrops({
    possibleDrops: [
      { type: "room", entityId: 1, mode: "grant" },
      { type: "weapon", itemId: 1, mode: "grant" },
      { type: "pet", entityId: 2, mode: "grant" },
      { type: "clothing_item", itemId: 3, categoryId: 4, mode: "grant" },
      { type: "ornament", elementId: 5, zoneId: 6, mode: "grant" },
      { type: "clothing_item", entityId: 3, categoryId: 4, mode: "grant" },
      { type: "activity_item", entityId: 7, mode: "grant" },
      { type: "stash_ingredient", entityId: 8, setId: 9, ingredientId: 1 },
      { type: "mutagen", entityId: 10 },
      { type: "room", entityId: 0 },
    ],
  });

  assert.deepEqual(drops, [
    { type: "room", id: "1", mode: "grant" },
    { type: "weapon", id: "1", mode: "grant" },
    { type: "pet", id: "2", mode: "grant" },
    { type: "clothing_item", id: "3", mode: "grant", categoryId: 4 },
    { type: "ornament", id: "5", mode: "grant", zoneId: 6 },
    { type: "room", id: null },
  ]);
});

test("collection request paths are stable and deduplicated", () => {
  assert.deepEqual(
    getCollectionRequests([
      { type: "clothing_item", id: "3" },
      { type: "room", id: "1" },
      { type: "weapon", id: "7" },
      { type: "pet", id: "8" },
      { type: "ornament", id: "9", zoneId: 2 },
      { type: "ornament", id: "10" },
      { type: "clothing_item", id: "4" },
    ]),
    [
      "/api/clothing",
      "/api/rooms",
      "/api/clothing/by-category/1",
      "/api/clothing/by-category/9",
      "/api/ornaments/zones/2",
    ],
  );
});

test("partial or missing responses and undefined flags remain unknown", () => {
  const boss = {
    possibleDrops: [
      { type: "room", entityId: 1, mode: "grant" },
      { type: "weapon", entityId: 2, mode: "grant" },
      { type: "pet", entityId: 3, mode: "grant" },
    ],
  };
  const result = summarizeBossCollection(boss, {
    "/api/rooms": { catalog: { rooms: [{ id: 1 }] } },
    "/api/clothing/by-category/1": {
      items: [{ kind: "weapon", weaponId: 2, owned: false }],
    },
  });
  assert.deepEqual(result, {
    total: 3,
    collected: 0,
    known: 1,
    complete: false,
  });
});

test("unlock_for_purchase counts unlock or ownership, while grant requires owned", () => {
  const boss = {
    possibleDrops: [
      { type: "clothing_item", itemId: 11, mode: "unlock_for_purchase" },
      {
        type: "ornament",
        elementId: 12,
        zoneId: 4,
        mode: "unlock_for_purchase",
      },
      { type: "room", entityId: 13, mode: "grant" },
      { type: "weapon", entityId: 14, mode: "grant" },
    ],
  };
  const result = summarizeBossCollection(boss, {
    "/api/clothing": {
      catalog: {
        sets: [
          { items: [{ id: 11, unlocked: true, owned: false }] },
          { items: [{ id: 11, unlocked: true, owned: false }] },
        ],
      },
    },
    "/api/ornaments/zones/4": {
      items: [{ elementId: 12, unlocked: false, owned: true }],
    },
    "/api/rooms": { catalog: { rooms: [{ id: 13, owned: false }] } },
    "/api/clothing/by-category/1": {
      items: [{ kind: "weapon", weaponId: 14, unlocked: true }],
    },
  });
  assert.deepEqual(result, {
    total: 4,
    collected: 2,
    known: 3,
    complete: false,
  });
});

test("many weapons and pets share two category requests and match correct kinds", () => {
  const drops = [
    ...[1, 2, 3].map((itemId) => ({ type: "weapon", itemId, mode: "grant" })),
    ...[4, 5, 6].map((itemId) => ({ type: "pet", itemId, mode: "grant" })),
  ];
  const requests = getCollectionRequests(drops);
  assert.deepEqual(requests, [
    "/api/clothing/by-category/1",
    "/api/clothing/by-category/9",
  ]);
  assert.equal(requests.length, 2);
  assert.deepEqual(
    summarizeBossCollection(
      { possibleDrops: drops },
      {
        "/api/clothing/by-category/1": {
          items: [
            { kind: "weapon", weaponId: 1, owned: true },
            { kind: "weapon", weaponId: 2, owned: false },
            { kind: "pet", petId: 3, owned: true },
          ],
        },
        "/api/clothing/by-category/9": {
          items: [
            { kind: "pet", petId: 4, owned: true },
            { kind: "pet", petId: 5 },
            { kind: "pet", petId: 6, owned: false },
          ],
        },
      },
    ),
    { total: 6, collected: 2, known: 4, complete: false },
  );
});

test("conflicting category ownership flags remain unknown", () => {
  const boss = {
    possibleDrops: [{ type: "weapon", itemId: 7, mode: "grant" }],
  };
  assert.deepEqual(
    summarizeBossCollection(boss, {
      "/api/clothing/by-category/1": {
        items: [
          { kind: "weapon", weaponId: 7, owned: true },
          { kind: "weapon", weaponId: 7, owned: false },
        ],
      },
    }),
    { total: 1, collected: 0, known: 0, complete: false },
  );
});

test("complete requires at least one drop and every drop known and collected", () => {
  const boss = {
    possibleDrops: [{ type: "room", entityId: 20, mode: "grant" }],
  };
  assert.deepEqual(
    summarizeBossCollection(boss, {
      "/api/rooms": { catalog: { rooms: [{ id: 20, owned: true }] } },
    }),
    { total: 1, collected: 1, known: 1, complete: true },
  );
  assert.deepEqual(summarizeBossCollection({ possibleDrops: [] }, {}), {
    total: 0,
    collected: 0,
    known: 0,
    complete: false,
  });
});

test("missing collectible identities prevent a false complete collection", () => {
  const result = summarizeBossCollection(
    {
      possibleDrops: [
        { type: "room", entityId: 1, mode: "unlock_for_purchase" },
        { type: "clothing_item", mode: "unlock_for_purchase" },
      ],
    },
    { "/api/rooms": { catalog: { rooms: [{ id: 1, unlocked: true }] } } },
  );
  assert.deepEqual(result, {
    total: 2,
    collected: 1,
    known: 1,
    complete: false,
  });
});
