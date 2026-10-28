import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createActionQueue } from "./action-queue.mjs";
import { createCharacterStatBatch } from "./character-stat-batch.mjs";
import { queuedCharacterRunAdapter } from "./queued-character-run.mjs";
import { createAutomationStateStore } from "./state-store.mjs";
import { createAutomationService } from "./service.mjs";
import { characterUpgradeQuote } from "../../src/lib/character-stat-upgrades.js";

function profile() {
  return {
    wallet: { gold: 10000, pills: 10000 },
    characterStats: { madness: { base: 20, total: 20 } },
    characterStatsUpgrade: {
      resetAtUtc: "2099-01-01T00:00:00Z",
      madness: {
        currency: "gold",
        costPerPoint: 500,
        nextCost: 500,
        maxCost: 5000,
        dailyLimit: 18,
        dailyUsed: 0,
        dailyRemaining: 18,
      },
    },
  };
}

test("queued upgrade rejects altered price or amount and records its fixed budget", async () => {
  const data = profile();
  const entry = { characterUpgrade: { profile: data, pending: null } };
  entry.characterBatch = createCharacterStatBatch({
    state: entry.characterUpgrade,
    persist: () => true,
    lock: () => true,
    unlock: () => {},
    schedule: () => 1,
    cancel: () => {},
  });
  const adapter = queuedCharacterRunAdapter({ entry });
  const quote = characterUpgradeQuote(data, "madness", 1);
  assert.throws(
    () => adapter.validate({ quotes: [{ ...quote, maxPrice: 1 }] }),
    /character_upgrade_quote_changed/,
  );
  let stored;
  const queue = createActionQueue({
    adapters: { "character.start": adapter },
    persist: (value) => {
      stored = value;
    },
  });
  queue.add({
    id: "character-01",
    type: "character.start",
    args: { quotes: [quote] },
  });
  await queue.tick();
  assert.equal(stored[0].status, "completed");
  assert.equal(entry.characterUpgrade.run.budget, quote.maxPrice);
  assert.equal(entry.characterUpgrade.run.queueId, "character-01");
  entry.characterBatch.stop();
  entry.characterBatch.start({
    stat: "madness",
    amount: 1,
    quote,
    budget: quote.maxPrice,
  });
  assert.equal(
    (await adapter.reconcile({ id: "character-01" })).status,
    "completed",
  );
  assert.equal(entry.characterUpgrade.run.queueId, null);
  entry.characterBatch.dispose();
});

test("a second character goal waits for the current batch and can be cancelled", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-character-"));
  const store = createAutomationStateStore({ directory });
  const service = createAutomationService({
    store,
    identifyPlayer: async () => ({ playerId: 17 }),
    fetcher: async () => {
      throw new Error("offline");
    },
    getBoss: () => null,
    schedule: () => 1,
    cancel: () => {},
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    entry.characterUpgrade.profile = profile();
    const quote = characterUpgradeQuote(
      entry.characterUpgrade.profile,
      "madness",
      1,
    );
    entry.characterBatch.start({
      stat: "madness",
      amount: 1,
      quote,
      budget: quote.maxPrice,
    });
    await assert.rejects(
      service.command(entry, {
        id: "character-invalid",
        command: "character.start",
        expectedVersion: 0,
        args: { stat: "madness", amount: 2, expected: quote },
      }),
      /invalid_character_upgrade/,
    );
    await service.command(entry, {
      id: "character-01",
      command: "character.upgrade",
      expectedVersion: 0,
      args: { stat: "madness", expected: quote },
    });
    assert.equal(entry.actionQueue.snapshot()[0].type, "character.start");
    assert.equal(entry.actionQueue.hasDue(), false);
    entry.characterBatch.stop();
    assert.equal(entry.actionQueue.hasDue(), true);
    await entry.actionQueue.tick();
    assert.equal(entry.characterUpgrade.run.queueId, "character-01");
    await service.command(entry, {
      id: "cancel-character-01",
      command: "queue.cancel",
      expectedVersion: 0,
      args: { id: "character-01" },
    });
    assert.equal(entry.characterUpgrade.run.status, "stopped");
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a restarted service reconciles a started character goal without starting it again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "queued-character-restart-"));
  const store = createAutomationStateStore({ directory });
  let clock = 1_000_000;
  const makeService = () =>
    createAutomationService({
      store,
      identifyPlayer: async () => ({ playerId: 17 }),
      fetcher: async () => {
        throw new Error("offline");
      },
      getBoss: () => null,
      now: () => clock,
      schedule: () => 1,
      cancel: () => {},
    });
  let service = makeService();
  try {
    let entry = await service.identify("Bearer fake-token");
    entry.characterUpgrade.profile = profile();
    const quote = characterUpgradeQuote(
      entry.characterUpgrade.profile,
      "madness",
      1,
    );
    await service.command(entry, {
      id: "character-01",
      command: "queue.enqueue",
      expectedVersion: 0,
      args: { type: "character.start", action: { quotes: [quote] } },
    });
    await entry.actionQueue.tick();
    const runId = entry.characterUpgrade.run.id;
    const saved = store.read("17");
    saved.queuedActions[0].status = "running";
    service.close();
    store.write("17", saved);
    clock += 1000;
    service = makeService();
    entry = await service.identify("Bearer fake-token");
    assert.equal(entry.actionQueue.hasDue(), true);
    await entry.actionQueue.tick();
    assert.equal(entry.actionQueue.snapshot()[0].status, "completed");
    assert.equal(entry.characterUpgrade.run.id, runId);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
