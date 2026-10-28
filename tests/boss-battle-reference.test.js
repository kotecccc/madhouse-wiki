import { sortBossDrops } from "../src/lib/boss-drop-order.js";
import test from "node:test";
import assert from "node:assert/strict";
import {
  bossBattleReference,
  bossBattleLoot,
  bossBattleRewardText,
  bossDropIdentity,
  grantedBattleDrops,
} from "../src/features/bosses/BossBattle/boss-battle-reference.js";

test("reward text contains only received items and known currencies", () => {
  const reference = {
    possibleDrops: [
      { type: "activity_item", entityId: 1, name: "Трофей" },
      { type: "weapon", entityId: 2, name: "Другой предмет" },
    ],
  };
  assert.equal(
    bossBattleRewardText(reference, {
      grantedDrops: [{ type: "activity_item", entityId: 1, amount: 2 }],
      currencyRewards: [{ type: "gold", amount: 10 }],
    }),
    "Трофей ×2, Монеты 10",
  );
  assert.equal(
    bossBattleRewardText(reference, { grantedDrops: [] }),
    "Предметы не выпали.",
  );
});
import {
  createBossBattleController,
  normalizeBattle,
} from "../src/features/bosses/BossBattle/boss-battle-controller.js";

const receipt = (patch = {}) => ({
  type: "activity_item",
  entityId: 9,
  amount: 2,
  granted: true,
  ...patch,
});
const raw = (drops) => ({
  battleId: "fight-1",
  bossId: 7,
  status: "won",
  reward: { drops },
});
const reference = {
  possibleDrops: [
    {
      type: "activity_item",
      entityId: 9,
      name: "Материал",
      image: "/item.png",
    },
    { type: "weapon", entityId: 9, name: "Оружие" },
  ],
};

test("reference projection excludes account state and item ownership", () => {
  const result = bossBattleReference({
    name: "Босс",
    maxHp: 100,
    myKillCount: 99,
    state: { playerLevel: 10 },
    rewardPreview: { gold: 10, wallet: { gold: 999 } },
    possibleDrops: [
      {
        type: "weapon",
        entityId: 9,
        name: "Оружие",
        playerState: { owned: true },
      },
    ],
  });
  assert.equal(result.maxHp, 100);
  assert.equal("myKillCount" in result, false);
  assert.equal("state" in result, false);
  assert.deepEqual(result.rewardPreview, { gold: 10 });
  assert.equal("playerState" in result.possibleDrops[0], false);
});

test("boss facts remain available when game state request fails", async () => {
  const controller = createBossBattleController({
    request: async () => {
      throw new Error("offline");
    },
  });
  controller.open({
    numericId: 7,
    name: "Босс",
    maxHp: 100,
    damageMin: 5,
    damageMax: 10,
    ...reference,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getSnapshot().needsRefresh, true);
  assert.equal(controller.getSnapshot().boss.reference.maxHp, 100);
  assert.equal(controller.getSnapshot().boss.reference.possibleDrops.length, 2);
});

test("a matching granted receipt marks only the correct typed item", () => {
  const battle = normalizeBattle(
    raw([receipt(), receipt({ granted: false, type: "weapon" })]),
    7,
  );
  const rows = bossBattleLoot(reference, battle);
  assert.equal(rows[0].received, true);
  assert.equal(rows[0].amount, 2);
  assert.equal(rows[0].item.image, "/item.png");
  assert.equal(rows[1].received, false);
});

test("names and a catalogue amount never imply a received item", () => {
  const rows = bossBattleLoot(reference, {
    grantedDrops: grantedBattleDrops({
      drops: [receipt({ entityId: 10, name: "Материал" })],
    }),
  });
  assert.equal(rows[0].received, false);
  assert.equal(rows[2].received, true);
  assert.equal(
    bossBattleLoot(reference, null).some((row) => row.received),
    false,
  );
});

test("mutagen family/level and stash set keep distinct identities", () => {
  assert.notEqual(
    bossDropIdentity({ type: "mutagen", mutagenType: "I", mutagenLevel: 1 }),
    bossDropIdentity({ type: "mutagen", mutagenType: "A", mutagenLevel: 1 }),
  );
  assert.notEqual(
    bossDropIdentity({ type: "stash_ingredient", setId: 1, ingredientId: 2 }),
    bossDropIdentity({ type: "stash_ingredient", setId: 3, ingredientId: 2 }),
  );
  assert.equal(bossDropIdentity({ type: "mutagen", name: "I-1" }), null);
  assert.equal(bossDropIdentity({ type: "weapon", entityId: -1 }), null);
});

test("refreshing the same fight does not accumulate receipt amounts", () => {
  const first = bossBattleLoot(
    reference,
    normalizeBattle(raw([receipt(), receipt({ amount: 3 })]), 7),
  );
  const refreshed = bossBattleLoot(
    reference,
    normalizeBattle(raw([receipt(), receipt({ amount: 3 })]), 7),
  );
  assert.equal(first[0].amount, 5);
  assert.deepEqual(first, refreshed);
  assert.deepEqual(
    grantedBattleDrops({
      drops: [
        receipt({ amount: 0 }),
        receipt({ amount: -1 }),
        receipt({ granted: false }),
      ],
    }),
    [],
  );
});

test("battle projection preserves head-to-feet clothing sorting metadata", () => {
  const projected = bossBattleReference({
    possibleDrops: [5, 4, 2, 3, 6, 8].map((categoryId) => ({
      type: "clothing_item",
      categoryId,
      entityId: categoryId,
    })),
  });
  assert.deepEqual(
    sortBossDrops(projected.possibleDrops).map((item) => item.categoryId),
    [8, 6, 3, 4, 2, 5],
  );
});

test("received mutagen levels use the canonical asset route even outside the boss preview", () => {
  const rows = bossBattleLoot(
    { possibleDrops: [] },
    {
      grantedDrops: [
        { type: "mutagen", mutagenType: "I", mutagenLevel: 5, amount: 1 },
        { type: "mutagen", mutagenType: "I", mutagenLevel: 6, amount: 1 },
      ],
    },
  );
  assert.deepEqual(
    rows.map((row) => row.item.image),
    [
      "https://cdn.cargohustle.online/V3/mutogen/I/5.webp",
      "https://cdn.cargohustle.online/V3/mutogen/I/6.webp",
    ],
  );
  assert.ok(rows.every((row) => row.received));
});

test("reward grant flags are known only when every drop has an explicit result", () => {
  assert.equal(normalizeBattle(raw([]), 7).rewardFlagsKnown, true);
  assert.equal(normalizeBattle(raw([receipt()]), 7).rewardFlagsKnown, true);
  assert.equal(
    normalizeBattle(raw([receipt({ granted: undefined })]), 7).rewardFlagsKnown,
    false,
  );
});
