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
test("three visible modes resolve identities and authoritative frozen all-drop lists", () => {
  assert.deepEqual(
    BOSS_GOAL_KINDS.map((item) => item.value),
    ["battles", "business_items", "drops"],
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

test("opening requirements prefill remaining victories without a new goal or an attempt cap", async () => {
  const { defaultBattleSettings, battleSettingsConfig } =
    await import("../src/features/bosses/BossBattle/boss-goal-options.js");
  const state = {
    boss,
    openingRequirements: [{ category: "bosses", required: 65, current: 12 }],
  };
  const settings = defaultBattleSettings(state, null);
  assert.equal(settings.target, "53");
  assert.equal(settings.countWins, true);
  assert.equal(
    defaultBattleSettings(state, {
      boss: { id: 7 },
      status: "completed",
      kind: "battles",
      targetCount: 5,
    }).target,
    "53",
  );
  const config = battleSettingsConfig(settings, boss);
  assert.equal(config.targetCount, 53);
  assert.equal(config.maxAttempts, null);
  assert.equal(config.durationHours, 1);
  assert.equal(resolveBossGoal(config, boss).countWins, true);
  assert.equal(
    defaultBattleSettings(
      { boss, openingRequirements: [{ category: "bosses", required: 65 }] },
      null,
    ).target,
    "65",
  );
});

test("saved business settings prefill the material and retain a universal duration", async () => {
  const { defaultBattleSettings, battleSettingsConfig } =
    await import("../src/features/bosses/BossBattle/boss-goal-options.js");
  const saved = {
    boss: { id: 7 },
    kind: "business_items",
    targetCount: 12,
    items: [{ key: "activity_item:4", name: "Материал" }],
    startedAt: 1000,
    deadlineAt: 7201000,
  };
  const settings = defaultBattleSettings({ boss }, saved);
  assert.equal(settings.kind, "business_items");
  assert.equal(settings.target, "12");
  const config = battleSettingsConfig(settings, boss);
  assert.equal(config.itemKey, "activity_item:4");
  assert.equal(config.durationHours, 2);
  assert.equal(config.maxAttempts, null);
  assert.equal(battleSettingsConfig({ ...settings, kind: "time" }, boss), null);
  assert.equal(battleSettingsConfig({ ...settings, target: "0" }, boss), null);
});
