import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatBattleCountdown,
  sameBattleEvent,
  sameBattleEvents,
} from "../src/features/bosses/BossBattle/boss-battle-presentation.js";

const event = {
  turn: 1,
  at: null,
  actor: "Игрок",
  damage: 42,
  critical: false,
  itemType: null,
  healthRestored: null,
};

test("battle countdown uses the remaining server-anchored lifetime and stops at zero", () => {
  assert.equal(formatBattleCountdown(31000, 1000), "00:30");
  assert.equal(formatBattleCountdown(2001, 1000), "00:02");
  assert.equal(formatBattleCountdown(3661000, 1000), "1:01:00");
  assert.equal(formatBattleCountdown(1000, 2000), "00:00");
  assert.equal(formatBattleCountdown(null, 1000), null);
});

test("equal event copies skip rendering while changed and new events stay observable", () => {
  assert.equal(sameBattleEvent(event, { ...event }), true);
  assert.equal(sameBattleEvents([event], [{ ...event }]), true);
  for (const patch of [
    { damage: 43 },
    { critical: true },
    { actor: "Другой" },
    { at: 1000 },
    { itemType: "heal_10" },
    { healthRestored: 20 },
  ])
    assert.equal(sameBattleEvent(event, { ...event, ...patch }), false);
  assert.equal(
    sameBattleEvents([event], [{ ...event, turn: 2 }, event]),
    false,
  );
});

test("static battle markup separates countdown from the header and journal damage", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "madhouse-battle-presentation-"));
  const server = await createServer({
    configFile: false,
    cacheDir,
    plugins: [react()],
    appType: "custom",
    server: { middlewareMode: true, hmr: false },
  });
  try {
    const { BossBattlePanel, BossBattleDetails } = await server.ssrLoadModule(
      "/src/features/bosses/BossBattle/BossBattlePanel.jsx",
    );
    const { BossHealingSettings } = await server.ssrLoadModule(
      "/src/features/bosses/BossBattle/BossHealingSettings.jsx",
    );
    const { BossBattleGoalPanel } = await server.ssrLoadModule(
      "/src/features/bosses/BossBattle/BossBattleGoalPanel.jsx",
    );
    const { BossBattleErrorBanner } = await server.ssrLoadModule(
      "/src/features/bosses/BossBattle/BossBattleErrorBanner.jsx",
    );
    const errorMarkup = renderToStaticMarkup(
      createElement(BossBattleErrorBanner, {
        state: {
          error: "Не удалось обновить состояние.",
          errorStatus: 503,
          needsRefresh: true,
        },
      }),
    );
    assert.ok(errorMarkup.includes('role="alert"'));
    assert.ok(errorMarkup.includes("HTTP 503"));
    assert.ok(errorMarkup.includes("временно недоступен"));
    assert.equal(
      renderToStaticMarkup(createElement(BossBattleErrorBanner, { state: {} })),
      "",
    );
    assert.equal(
      renderToStaticMarkup(
        createElement(BossBattleErrorBanner, {
          state: { pending: "attack", needsRefresh: true },
        }),
      ),
      "",
    );
    const goal = {
      boss: { id: 7, name: "Босс" },
      kind: "battles",
      targetCount: 3,
      completedBattles: 2,
      progress: 2,
      target: 3,
      items: [],
      maxAttempts: 5,
      wins: 1,
      attempts: 2,
      losses: 1,
      status: "active",
    };
    const settingsState = {
      boss: {
        ...goal.boss,
        reference: {
          possibleDrops: [
            { type: "activity_item", entityId: 1, name: "Материал" },
            {
              type: "mutagen",
              mutagenType: "I",
              mutagenLevel: 1,
              name: "Мутаген I-1",
            },
          ],
        },
      },
    };
    const goalMarkup = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: settingsState,
        goal,
      }),
    );
    assert.ok(goalMarkup.includes("Бои: 2 · Победы: 1"));
    assert.ok(goalMarkup.includes("Запустить автобой"));
    assert.ok(goalMarkup.includes("Цель и условия боя"));
    assert.ok(goalMarkup.includes("ui-pill--unknown"));
    assert.ok(!goalMarkup.includes("Способ участия в боях"));
    assert.ok(!goalMarkup.includes("Ждёт приглашения друзей"));
    assert.ok(goalMarkup.includes("tabler-icon-sword"));
    assert.ok(goalMarkup.includes("tabler-icon-swords"));
    assert.ok(goalMarkup.includes("Запустить рейд"));
    const raidMarkup = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: {
          ...settingsState,
          raid: {
            enabled: true,
            status: "waiting",
            notice: "Ждём приглашения",
          },
        },
        goal,
      }),
    );
    assert.ok(raidMarkup.includes("Остановить рейд"));
    assert.ok(raidMarkup.includes("Ожидание боя"));
    assert.ok(raidMarkup.includes("ui-pill--scheduled"));
    assert.ok(!raidMarkup.includes("Ждём приглашения"));
    assert.match(raidMarkup, /aria-label="Запустить автобой"[^>]*disabled/);

    assert.ok(goalMarkup.includes('aria-label="Без ограничений"'));
    assert.ok(goalMarkup.includes("tabler-icon-infinity-2"));
    assert.ok(
      goalMarkup.indexOf("tabler-icon-infinity-2") <
        goalMarkup.indexOf(">1 ч</button>"),
    );
    assert.ok(!goalMarkup.includes("Остановить цель"));
    assert.ok(goalMarkup.includes('aria-label="Прогресс цели"'));
    const seriesGoal = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: settingsState,
        goal,
        auto: { enabled: true },
      }),
    );
    assert.ok(seriesGoal.includes("Остановить автобой"));
    assert.ok(!seriesGoal.includes("Остановить цель"));
    assert.ok(seriesGoal.includes("Автобой идёт"));
    assert.ok(seriesGoal.includes("ui-pill--active"));
    const paused = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: settingsState,
        goal,
        auto: { enabled: true, pause: true },
      }),
    );
    assert.ok(paused.includes("На паузе"));
    assert.ok(paused.includes("ui-pill--warning"));
    const fightingRaid = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: {
          ...settingsState,
          raid: { enabled: true, status: "fighting" },
        },
        goal,
        auto: { enabled: true },
      }),
    );
    assert.ok(fightingRaid.includes("Рейд идёт"));
    assert.ok(fightingRaid.includes("Остановить рейд"));
    assert.ok(!fightingRaid.includes("Остановить автобой"));

    const completedGoal = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: settingsState,
        goal: { ...goal, status: "completed", wins: 3 },
      }),
    );
    assert.ok(completedGoal.includes("Выполнено"));
    assert.ok(completedGoal.includes("Запустить автобой"));
    assert.ok(!completedGoal.includes("Новая цель"));
    assert.ok(!completedGoal.includes("Остановить цель"));
    for (const [kind, extra, text] of [
      [
        "business_items",
        {
          items: [
            {
              key: "activity_item:1",
              name: "Материал",
              amount: 2,
              received: true,
            },
          ],
        },
        "Количество предметов",
      ],
      [
        "drops",
        {
          items: [
            {
              key: "mutagen:I:1",
              name: "Мутаген I-1",
              amount: 0,
              received: false,
            },
          ],
        },
        "Мутаген I-1",
      ],
      [
        "time",
        {
          target: null,
          startedAt: 1000,
          deadlineAt: null,
          remainingSeconds: null,
        },
        'aria-label="Без ограничений"',
      ],
      [
        "time",
        {
          target: 3600,
          startedAt: 1000,
          deadlineAt: 3601000,
          remainingSeconds: 3599,
        },
        "Осталось:",
      ],
    ]) {
      const variant = renderToStaticMarkup(
        createElement(BossBattleGoalPanel, {
          state: settingsState,
          goal: { ...goal, kind, ...extra },
        }),
      );
      assert.ok(variant.includes(text));
      assert.ok(!variant.includes("Цель на победы"));
    }
    const battle = {
      status: "active",
      expiresAt: 31000,
      readyAt: 1000,
      playerHealth: 100,
      playerMaxHealth: 100,
      bossHealth: 50,
      bossMaxHealth: 100,
      participantCount: 1,
      participants: [],
      events: [event],
    };
    const boss = { name: "Босс", reference: { maxHp: 13_600_000 } };
    const panel = renderToStaticMarkup(
      createElement(BossBattlePanel, { state: { boss, battle }, now: 1000 }),
    );
    const largeHealthPanel = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: {
          boss,
          battle: {
            ...battle,
            bossHealth: 12_000_000,
            bossMaxHealth: 13_600_000,
          },
        },
        now: 1000,
      }),
    );
    assert.ok(largeHealthPanel.includes("12 млн / 13,6 млн"));
    const quotaPanel = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: {
          boss,
          battle: {
            ...battle,
            quotaFresh: true,
            totalDamage: 75,
            dropDamageRequired: 100,
          },
        },
        now: 1000,
      }),
    );
    assert.ok(quotaPanel.includes("Норма урона"));
    assert.ok(quotaPanel.includes("Осталось нанести: 25"));
    const staleQuotaPanel = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: {
          boss,
          battle: {
            ...battle,
            quotaFresh: false,
            totalDamage: 75,
            dropDamageRequired: 100,
          },
        },
        now: 1000,
      }),
    );
    assert.ok(
      staleQuotaPanel.includes("Последнее подтверждённое значение нормы"),
    );
    const healingMarkup = renderToStaticMarkup(
      createElement(BossHealingSettings, {
        state: {
          boss: { id: 7 },
          pending: null,
          healing: {
            settings: {
              enabled: true,
              autoBuy: true,
              items: {
                heal_10: { enabled: true, limit: 2, currency: "gold" },
              },
              budgets: { gold: 500 },
            },
            used: { heal_10: 1 },
          },
        },
        onSave() {},
      }),
    );
    assert.ok(healingMarkup.includes("Лимит на бой"));
    assert.ok(healingMarkup.includes("0 — не использовать"));
    assert.ok(healingMarkup.includes("Использовано в этом бою: 1 / 2"));
    assert.ok(healingMarkup.includes("0 — покупки запрещены"));
    const referenceHealthPanel = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: { boss, battle: null },
        now: 1000,
      }),
    );
    assert.ok(referenceHealthPanel.includes("Здоровье 13,6 млн"));
    assert.match(
      panel,
      /card-description--xs[^>]*>До окончания боя: 00:30<\/span>/,
    );
    const finished = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: {
          boss,
          battle: { ...battle, status: "won", outcome: "Победа", rewards: [] },
        },
        now: 1000,
      }),
    );
    assert.ok(!finished.includes("До окончания боя:"));
    const transitioning = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: {
          boss,
          battle: { ...battle, status: "won", outcome: "Победа" },
        },
        auto: { enabled: true },
        goal: { ...goal, canContinue: true },
        now: 1000,
      }),
    );
    assert.ok(!transitioning.includes('aria-label="Остановить автоудары"'));
    assert.ok(!transitioning.includes('aria-pressed="true"'));

    const details = renderToStaticMarkup(
      createElement(BossBattleDetails, { boss, battle }),
    );
    assert.ok(details.includes('role="log"'));
    assert.ok(details.includes("boss-battle-journal-viewport"));
    assert.match(
      details,
      /boss-battle-panel-event[\s\S]*Игрок.*?Удар<\/span><span class="card-title[^>]*>42<\/span>/,
    );
  } finally {
    await server.close();
    rmSync(cacheDir, { recursive: true, force: true });
  }
});
