import test from "node:test";
import assert from "node:assert/strict";
import {
  BOSS_GOAL_KINDS,
  goalDropOptions,
  resolveBossGoal,
} from "../src/features/bosses/BossBattle/boss-goal-options.js";
const boss = {
  id: 7,
  name: "Босс",
  reference: {
    possibleDrops: [
      { type: "activity_item", entityId: 4, name: "Материал" },
      { type: "mutagen", mutagenType: "I", mutagenLevel: 1, name: "Мутаген" },
      { type: "activity_item", entityId: 4, name: "Дубликат" },
      { name: "Без идентификатора" },
    ],
  },
};
test("four goal variants resolve identities and authoritative frozen all-drop lists", () => {
  assert.deepEqual(
    BOSS_GOAL_KINDS.map((item) => item.value),
    ["battles", "business_items", "drops", "time"],
  );
  assert.equal(goalDropOptions(boss.reference).length, 2);
  const resolved = resolveBossGoal(
    { bossId: 7, kind: "drops", selection: "all", itemKeys: ["forged"] },
    boss,
  );
  assert.deepEqual(resolved.items, [
    { key: "activity_item:4", name: "Материал" },
    { key: "mutagen:I:1", name: "Мутаген" },
  ]);
  assert.equal(resolved.targetCount, 2);
  const selected = resolveBossGoal(
    {
      bossId: 7,
      kind: "drops",
      selection: "selected",
      itemKeys: ["mutagen:I:1"],
    },
    boss,
  );
  assert.equal(selected.targetCount, 1);
});
test("business goals accept only a catalogue business material and reject forged or duplicate keys", () => {
  const config = {
    bossId: 7,
    kind: "business_items",
    targetCount: 10,
    itemKey: "activity_item:4",
  };
  assert.equal(resolveBossGoal(config, boss).items[0].name, "Материал");
  assert.throws(() =>
    resolveBossGoal({ ...config, itemKey: "mutagen:I:1" }, boss),
  );
  assert.throws(() =>
    resolveBossGoal({ ...config, itemKey: "activity_item:999" }, boss),
  );
  assert.throws(() =>
    resolveBossGoal(
      {
        bossId: 7,
        kind: "drops",
        selection: "selected",
        itemKeys: ["activity_item:4", "activity_item:4"],
      },
      boss,
    ),
  );
  assert.throws(() => resolveBossGoal({ ...config, bossId: 8 }, boss));
});
