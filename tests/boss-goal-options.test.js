import test from "node:test";
import assert from "node:assert/strict";
import {
  BOSS_GOAL_KINDS,
  goalDropOptions,
  resolveBossGoal,
  restoredShopDropGoal,
} from "../src/features/bosses/BossBattle/boss-goal-options.js";
const boss = {
  id: 7,
  name: "Босс",
  reference: {
    possibleDrops: [
      { type: "activity_item", entityId: 4, name: "Материал" },
      { type: "mutagen", mutagenType: "I", mutagenLevel: 1, name: "Мутаген" },
      { type: "activity_item", entityId: 4, name: "Дубликат" },
      { type: "room", entityId: 8, name: "Комната" },
      { name: "Без идентификатора" },
    ],
  },
};
test("three visible modes resolve identities and authoritative frozen all-drop lists", () => {
  assert.deepEqual(
    BOSS_GOAL_KINDS.map((item) => item.value),
    ["battles", "business_items", "drops"],
  );
  assert.deepEqual(
    BOSS_GOAL_KINDS.map((item) => item.label),
    ["Кол-во", "Бизнес", "Дроп"],
  );
  assert.equal(goalDropOptions(boss.reference).length, 3);
  const resolved = resolveBossGoal(
    { bossId: 7, kind: "drops", selection: "all", itemKeys: ["forged"] },
    boss,
  );
  assert.deepEqual(resolved.items, [{ key: "room:8", name: "Комната" }]);
  assert.equal(resolved.targetCount, 1);
  const selected = resolveBossGoal(
    {
      bossId: 7,
      kind: "drops",
      selection: "selected",
      itemKeys: ["room:8"],
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

test("stopped goals keep the configured duration without a running deadline", async () => {
  const { defaultBattleSettings } =
    await import("../src/features/bosses/BossBattle/boss-goal-options.js");
  const settings = defaultBattleSettings(
    { boss },
    {
      boss: { id: 7 },
      status: "stopped",
      kind: "battles",
      targetCount: 12,
      durationHours: 2,
      startedAt: null,
      deadlineAt: null,
      items: [],
    },
  );
  assert.equal(settings.target, "12");
  assert.equal(settings.hours, "2");
});

test("drop goals allow only shop item categories and migrate saved targets without losing receipts", () => {
  const types = ["room", "weapon", "pet", "clothing_item", "ornament"];
  const reference = {
    possibleDrops: [
      ...types.map((type, index) => ({ type, entityId: index + 1 })),
      { type: "activity_item", entityId: 9 },
      { type: "mutagen", mutagenType: "W", mutagenLevel: 14 },
      { type: "stash_ingredient", setId: 1, ingredientId: 1 },
    ],
  };
  const result = resolveBossGoal(
    { bossId: 7, kind: "drops", selection: "all" },
    { ...boss, reference },
  );
  assert.equal(result.items.length, 5);
  assert.deepEqual(
    result.items.map((i) => i.key.split(":")[0]),
    types,
  );
  assert.throws(
    () =>
      resolveBossGoal(
        {
          bossId: 7,
          kind: "drops",
          selection: "selected",
          itemKeys: ["activity_item:9"],
        },
        { ...boss, reference },
      ),
    /Unknown drop item/,
  );
  const saved = {
    settings: {
      kind: "drops",
      items: [
        ...result.items,
        { key: "activity_item:9" },
        { key: "mutagen:W:14" },
      ],
    },
    receipts: [["old-fight", []]],
    deadlineAt: 12345,
  };
  const migrated = restoredShopDropGoal(saved);
  assert.equal(migrated.settings.items.length, 5);
  assert.equal(migrated.deadlineAt, 12345);
  assert.deepEqual(migrated.receipts, saved.receipts);
});
