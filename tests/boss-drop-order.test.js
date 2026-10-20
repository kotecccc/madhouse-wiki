import test from "node:test";
import assert from "node:assert/strict";
import { sortBossDrops } from "../src/lib/boss-drop-order.js";

test("boss drops use product type order without mutating source data", () => {
  const types = [
    "mutagen",
    "clothing_item",
    "pet",
    "weapon",
    "room",
    "activity_item",
  ];
  const input = Object.freeze(types.map((type) => Object.freeze({ type })));
  assert.deepEqual(
    sortBossDrops(input).map((d) => d.type),
    ["activity_item", "room", "weapon", "pet", "clothing_item", "mutagen"],
  );
  assert.deepEqual(
    input.map((d) => d.type),
    types,
  );
});
test("clothing sorts head to feet with neck accessories and unknown slots last", () => {
  const items = [5, 2, 4, 3, 6, 8, 7].map((categoryId) => ({
    type: "clothing_item",
    categoryId,
  }));
  assert.deepEqual(
    sortBossDrops(items).map((d) => d.categoryId),
    [8, 6, 3, 4, 2, 5, 7],
  );
  assert.deepEqual(
    sortBossDrops([
      { type: "clothing_item", slotLabel: "Обувь" },
      { type: "clothing_item", slotLabel: "Маска" },
    ]).map((d) => d.slotLabel),
    ["Маска", "Обувь"],
  );
});
test("mutagens use I A X F S Z W families, then numeric levels", () => {
  const drops = ["W", "Z", "S", "F", "X", "A", "I"].map((mutagenType) => ({
    type: "mutagen",
    mutagenType,
    mutagenLevel: 1,
  }));
  drops.push(
    { type: "mutagen", mutagenType: "I", mutagenLevel: 10 },
    { type: "mutagen", name: "Мутаген I-2" },
  );
  assert.deepEqual(
    sortBossDrops(drops).map((d) => d.mutagenType ?? d.name),
    ["I", "Мутаген I-2", "I", "A", "X", "F", "S", "Z", "W"],
  );
});
test("other drops stay before mutagens and equal sort keys retain source order", () => {
  const items = [
    { type: "mutagen", name: "Неизвестный" },
    { type: "unknown", id: 1 },
    { type: "ornament" },
    { type: "stash_ingredient" },
    { type: "unknown", id: 2 },
    { type: "room", id: 3 },
    { type: "room", id: 4 },
  ];
  assert.deepEqual(
    sortBossDrops(items).map((d) => d.id ?? d.type),
    [3, 4, "ornament", "stash_ingredient", 1, 2, "mutagen"],
  );
  assert.deepEqual(sortBossDrops(), []);
});
