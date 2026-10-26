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
  bossExecutionStatus,
  goalProgressPresentation,
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

test("battle header contains countdown, hides automation manual controls and keeps journal damage", async () => {
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
              type: "room",
              entityId: 8,
              name: "Комната",
            },
            { type: "weapon", entityId: 9, name: "Оружие" },
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
    assert.ok(!goalMarkup.includes("Бои: 2 · Победы: 1"));
    const progressMarkup = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: { boss: { id: 7, name: "Босс", reference: {} } },
        goal,
        now: 1000,
      }),
    );
    assert.ok(!progressMarkup.includes("Бои: 2 · Победы: 1"));
    const invitationState = {
      boss: { id: 7, name: "Босс", reference: {} },
      healing: { invitation: { attempted: false, nextAt: null } },
    };
    const waitingInvitations = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: invitationState,
        auto: { enabled: true },
        now: 1000,
      }),
    );
    assert.ok(!waitingInvitations.includes("Приглашаем друзей"));
    const activeInvitations = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: { ...invitationState, battle: { status: "active" } },
        auto: { enabled: true },
        now: 1000,
      }),
    );
    assert.ok(activeInvitations.includes("Приглашаем друзей"));
    const stoppedProgress = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: { boss: { id: 7, name: "Босс", reference: {} } },
        goal: { ...goal, status: "stopped", remainingSeconds: 2880 },
        now: 1000,
      }),
    );
    assert.ok(!stoppedProgress.includes('aria-label="Прогресс цели"'));
    assert.ok(!stoppedProgress.includes("Осталось:"));
    assert.ok(!stoppedProgress.includes("Бои:"));
    const timedProgress = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: { boss: { id: 7, name: "Босс", reference: {} } },
        goal: { ...goal, remainingSeconds: 3599 },
        now: 1000,
      }),
    );
    assert.ok(!timedProgress.includes("Осталось:"));
    assert.ok(goalMarkup.includes("Начать автобой"));
    assert.ok(goalMarkup.includes("Цель и условия боя"));
    assert.ok(goalMarkup.includes("ui-pill--active"));
    assert.ok(!goalMarkup.includes("Способ участия в боях"));
    assert.ok(!goalMarkup.includes("Ждёт приглашения друзей"));
    assert.ok(goalMarkup.includes("tabler-icon-player-play"));
    assert.ok(goalMarkup.includes("Запустить рейд"));
    const otherBossMarkup = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: {
          ...settingsState,
          raid: {
            enabled: false,
            status: "paused",
            bossId: 99,
            notice: "Other boss",
          },
        },
        goal: { ...goal, boss: { id: 99 }, status: "stopped" },
        auto: { enabled: true, pause: true },
      }),
    );
    assert.ok(otherBossMarkup.includes("Не установлена"));
    assert.ok(!otherBossMarkup.includes("На паузе"));
    assert.ok(!otherBossMarkup.includes("Бои: 2"));
    assert.ok(otherBossMarkup.includes("Начать автобой"));
    for (const pending of [null, "refresh"]) {
      const staleRaidState = {
        ...settingsState,
        pending,
        needsRefresh: true,
        raid: { enabled: false, status: "stopped", bossId: 99 },
      };
      const auto = { enabled: true };
      assert.equal(bossExecutionStatus(staleRaidState, auto).label, "Ждём боя");
      const waitingSeries = renderToStaticMarkup(
        createElement(BossBattleGoalPanel, {
          state: staleRaidState,
          goal,
          auto,
        }),
      );
      assert.match(
        waitingSeries,
        /aria-label="Остановить автобой"(?![^>]*disabled)/,
      );
      assert.ok(!waitingSeries.includes("Начать автобой"));
      assert.ok(!waitingSeries.includes("Остановить рейд"));
      assert.match(waitingSeries, /aria-label="Запустить рейд"[^>]*disabled/);
    }
    const raidMarkup = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: {
          ...settingsState,
          raid: {
            enabled: true,
            status: "waiting",
            notice: "Ждём приглашений",
          },
        },
        goal,
      }),
    );
    assert.ok(raidMarkup.includes("Остановить рейд"));
    assert.ok(!raidMarkup.includes("number-stepper"));
    assert.ok(raidMarkup.includes("tabler-icon-player-pause"));
    assert.ok(raidMarkup.includes("2 из 3"));
    assert.ok(raidMarkup.includes("ui-pill--active"));
    assert.ok(!raidMarkup.includes("Ждём приглашений"));
    assert.match(raidMarkup, /aria-label="Начать автобой"[^>]*disabled/);

    assert.ok(goalMarkup.includes('aria-label="Без ограничений"'));
    assert.ok(goalMarkup.includes("tabler-icon-infinity-2"));
    assert.ok(
      goalMarkup.indexOf("tabler-icon-infinity-2") <
        goalMarkup.indexOf(">1 ч</button>"),
    );
    assert.ok(!goalMarkup.includes("Остановить цель"));
    assert.ok(!progressMarkup.includes('aria-label="Прогресс цели"'));
    const seriesGoal = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: settingsState,
        goal,
        auto: { enabled: true },
      }),
    );
    assert.ok(seriesGoal.includes("Остановить автобой"));
    assert.ok(!seriesGoal.includes("Остановить цель"));
    assert.ok(seriesGoal.includes("2 из 3"));
    assert.ok(seriesGoal.includes("ui-pill--active"));
    const paused = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: settingsState,
        goal,
        auto: { enabled: true, pause: true },
      }),
    );
    assert.ok(paused.includes("2 из 3"));
    assert.ok(paused.includes("ui-pill--active"));
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
    assert.ok(fightingRaid.includes("2 из 3"));
    assert.ok(fightingRaid.includes("Остановить рейд"));
    assert.ok(!fightingRaid.includes("Остановить автобой"));

    const completedGoal = renderToStaticMarkup(
      createElement(BossBattleGoalPanel, {
        state: settingsState,
        goal: { ...goal, status: "completed", wins: 3 },
      }),
    );
    assert.ok(completedGoal.includes("Не установлена"));
    assert.ok(completedGoal.includes("Начать автобой"));
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
              key: "room:8",
              name: "Комната",
              amount: 0,
              received: false,
            },
          ],
        },
        "Комната",
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
        "Сколько ходить",
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
    const runningSummary = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: {
          boss: {
            id: 7,
            name: "Босс",
            reference: {
              maxHp: 11000,
              damageMin: 40,
              damageMax: 60,
              possibleDrops: [
                {
                  type: "activity_item",
                  entityId: 55,
                  name: "Трофей",
                  image: "/item.webp",
                },
              ],
            },
          },
          raid: { enabled: true, bossId: 7, status: "waiting" },
          businessInventory: { stock: { 55: 174 }, complete: true },
        },
        now: 1000,
      }),
    );
    assert.ok(runningSummary.includes("Ждём приглашений"));
    assert.ok(runningSummary.includes("Трофей"));
    assert.ok(!runningSummary.includes("Здоровье 11"));
    assert.ok(!runningSummary.includes("Урон 40"));
    assert.ok(!runningSummary.includes("В инвентаре: 174"));
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
    assert.ok(quotaPanel.includes("ui-progress-bar-highlight"));
    assert.ok(quotaPanel.includes("До нормы урона: 25"));
    assert.ok(!quotaPanel.includes("Осталось нанести:"));
    for (const [bossHealth, left, width] of [
      [50, 25, 25],
      [40, 15, 25],
      [10, 0, 10],
    ]) {
      const personalQuota = renderToStaticMarkup(
        createElement(BossBattlePanel, {
          state: {
            boss,
            battle: {
              ...battle,
              bossHealth,
              totalDamage: 75,
              dropDamageRequired: 100,
            },
          },
          now: 1000,
        }),
      );
      assert.ok(
        personalQuota.includes(
          `class="ui-progress-bar-highlight" aria-hidden="true" style="left:${left}%;width:${width}%"`,
        ),
      );
    }
    const completedQuotaPanel = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: {
          boss,
          battle: { ...battle, totalDamage: 100, dropDamageRequired: 100 },
        },
        now: 1000,
      }),
    );
    assert.ok(!completedQuotaPanel.includes("ui-progress-bar-highlight"));
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
      !staleQuotaPanel.includes("Последнее подтверждённое значение нормы"),
    );
    const healingState = {
      boss: { id: 7 },
      pending: null,
      medicines: [
        { type: "heal_10", quantity: 7 },
        { type: "heal_full", quantity: 0 },
      ],
      healing: {
        settings: {
          enabled: true,
          autoBuy: true,
          items: { heal_10: { enabled: true, limit: 2, currency: "gold" } },
          budgets: { gold: 500 },
        },
        used: { heal_10: 1 },
      },
    };
    const healingMarkup = renderToStaticMarkup(
      createElement(BossHealingSettings, { state: healingState, onSave() {} }),
    );
    assert.ok(healingMarkup.includes("Использовать аптечки?"));
    assert.ok(healingMarkup.includes("ui-disclosure ui-disclosure--sm"));
    assert.ok(healingMarkup.includes("ui-pill--completed"));
    assert.ok(!healingMarkup.includes("<input"));
    assert.ok(!healingMarkup.includes('role="radiogroup"'));
    assert.ok(!healingMarkup.includes("Применить"));
    const expandedHealing = renderToStaticMarkup(
      createElement(BossHealingSettings, {
        state: {
          ...healingState,
          healing: { ...healingState.healing, uncertain: true },
        },
        onSave() {},
      }),
    );
    assert.ok(!expandedHealing.includes("Лимит на бой · 0 — не использовать"));
    assert.ok(!expandedHealing.includes('aria-label="Автолечение"'));
    assert.ok(expandedHealing.includes("ui-icon--medicine-small"));
    assert.ok(expandedHealing.includes("ui-icon--medicine-full"));
    assert.ok(expandedHealing.includes("В наличии: 7"));
    assert.ok(expandedHealing.includes("В наличии: 0"));
    assert.ok(!expandedHealing.includes("Использовано:"));
    assert.ok(
      expandedHealing.includes('aria-label="Малая аптечка: лимит на бой"'),
    );
    assert.ok(
      expandedHealing.includes('aria-label="Большая аптечка: лимит на бой"'),
    );
    assert.equal((expandedHealing.match(/<input/g) || []).length, 2);
    assert.ok(!expandedHealing.includes("<select"));
    assert.ok(!expandedHealing.includes("Бюджет на весь запуск"));
    assert.ok(expandedHealing.includes("Автопокупка"));
    assert.ok(expandedHealing.includes("Состояние проверено"));
    const referenceHealthPanel = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: { boss, battle: null },
        now: 1000,
      }),
    );
    assert.ok(referenceHealthPanel.includes("Здоровье 13,6 млн"));
    assert.ok(!panel.includes("До окончания боя:"));
    assert.ok(panel.includes("Идёт · 00:30"));
    assert.ok(!panel.includes("Норма урона пока неизвестна"));
    assert.ok(!panel.includes("Аптечки"));
    const automatedPanel = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: { boss, battle },
        now: 1000,
        auto: { enabled: true },
      }),
    );
    assert.ok(!automatedPanel.includes(">Ударить<"));
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
    const richJournal = renderToStaticMarkup(
      createElement(BossBattleDetails, {
        boss,
        battle: {
          ...battle,
          localEvents: [
            {
              kind: "invite",
              localKey: "invite:one",
              at: 5000,
              actor: "Игрок",
              invitedCount: 3,
            },
            {
              kind: "heal",
              localKey: "medicine:one",
              at: 6000,
              actor: "Игрок",
              itemType: "heal_full",
              healthRestored: 80,
            },
          ],
          joinEvents: [
            {
              kind: "join",
              localKey: "join:one",
              at: 7000,
              actor: "Друг",
              invitedBySelf: true,
            },
          ],
        },
      }),
    );
    assert.ok(richJournal.includes("Пригласил друзей"));
    assert.ok(richJournal.includes("Вступил по вашему приглашению"));
    assert.ok(richJournal.includes("+80 HP"));
    assert.ok(richJournal.includes("tabler-icon-users-group"));
    assert.ok(richJournal.includes("tabler-icon-book"));
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

test("execution status distinguishes raid waiting, joining, fighting and result", () => {
  const state = {
    boss: { id: 7 },
    raid: { enabled: true, bossId: 7, status: "waiting" },
  };
  assert.equal(bossExecutionStatus(state).label, "Ждём приглашений");
  assert.equal(
    bossExecutionStatus({
      ...state,
      raid: { ...state.raid, status: "joining" },
    }).label,
    "Ждём приглашений",
  );
  assert.equal(
    bossExecutionStatus({ ...state, battle: { status: "active" } }).label,
    "Идёт бой",
  );
  assert.equal(
    bossExecutionStatus({
      boss: { id: 7 },
      battle: { status: "won", rewardKnown: true },
    }).label,
    "Победа",
  );
  assert.equal(bossExecutionStatus({ ...state, boss: { id: 8 } }), null);
  for (const status of ["won", "lost"]) {
    const battle = { status, rewardKnown: true };
    assert.equal(
      bossExecutionStatus({ ...state, battle }).label,
      "Ждём приглашений",
    );
    assert.equal(
      bossExecutionStatus(
        { boss: state.boss, battle },
        { enabled: true, phase: "between_battles" },
      ).label,
      "Ждём боя",
    );
    assert.equal(
      bossExecutionStatus({
        ...state,
        battle,
        raid: { ...state.raid, status: "fighting" },
      }).label,
      status === "won" ? "Победа" : "Поражение",
    );
  }
});

test("goal summary has kind icon, progress and deadline clock without a fake infinite timer", () => {
  const goal = {
    status: "active",
    kind: "battles",
    progress: 4,
    target: 16,
    deadlineAt: 3273000,
  };
  assert.deepEqual(goalProgressPresentation(goal, 1000), {
    icon: "combat",
    progress: "4 из 16",
    timer: "54:32",
  });
  assert.equal(
    goalProgressPresentation({ ...goal, kind: "business_items" }, 1000).icon,
    "business",
  );
  assert.equal(
    goalProgressPresentation({ ...goal, kind: "drops" }, 1000).icon,
    "loot",
  );
  assert.equal(
    goalProgressPresentation({ ...goal, deadlineAt: null }, 1000).timer,
    null,
  );
  assert.equal(
    goalProgressPresentation(
      { ...goal, kind: "time", deadlineAt: 3662000 },
      1000,
    ).timer,
    "1:01:01",
  );
  assert.equal(
    goalProgressPresentation({ ...goal, status: "stopped" }, 1000),
    null,
  );
});

test("reward confirmation after victory is never labelled invitation confirmation", () => {
  const state = {
    boss: { id: 7 },
    battle: { status: "won", rewardKnown: false },
    raid: { enabled: true, bossId: 7, status: "waiting_confirmation" },
  };
  assert.equal(bossExecutionStatus(state).label, "Победа");
  assert.equal(
    bossExecutionStatus({
      ...state,
      battle: { ...state.battle, rewardKnown: true },
    }).label,
    "Победа",
  );
});
