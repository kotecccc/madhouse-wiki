import assert from "node:assert/strict";
import { test } from "node:test";
import {
  observeTelegramBattle,
  formatTelegramBattle,
} from "./telegram-battle-report.mjs";
import { createTelegramBattleNotifier } from "./telegram-battle-notifier.mjs";

const active = {
  id: "battle-1",
  bossId: 7,
  status: "active",
  bossHealth: 80,
  bossMaxHealth: 100,
  playerHealth: 40,
  playerMaxHealth: 100,
  totalDamage: 20,
  dropDamageRequired: 30,
};
const base = {
  boss: { id: 7, name: "Boss <A>" },
  auto: { enabled: true },
  raid: { enabled: false },
  subscription: { enabled: false },
  now: 1000,
};

test("confirmed battle results are persisted once and late rewards update the summary", () => {
  let report = observeTelegramBattle(
    { enabled: true },
    { ...base, battle: active },
  );
  const finished = { ...active, status: "won", rewardKnown: false };
  report = observeTelegramBattle(report, { ...base, battle: finished });
  report = observeTelegramBattle(report, { ...base, battle: finished });
  assert.equal(Object.keys(report.run.battles).length, 1);
  assert.match(
    formatTelegramBattle(report, { ...base, battle: finished }),
    /Награда уточняется/,
  );
  report = observeTelegramBattle(report, {
    ...base,
    auto: { enabled: false },
    battle: finished,
    now: 1500,
  });
  report = observeTelegramBattle(report, {
    ...base,
    auto: { enabled: false },
    battle: {
      ...finished,
      rewardKnown: true,
      currencyRewards: [{ type: "gold", amount: 100 }],
      grantedDrops: [
        { name: "Drop", amount: 2 },
        { type: "mutagen", mutagenType: "A", mutagenLevel: 6, amount: 1 },
      ],
    },
    healing: { used: { heal_10: 1 } },
    now: 2000,
  });
  assert.equal(report.run.endedAt, 1500);
  const text = formatTelegramBattle(report, {
    ...base,
    battle: finished,
    online: true,
  });
  assert.match(text, /1 боёв, побед: 1/);
  assert.match(text, /Boss &lt;A&gt;/);
  assert.match(text, /100 монет/);
  assert.match(text, /Drop ×2/);
  assert.match(text, /Мутаген A-6 ×1/);
  assert.match(text, /аптечек: 1/);
});

test("pausing a raid preserves the same series until resumed", () => {
  let report = observeTelegramBattle(
    { enabled: true },
    { ...base, battle: active },
  );
  const startedAt = report.run.startedAt;
  report = observeTelegramBattle(report, {
    ...base,
    battle: null,
    auto: { enabled: false },
    raid: { enabled: false, userPaused: true },
    now: 2000,
  });
  assert.equal(report.run.startedAt, startedAt);
  assert.equal(report.run.endedAt, null);
  assert.match(
    formatTelegramBattle(report, { raid: { userPaused: true } }),
    /На паузе/,
  );
});

test("the current battle distinguishes defeat from victory", () => {
  const report = observeTelegramBattle(
    { enabled: true },
    { ...base, battle: active },
  );
  assert.match(
    formatTelegramBattle(report, { battle: { ...active, status: "lost" } }),
    /Поражение/,
  );
  const pending = formatTelegramBattle(report, {
    battle: { ...active, status: "won" },
    needsRefresh: true,
  });
  assert.match(pending, /Результат боя уточняется/);
  assert.doesNotMatch(pending, /Победа/);
});

test("notifier sends once, edits later, and performs no game requests", async () => {
  let clock = 1000;
  let state = { battle: active, boss: base.boss, needsRefresh: false };
  const calls = [];
  const entry = {
    playerId: "42",
    controller: { getSnapshot: () => state },
    goal: { getSnapshot: () => null },
    raidWorker: { getSnapshot: () => base.raid },
    telegramReport: observeTelegramBattle(
      { enabled: true, owner: "123" },
      { ...base, battle: active },
    ),
  };
  let persisted;
  const notifier = createTelegramBattleNotifier({
    now: () => clock,
    siteUrl: "https://t.me/bot",
    save: () => {
      persisted = structuredClone(entry.telegramReport);
    },
    telegram: {
      ownerForPlayer: () => "123",
      online: async () => true,
      request: async (method, payload) => {
        calls.push({ method, payload, pending: persisted?.pendingSend });
        return { message_id: 15 };
      },
    },
  });
  await notifier.tick(entry);
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].pending, true);
  assert.equal(
    calls[0].payload.reply_markup.inline_keyboard[0][0].web_app.url,
    "https://t.me/boss/7",
  );
  assert.equal(entry.telegramReport.messageId, 15);
  state = { ...state, battle: { ...active, bossHealth: 50 } };
  await notifier.tick(entry);
  assert.equal(calls.length, 1);
  clock += 15000;
  await notifier.tick(entry);
  assert.equal(calls[1].method, "editMessageText");
  assert.equal(calls[1].payload.message_id, 15);
});

test("unknown Telegram send outcome is checkpointed and not repeated after restart", async () => {
  let sends = 0;
  const entry = {
    playerId: "42",
    controller: { getSnapshot: () => ({ battle: active, boss: base.boss }) },
    goal: { getSnapshot: () => null },
    raidWorker: { getSnapshot: () => base.raid },
    telegramReport: observeTelegramBattle(
      { enabled: true, owner: "123" },
      { ...base, battle: active },
    ),
  };
  const options = {
    now: () => 1000,
    siteUrl: "https://t.me/bot",
    save() {},
    telegram: {
      ownerForPlayer: () => "123",
      online: async () => true,
      request: async () => {
        sends++;
        throw new Error("connection lost");
      },
    },
  };
  await createTelegramBattleNotifier(options).tick(entry);
  assert.equal(entry.telegramReport.pendingSend, true);
  entry.telegramReport = JSON.parse(JSON.stringify(entry.telegramReport));
  entry.telegramNextCheckAt = 0;
  await createTelegramBattleNotifier(options).tick(entry);
  assert.equal(sends, 1);
});

test("notifier never sends account details to a different Telegram owner", async () => {
  let sends = 0;
  const entry = {
    playerId: "42",
    telegramReport: observeTelegramBattle(
      { enabled: true, owner: "123" },
      { ...base, battle: active },
    ),
  };
  const notifier = createTelegramBattleNotifier({
    now: () => 1000,
    siteUrl: "https://t.me/bot",
    save() {},
    telegram: {
      ownerForPlayer: () => "456",
      online: async () => true,
      request: async () => {
        sends++;
      },
    },
  });
  await notifier.tick(entry);
  assert.equal(sends, 0);
});

test("a short bridge reconnect does not immediately report an outage", async () => {
  let clock = 1000;
  const calls = [];
  const entry = {
    playerId: "42",
    controller: { getSnapshot: () => ({ battle: active, boss: base.boss }) },
    goal: { getSnapshot: () => null },
    raidWorker: { getSnapshot: () => base.raid },
    telegramReport: observeTelegramBattle(
      { enabled: true, owner: "123" },
      { ...base, battle: active },
    ),
  };
  const notifier = createTelegramBattleNotifier({
    now: () => clock,
    siteUrl: "https://wiki.example",
    save() {},
    telegram: {
      ownerForPlayer: () => "123",
      online: async () => false,
      request: async (method, payload) => {
        calls.push({ method, text: payload.text });
        return { message_id: 15 };
      },
    },
  });
  await notifier.tick(entry);
  assert.doesNotMatch(calls[0].text, /потеряна/);
  clock += 15000;
  await notifier.tick(entry);
  assert.match(calls[1].text, /с мостом потеряна/);
});

test("disabling notifications during a status check prevents a late send", async () => {
  let release;
  let sends = 0;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const entry = {
    playerId: "42",
    controller: { getSnapshot: () => ({ battle: active, boss: base.boss }) },
    goal: { getSnapshot: () => null },
    raidWorker: { getSnapshot: () => base.raid },
    telegramReport: observeTelegramBattle(
      { enabled: true, owner: "123" },
      { ...base, battle: active },
    ),
  };
  const notifier = createTelegramBattleNotifier({
    now: () => 1000,
    siteUrl: "https://wiki.example",
    save() {},
    telegram: {
      ownerForPlayer: () => "123",
      online: () => waiting,
      request: async () => {
        sends++;
      },
    },
  });
  const pending = notifier.tick(entry);
  entry.telegramReport = { ...entry.telegramReport, enabled: false };
  release(true);
  await pending;
  assert.equal(sends, 0);
});

test("notification settings, current run and message ID survive service restart", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "telegram-report-state-"));
  const store = createAutomationStateStore({ directory });
  const calls = [];
  let boundOwner = "123";
  const telegram = {
    ownerForPlayer: (id) => (id === "42" ? boundOwner : null),
    online: async () => true,
    request: async (method) => {
      calls.push(method);
      return { message_id: 77 };
    },
  };
  const options = {
    store,
    telegram,
    identifyPlayer: async () => ({ playerId: 42, nickname: "Player" }),
    getBoss: () => ({ numericId: 7, name: "Boss" }),
    fetcher: async () => Response.json({}),
  };
  let service = createAutomationService(options);
  try {
    await service.boot();
    const entry = await service.identify("Bearer synthetic");
    entry.controller.restoreState({
      ...entry.controller.getSnapshot(),
      boss: base.boss,
      battle: active,
    });
    await assert.rejects(
      service.enableTelegramReport("42", "456"),
      /telegram_owner_mismatch/,
    );
    await service.enableTelegramReport("42", "123");
    const deadline = Date.now() + 4000;
    while (!calls.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(calls, ["sendMessage"]);
    const saved = store.read("42").telegramReport;
    assert.equal(saved.owner, "123");
    assert.equal(saved.messageId, 77);
    assert.ok(saved.run.startedAt);
    await service.enableTelegramReport("42", "123", "disable");
    assert.equal(entry.telegramReport.enabled, false);
    assert.equal(
      await service.enableTelegramReport("42", "123", "auto"),
      false,
    );
    assert.equal(entry.telegramReport.enabled, false);
    await service.enableTelegramReport("42", "123", "enable");
    service.close();
    service = createAutomationService(options);
    const restored = await service.identify("Bearer synthetic");
    assert.equal(restored.telegramReport.messageId, 77);
    assert.equal(restored.telegramReport.run.startedAt, saved.run.startedAt);
    boundOwner = "456";
    await service.enableTelegramReport("42", "456");
    assert.equal(restored.telegramReport.owner, "456");
    assert.equal(restored.telegramReport.messageId, null);
    boundOwner = "123";
    const getState = restored.controller.getSnapshot;
    restored.controller.getSnapshot = () => ({
      ...getState(),
      battle: { ...active, status: "won" },
      needsRefresh: false,
    });
    restored.telegramReport = {
      enabled: true,
      owner: "123",
      run: { startedAt: 1, endedAt: null, battles: null },
    };
    await service.enableTelegramReport("42", "123");
    assert.equal(restored.storageFailed, false);
    assert.equal(store.read("42").telegramReport.enabled, false);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
