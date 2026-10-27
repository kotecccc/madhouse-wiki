import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createCharacterStatBatch } from "./character-stat-batch.mjs";
import { characterUpgradeQuote } from "../../src/lib/character-stat-upgrades.js";

function setup() {
  const state = { pending: null };
  const callbacks = [];
  const profile = {
    wallet: { gold: 10000 },
    characterStats: { madness: { base: 1 } },
    characterStatsUpgrade: {
      resetAtUtc: "2099-01-01T00:00:00Z",
      madness: {
        currency: "gold",
        costPerPoint: 500,
        nextCost: 500,
        maxCost: 1000,
        dailyLimit: 3,
        dailyUsed: 0,
        dailyRemaining: 3,
      },
    },
  };
  let posts = 0;
  const batch = createCharacterStatBatch({
    state,
    read: async () => profile,
    persist: () => true,
    lock: () => true,
    unlock: () => {},
    schedule: (fn) => {
      callbacks.push(fn);
      return fn;
    },
    cancel: () => {},
    step: async (quote, allowed, confirm) => {
      assert.equal(allowed(), true);
      posts++;
      confirm(quote);
      profile.characterStats.madness.base++;
      profile.characterStatsUpgrade.madness.dailyUsed++;
      profile.characterStatsUpgrade.madness.dailyRemaining--;
      return { status: "confirmed" };
    },
  });
  return { state, profile, batch, callbacks, posts: () => posts };
}
async function advance(callbacks) {
  callbacks.shift()();
  await new Promise((resolve) => setImmediate(resolve));
}

test("batch re-reads and accounts for every confirmed point", async () => {
  const h = setup();
  const quote = characterUpgradeQuote(h.profile, "madness", 3);
  h.batch.start({ stat: "madness", amount: 3, quote, budget: quote.maxPrice });
  await advance(h.callbacks);
  await advance(h.callbacks);
  await advance(h.callbacks);
  assert.equal(h.posts(), 3);
  assert.equal(h.state.run.spent, 1500);
  assert.equal(h.state.run.completed, 3);
  assert.equal(h.state.run.status, "completed");
});

test("restart with an uncertain operation does not dispatch another point", () => {
  const h = setup();
  const quote = characterUpgradeQuote(h.profile, "madness", 3);
  h.batch.start({ stat: "madness", amount: 3, quote, budget: quote.maxPrice });
  h.state.pending = { id: "pending" };
  h.batch.resume();
  assert.equal(h.state.run.status, "uncertain");
  assert.equal(h.posts(), 0);
});

test("a restored batch continues after the last confirmed point", async () => {
  const h = setup();
  const quote = characterUpgradeQuote(h.profile, "madness", 3);
  h.batch.start({ stat: "madness", amount: 3, quote, budget: quote.maxPrice });
  await advance(h.callbacks);
  h.batch.dispose();
  const saved = structuredClone(h.state);
  const callbacks = [];
  let posts = 0;
  const restored = createCharacterStatBatch({
    state: saved,
    read: async () => h.profile,
    persist: () => true,
    lock: () => true,
    unlock: () => {},
    schedule: (fn) => {
      callbacks.push(fn);
      return fn;
    },
    cancel: () => {},
    step: async (next, allowed, confirm) => {
      assert.equal(allowed(), true);
      posts++;
      confirm(next);
      h.profile.characterStats.madness.base++;
      h.profile.characterStatsUpgrade.madness.dailyUsed++;
      h.profile.characterStatsUpgrade.madness.dailyRemaining--;
      return { status: "confirmed" };
    },
  });
  restored.resume();
  await advance(callbacks);
  await advance(callbacks);
  assert.equal(posts, 2);
  assert.equal(saved.run.completed, 3);
  assert.equal(saved.run.status, "completed");
});

test("a rising point price cannot exceed the confirmed spending limit", async () => {
  const h = setup();
  const quote = characterUpgradeQuote(h.profile, "madness", 3);
  h.batch.start({ stat: "madness", amount: 3, quote, budget: quote.maxPrice });
  await advance(h.callbacks);
  h.profile.characterStatsUpgrade.madness.costPerPoint = 3000;
  h.profile.characterStatsUpgrade.madness.nextCost = 3000;
  h.profile.characterStatsUpgrade.madness.maxCost = 3000;
  await advance(h.callbacks);
  assert.equal(h.posts(), 1);
  assert.equal(h.state.run.status, "stopped");
});

test("stop during a pending read prevents the next mutation", async () => {
  const base = setup();
  let release;
  let posts = 0;
  const callbacks = [];
  const read = new Promise((resolve) => {
    release = resolve;
  });
  const batch = createCharacterStatBatch({
    state: base.state,
    read: () => read,
    step: async () => {
      posts++;
      return { status: "confirmed" };
    },
    persist: () => true,
    lock: () => true,
    unlock: () => {},
    schedule: (fn) => {
      callbacks.push(fn);
      return fn;
    },
    cancel: () => {},
  });
  const quote = characterUpgradeQuote(base.profile, "madness", 3);
  batch.start({ stat: "madness", amount: 3, quote, budget: quote.maxPrice });
  callbacks.shift()();
  batch.stop();
  release(base.profile);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posts, 0);
  assert.equal(base.state.run.status, "stopped");
});

test("all stats run in order within individual budgets", async () => {
  const h = setup();
  h.profile.characterStats.aggression = { base: 1 };
  h.profile.characterStatsUpgrade.aggression = {
    ...h.profile.characterStatsUpgrade.madness,
    dailyLimit: 1,
    dailyUsed: 0,
    dailyRemaining: 1,
  };
  const first = characterUpgradeQuote(h.profile, "madness", 3);
  const second = characterUpgradeQuote(h.profile, "aggression", 1);
  const callbacks = [];
  const calls = [];
  const batch = createCharacterStatBatch({
    state: h.state,
    read: async () => h.profile,
    persist: () => true,
    lock: () => true,
    unlock: () => {},
    schedule: (fn) => {
      callbacks.push(fn);
      return fn;
    },
    cancel: () => {},
    step: async (quote, allowed, confirm) => {
      assert.ok(allowed());
      calls.push(quote.stat);
      confirm(quote);
      h.profile.characterStats[quote.stat].base++;
      h.profile.characterStatsUpgrade[quote.stat].dailyUsed++;
      h.profile.characterStatsUpgrade[quote.stat].dailyRemaining--;
      return { status: "confirmed" };
    },
  });
  batch.startAll([first, second]);
  for (let i = 0; i < 4; i++) await advance(callbacks);
  assert.deepEqual(calls, ["madness", "madness", "madness", "aggression"]);
  assert.equal(h.state.run.status, "completed");
  assert.equal(h.state.run.completed, 4);
  batch.dispose();
});

test("queued upgrade waits for a busy account and refuses a changed quote", async () => {
  const h = setup();
  const quote = characterUpgradeQuote(h.profile, "madness", 1);
  let busy = true;
  let posts = 0;
  const callbacks = [];
  const batch = createCharacterStatBatch({
    state: h.state,
    read: async () => h.profile,
    step: async () => {
      posts++;
      return { status: "confirmed" };
    },
    persist: () => true,
    lock: () => !busy,
    unlock: () => {},
    schedule: (fn) => {
      callbacks.push(fn);
      return fn;
    },
    cancel: () => {},
  });
  batch.start({ stat: "madness", amount: 1, quote, budget: quote.maxPrice });
  await advance(callbacks);
  assert.equal(posts, 0);
  assert.equal(h.state.run.status, "running");
  h.profile.characterStatsUpgrade.madness.costPerPoint = 600;
  h.profile.characterStatsUpgrade.madness.nextCost = 600;
  busy = false;
  await advance(callbacks);
  assert.equal(posts, 0);
  assert.equal(h.state.run.status, "stopped");
  batch.dispose();
});

test("preflight outage retains the goal and retries on the persisted backoff", async () => {
  const h = setup();
  const quote = characterUpgradeQuote(h.profile, "madness", 1);
  const callbacks = [];
  let offline = true,
    now = 1000,
    posts = 0;
  const state = { pending: null };
  const batch = createCharacterStatBatch({
    state,
    now: () => now,
    random: () => 0,
    read: async () => {
      if (offline) throw new Error("offline");
      return h.profile;
    },
    step: async (value, _allowed, confirm) => {
      posts++;
      confirm(value);
      return { status: "confirmed" };
    },
    persist: () => true,
    lock: () => true,
    unlock: () => {},
    schedule: (fn, delay) => {
      callbacks.push({ fn, delay });
      return fn;
    },
    cancel: () => {},
  });
  batch.start({ stat: "madness", amount: 1, quote, budget: quote.maxPrice });
  callbacks.shift().fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.run.status, "running");
  assert.equal(state.run.phase, "waiting");
  assert.equal(state.run.nextRetryAt, 11000);
  assert.equal(callbacks[0].delay, 10000);
  assert.equal(posts, 0);
  offline = false;
  now = 11000;
  callbacks.shift().fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.run.status, "completed");
  assert.equal(posts, 1);
});

test("a stopped batch reconciles its submitted point without resuming or repeating", async () => {
  const h = setup();
  const quote = characterUpgradeQuote(h.profile, "madness", 1);
  const state = { pending: null };
  const callbacks = [];
  const batch = createCharacterStatBatch({
    state,
    read: async () => h.profile,
    persist: () => true,
    lock: () => true,
    unlock: () => {},
    schedule: (fn) => {
      callbacks.push(fn);
      return fn;
    },
    cancel: () => {},
    step: async (value, _allowed, _confirm, runId) => {
      state.pending = {
        id: "pending",
        runId,
        stat: "madness",
        base: 1,
        dailyUsed: 0,
        resetAt: value.resetAt,
        currency: "gold",
        balance: 10000,
        price: 500,
      };
      return { status: "uncertain" };
    },
  });
  batch.start({ stat: "madness", amount: 1, quote, budget: quote.maxPrice });
  await advance(callbacks);
  assert.equal(state.run.phase, "reconciling");
  batch.stop();
  h.profile.characterStats.madness.base = 2;
  h.profile.characterStatsUpgrade.madness.dailyUsed = 1;
  h.profile.wallet.gold = 9500;
  await advance(callbacks);
  assert.equal(state.pending, null);
  assert.equal(state.run.status, "stopped");
  assert.equal(state.run.completed, 1);
  assert.equal(state.run.spent, 500);
});
