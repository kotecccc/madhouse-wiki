import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { itemFacts } from "../scripts/catalogue/item-facts.mjs";
import { CatalogueStore } from "../scripts/catalogue/store.mjs";
import { readKnowledgeBase } from "../scripts/catalogue/query.mjs";

test("mutagen facts use exact static bonuses and installation cost, preserving zero", () => {
  const facts = itemFacts(
    {
      madnessBonus: 3,
      aggressionBonus: 0,
      rageBonus: 2,
      installPillCost: 0,
      playerAmount: 99,
      equipped: true,
    },
    "mutagen",
  );
  assert.deepEqual(facts.stats, { madness: 3, aggression: 0, rage: 2 });
  assert.deepEqual(facts.installPrice, { amount: 0, currency: "pills" });
  assert.equal(JSON.stringify(facts).includes("playerAmount"), false);
  assert.equal(itemFacts(null, "mutagen"), null);
});
test("item facts separate base and per-level stats and do not invent unknown prices", () => {
  const facts = itemFacts(
    {
      baseBonus: { aggression: 4, rage: 1, attackCooldownSeconds: 4 },
      bonusPerLevel: { aggression: 1, attackCooldownReductionSeconds: 0.04 },
      price: { currency: "gold", amount: 85 },
      bonuses: { aggression: 999 },
      wallet: { gold: 100 },
    },
    "weapon",
  );
  assert.equal(facts.stats.aggression, 4);
  assert.equal(facts.perLevelStats.attackCooldownReductionSeconds, 0.04);
  assert.deepEqual(facts.purchasePrice, { currency: "gold", amount: 85 });
  assert.equal(itemFacts({ price: null }, "room").purchasePrice, null);
  assert.deepEqual(
    itemFacts({ itemBonus: { rage: 8 }, bonusAmount: 113 }, "ornament_element")
      .stats,
    { rage: 8 },
  );
});
test("boss loot joins reference stats and prices by kind and entity ID", () => {
  const root = mkdtempSync(join(tmpdir(), "madhouse-item-facts-"));
  const store = new CatalogueStore(
    root,
    join(root, "local-data/madhouse.sqlite"),
  );
  try {
    store.capture("/api/mutagens/state?type=I", 200, {
      type: "I",
      mutagens: [
        { id: 2, name: "Мутаген I-2", madnessBonus: 2, installPillCost: 200 },
      ],
    });
    store.capture("/api/rooms", 200, {
      catalog: {
        rooms: [
          {
            id: 2,
            name: "Палата",
            bonuses: { madness: 9 },
            price: { currency: "dollar", amount: 5 },
          },
        ],
      },
    });
    store.capture("/api/bosses/1", 200, {
      id: 1,
      possibleDrops: [
        { type: "mutagen", entityId: 2 },
        { type: "room", entityId: 2 },
        { type: "weapon", entityId: 999 },
      ],
    });
    const drops = readKnowledgeBase(root).bosses[0].possibleDrops;
    assert.equal(drops[0].facts.stats.madness, 2);
    assert.equal(drops[0].facts.installPrice.amount, 200);
    assert.equal(drops[1].facts.stats.madness, 9);
    assert.equal(drops[1].facts.purchasePrice.amount, 5);
    assert.equal(drops[2].facts, null);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
