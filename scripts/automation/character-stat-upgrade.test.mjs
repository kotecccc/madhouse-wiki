import { test } from "node:test";
import { strict as assert } from "node:assert";
import { upgradeCharacterPoint } from "./character-stat-upgrade.mjs";
import { characterUpgradeQuote } from "../../src/lib/character-stat-upgrades.js";

const profile = () => ({
  playerId: 1,
  wallet: { gold: 1000 },
  characterStats: { madness: { base: 12 } },
  characterStatsUpgrade: {
    resetAtUtc: "2026-10-27T21:00:00Z",
    madness: {
      currency: "gold",
      dailyLimit: 18,
      dailyUsed: 0,
      dailyRemaining: 18,
      nextCost: 500,
      costPerPoint: 500,
      maxCost: 5000,
    },
  },
});
const uuid = "12345678-1234-4234-8234-123456789abc";

test("persists before a single point is submitted and verifies the result", async () => {
  const state = {};
  const before = profile();
  let saves = 0;
  const result = await upgradeCharacterPoint({
    state,
    stat: "madness",
    expected: characterUpgradeQuote(before, "madness", 1),
    getProfile: async () => before,
    operationId: () => uuid,
    persist: () => {
      saves++;
      return true;
    },
    post: async (body) => {
      assert.equal(saves, 1);
      assert.equal(state.pending.id, uuid);
      assert.deepEqual(body, { stat: "madness", amount: 1, operationId: uuid });
      return {
        success: true,
        balance: { gold: 500 },
        characterStats: { madness: { base: 13 } },
        characterStatsUpgrade: {
          resetAtUtc: before.characterStatsUpgrade.resetAtUtc,
          madness: { dailyUsed: 1 },
        },
      };
    },
  });
  assert.equal(result.status, "confirmed");
  assert.equal(state.pending, null);
  assert.equal(saves, 2);
});

test("a confirmed final upgrade is saved in the character snapshot", async () => {
  const before = profile();
  before.characterStatsUpgrade.madness.dailyUsed = 17;
  before.characterStatsUpgrade.madness.dailyRemaining = 1;
  before.characterStatsUpgrade.madness.nextCost = 5000;
  before.characterStatsUpgrade.madness.costPerPoint = 5000;
  before.wallet.gold = 6000;
  const state = { profile: before };
  let saved;
  const result = await upgradeCharacterPoint({
    state,
    stat: "madness",
    expected: characterUpgradeQuote(before, "madness", 1),
    getProfile: async () => before,
    operationId: () => uuid,
    persist: () => {
      saved = structuredClone(state);
      return true;
    },
    post: async () => ({
      success: true,
      balance: { gold: 1000 },
      characterStats: { madness: { base: 13, total: 23 } },
      characterStatsUpgrade: {
        resetAtUtc: before.characterStatsUpgrade.resetAtUtc,
        madness: { dailyLimit: 18, dailyUsed: 18, dailyRemaining: 0 },
      },
    }),
  });
  assert.equal(result.status, "confirmed");
  assert.equal(saved.pending, null);
  assert.equal(saved.profile.characterStatsUpgrade.madness.dailyRemaining, 0);
  assert.equal(saved.profile.characterStats.madness.total, 23);
  assert.equal(saved.profile.wallet.gold, 1000);
});

test("lost response leaves a durable pending operation and forbids replay", async () => {
  const state = {};
  const before = profile();
  let posts = 0;
  const args = {
    state,
    stat: "madness",
    expected: characterUpgradeQuote(before, "madness", 1),
    getProfile: async () => before,
    operationId: () => uuid,
    persist: () => true,
    post: async () => {
      posts++;
      throw new Error("timeout");
    },
  };
  assert.equal((await upgradeCharacterPoint(args)).status, "uncertain");
  assert.equal(state.pending.id, uuid);
  await assert.rejects(
    upgradeCharacterPoint(args),
    /character_upgrade_uncertain/,
  );
  assert.equal(posts, 1);
});

test("a cancelled queued action clears its checkpoint without sending", async () => {
  const state = {};
  const before = profile();
  let saves = 0;
  await assert.rejects(
    upgradeCharacterPoint({
      state,
      stat: "madness",
      expected: characterUpgradeQuote(before, "madness", 1),
      getProfile: async () => before,
      operationId: () => uuid,
      persist: () => {
        saves++;
        return true;
      },
      post: async () => {
        throw Object.assign(new Error("cancelled"), { notDispatched: true });
      },
    }),
    /character_upgrade_cancelled/,
  );
  assert.equal(state.pending, null);
  assert.equal(saves, 2);
});

test("a known game rejection clears the checkpoint; an unexpected charge stays uncertain", async () => {
  const before = profile();
  const state = {};
  const args = {
    state,
    stat: "madness",
    expected: characterUpgradeQuote(before, "madness", 1),
    getProfile: async () => before,
    operationId: () => uuid,
    persist: () => true,
    post: async () => ({
      _explicitRejection: true,
      error: "rage_effect_cap_reached",
    }),
  };
  assert.equal((await upgradeCharacterPoint(args)).status, "rejected");
  assert.equal(state.pending, null);
  args.post = async () => ({
    success: true,
    balance: { gold: 400 },
    characterStats: { madness: { base: 13 } },
    characterStatsUpgrade: {
      resetAtUtc: before.characterStatsUpgrade.resetAtUtc,
      madness: { dailyUsed: 1 },
    },
  });
  assert.equal((await upgradeCharacterPoint(args)).status, "uncertain");
  assert.equal(state.pending.price, 500);
});

test("a changed quote or a failed durable save never dispatches", async () => {
  const before = profile();
  let posts = 0;
  const args = {
    state: {},
    stat: "madness",
    expected: { ...characterUpgradeQuote(before, "madness", 1), nextCost: 1 },
    getProfile: async () => before,
    operationId: () => uuid,
    persist: () => true,
    post: async () => {
      posts++;
    },
  };
  await assert.rejects(
    upgradeCharacterPoint(args),
    /character_upgrade_quote_changed/,
  );
  args.expected = characterUpgradeQuote(before, "madness", 1);
  args.persist = () => false;
  await assert.rejects(
    upgradeCharacterPoint(args),
    /character_upgrade_storage_unavailable/,
  );
  assert.equal(posts, 0);
});

test("multi-point request is checkpointed and confirms the actual bounded charge", async () => {
  const before = profile();
  before.wallet.gold = 10000;
  const quote = characterUpgradeQuote(before, "madness", 3);
  const state = {};
  let confirmed;
  const result = await upgradeCharacterPoint({
    state,
    stat: "madness",
    expected: quote,
    getProfile: async () => before,
    operationId: () => uuid,
    persist: () => true,
    onConfirmed: (q, charge) => {
      confirmed = { amount: q.amount, charge };
    },
    post: async (body) => {
      assert.equal(body.amount, 3);
      assert.equal(state.pending.amount, 3);
      return {
        success: true,
        balance: { gold: 7706 },
        characterStats: { madness: { base: 15 } },
        characterStatsUpgrade: {
          resetAtUtc: before.characterStatsUpgrade.resetAtUtc,
          madness: { dailyUsed: 3 },
        },
      };
    },
  });
  assert.equal(result.status, "confirmed");
  assert.deepEqual(confirmed, { amount: 3, charge: 2294 });
  assert.equal(state.pending, null);
});

test("a lost multi-point response cannot be dispatched again", async () => {
  const before = profile();
  before.wallet.gold = 10000;
  const state = {};
  let posts = 0;
  const args = {
    state,
    stat: "madness",
    expected: characterUpgradeQuote(before, "madness", 3),
    getProfile: async () => before,
    operationId: () => uuid,
    persist: () => true,
    post: async () => {
      posts++;
      throw new Error("timeout");
    },
  };
  assert.equal((await upgradeCharacterPoint(args)).status, "uncertain");
  assert.equal(state.pending.amount, 3);
  await assert.rejects(
    upgradeCharacterPoint(args),
    /character_upgrade_uncertain/,
  );
  assert.equal(posts, 1);
});
