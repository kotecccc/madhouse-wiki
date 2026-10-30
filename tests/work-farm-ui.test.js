import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("farm progress controls expose real tasks and accessible progress without technical refresh controls", async () => {
  const server = await createServer({
    configFile: false,
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [
      react(),
      {
        name: "fake-catalogue",
        resolveId(id) {
          if (id === "virtual:madhouse-catalogue") return "\0fake-catalogue";
        },
        load(id) {
          if (id === "\0fake-catalogue")
            return "export const knowledgeBase = {floors:[], departments:[], bosses:[], businesses:[], works:[], businessUpgrades:[]};";
        },
      },
    ],
    server: { middlewareMode: true, hmr: false },
    appType: "custom",
  });
  try {
    const { ProgressButton } = await server.ssrLoadModule(
      "/src/components/ui/ProgressButton/ProgressButton.jsx",
    );
    const known = renderToStaticMarkup(
      createElement(ProgressButton, {
        icon: "energy",
        value: 16,
        max: 27,
        label: "Открыть фарм",
      }),
    );
    assert.match(known, /59%/);
    assert.match(known, /role="progressbar"/);
    assert.match(known, /aria-valuemax="27" aria-valuenow="16"/);
    assert.match(known, /aria-haspopup="dialog"/);
    assert.doesNotMatch(known, /Стоп/);
    const health = renderToStaticMarkup(
      createElement(ProgressButton, {
        value: 50,
        max: 100,
        icon: "combat",
        animateLoss: true,
        animationKey: "battle-1",
        label: "HP босса",
        valueText: "50 из 100",
      }),
    );
    assert.match(health, /ui-progress-button-fill--animated/);
    assert.match(health, /base-card--glass-nav-circle/);
    assert.match(health, /stroke-dasharray="50 100"/);
    assert.match(health, /aria-valuetext="50 из 100"/);
    const bossHealth = renderToStaticMarkup(
      createElement(ProgressButton, {
        value: 91,
        max: 100,
        icon: "boss",
        imageSrc: "/boss.png",
        label: "Бой с боссом",
      }),
    );
    assert.match(bossHealth, /src="\/boss\.png"/);
    assert.match(bossHealth, /91%/);
    assert.match(bossHealth, /aria-valuenow="91"/);
    const unknown = renderToStaticMarkup(
      createElement(ProgressButton, {
        icon: "energy",
        value: 0,
        max: null,
        label: "Открыть фарм",
      }),
    );
    assert.match(unknown, /Получаем прогресс/);
    assert.doesNotMatch(unknown, /aria-valuenow|0%/);
    const { WorkFarmDialog } = await server.ssrLoadModule(
      "/src/features/works/WorkCard/WorkFarmDialog.jsx",
    );
    const state = {
      loaded: true,
      pending: false,
      error:
        "Состояние изменилось. Проверьте данные и повторите действие вручную.",
      view: {
        workId: 7,
        completedCycles: 25,
        updatedAt: Date.now(),
        energy: { current: 27, max: 360 },
        tasks: [
          {
            id: 1,
            title: "Укрепить стену",
            required: 5,
            progress: 1,
            energyCost: 8,
            canPerform: true,
          },
        ],
        boosters: [],
      },
      run: {
        workId: 7,
        status: "running",
        phase: "retrying",
        targetCycles: 26,
        energySpent: 16,
        energyBudget: 27,
        reason:
          "Проверяем результат последнего действия без повторного расхода.",
        actionsDone: 2,
        config: { mode: "energy", maxActions: 30000 },
      },
    };
    const html = renderToStaticMarkup(
      createElement(WorkFarmDialog, {
        work: { workId: 7, title: "Блиндаж" },
        onClose() {},
        farmStore: { getSnapshot: () => state, subscribe: () => () => {} },
      }),
    );
    assert.match(html, /Будут выполнены/);
    assert.match(html, /Укрепить стену/);
    assert.match(
      html,
      /Проверяем результат последнего действия без повторного расхода/,
    );
    assert.match(html, /tabler-icon-player-stop/);
    assert.doesNotMatch(
      html,
      /Обновить данные|Не удалось обновить работу|Состояние изменилось|Необходимо энергии|Итого|Потратить доступную энергию/,
    );
    const countState = { ...state, run: null, error: null };
    const countHtml = renderToStaticMarkup(
      createElement(WorkFarmDialog, {
        work: { workId: 7, title: "Блиндаж" },
        onClose() {},
        goalTargets: [
          { required: 27, destination: "этажа", label: "Выполнить работу" },
        ],
        farmStore: { getSnapshot: () => countState, subscribe: () => () => {} },
      }),
    );
    assert.match(countHtml, /Необходимо энергии/);
    assert.match(countHtml, /Вариант 1: ждать энергию/);
    assert.match(countHtml, /Вариант 2: купить дефибрилляторы/);
    assert.match(countHtml, /shared-modal-footer--spread/);
    assert.doesNotMatch(countHtml, /План заданий|Обновить данные/);
    const queuedHtml = renderToStaticMarkup(
      createElement(WorkFarmDialog, {
        work: { workId: 7, title: "Блиндаж" },
        onClose() {},
        farmStore: { getSnapshot: () => countState, subscribe: () => () => {} },
        queueStore: {
          subscribe: () => () => {},
          getSnapshot: () => ({
            presence: "present",
            data: {
              queuedActions: [
                {
                  type: "work.start",
                  args: { workId: 7 },
                  status: "waiting",
                  blockedBy: "rate",
                },
              ],
            },
          }),
        },
      }),
    );
    assert.match(queuedHtml, /Ожидает выполнения в очереди действий/);
    assert.match(queuedHtml, /Ожидает следующего разрешённого действия/);
    assert.match(queuedHtml, /Прогресс появится здесь после начала фарма/);
    assert.doesNotMatch(queuedHtml, /Фарм добавлен в очередь/);
    const workQueueStore = (queuedActions) => {
      const snapshot = { presence: "present", data: { queuedActions } };
      return {
        subscribe: () => () => {},
        getSnapshot: () => snapshot,
      };
    };
    const renderWorkQueue = (queuedActions) =>
      renderToStaticMarkup(
        createElement(WorkFarmDialog, {
          work: { workId: 7, title: "Блиндаж" },
          onClose() {},
          farmStore: {
            getSnapshot: () => countState,
            subscribe: () => () => {},
          },
          queueStore: workQueueStore(queuedActions),
        }),
      );
    const oldWorkFailure = {
      type: "work.start",
      args: { workId: 7 },
      status: "failed",
      createdAt: 1,
      finishedAt: 2,
      reason: "Старая ошибка фарма.",
    };
    const completedWork = {
      type: "work.start",
      args: { workId: 7 },
      status: "completed",
      createdAt: 3,
      finishedAt: 4,
    };
    const afterSuccessHtml = renderWorkQueue([oldWorkFailure, completedWork]);
    assert.doesNotMatch(afterSuccessHtml, /Старая ошибка фарма/);
    const dismissedFailureHtml = renderWorkQueue([
      { ...oldWorkFailure, dismissed: true },
    ]);
    assert.doesNotMatch(dismissedFailureHtml, /Старая ошибка фарма/);
    const latestFailureHtml = renderWorkQueue([
      oldWorkFailure,
      { ...completedWork, status: "failed", reason: "Новая ошибка фарма." },
    ]);
    assert.match(latestFailureHtml, /Новая ошибка фарма/);
    assert.match(html, /Применить дефибриллятор/);
    assert.match(known, /ui-icon--inherit/);
    const { RequirementCalculatorDialog } = await server.ssrLoadModule(
      "/src/features/calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx",
    );
    const calculator = renderToStaticMarkup(
      createElement(RequirementCalculatorDialog, {
        conditionDialog: { energy: 20, requirement: { label: "Работа" } },
        accountState: {
          status: "ready",
          energy: { currentEnergy: 10, maxEnergy: 100 },
        },
        onClose() {},
      }),
    );
    assert.match(calculator, /Необходимо энергии/);
    assert.match(calculator, /Вариант 1: ждать энергию/);
  } finally {
    await server.close();
  }
});
