import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { readKnowledgeBase } from "../scripts/catalogue/query.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { cataloguePlugin } from "../scripts/catalogue/vite-plugin.mjs";
import { CatalogueStore } from "../scripts/catalogue/store.mjs";

test("all sections, boss pages, requirements and upgrade dialogs render from canonical data", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "madhouse-render-"));
  const store = new CatalogueStore(fixtureRoot);
  store.capture("/api/floors", 200, [
    { code: "A", number: 1, unlockDescription: "Тестовое условие API" },
  ]);
  store.capture("/api/floors/A/info", 200, {
    departments: [
      {
        blockCode: "A1",
        name: "Тестовый отдел",
        requirements: [
          {
            type: "boss_kills",
            label: "Тестовое требование",
            required: 5,
            bossId: 41,
          },
        ],
      },
    ],
  });
  store.capture("/api/bosses/41", 200, {
    id: 41,
    nameRu: "Тестовый босс",
    requiredLevel: 1,
    damageMin: 10,
    damageMax: 20,
    maxHp: 100,
    possibleDrops: [
      { type: "activity_item", entityId: 1, name: "Трофей" },
      { type: "mutagen", entityId: 41, name: "Мутаген" },
    ],
  });
  store.capture("/api/businesses/21", 200, {
    id: 21,
    title: { ru: "Тестовый бизнес" },
    maxLevel: 6,
    currency: "gold",
  });
  store.capture(
    "/api/works/open",
    200,
    {
      workId: 31,
      title: "Тестовая работа",
      tasks: [{ id: 1, title: "Тестовая задача", required: 5, energyCost: 2 }],
    },
    "POST",
    31,
  );
  for (const [kind, id] of [
    ["boss", "boss-41"],
    ["business", "business:21"],
    ["work", "work:31"],
  ])
    store.link(
      kind,
      id,
      "in_department",
      "department",
      "dept-A1",
      "api:/api/floors/A/info",
    );
  store.close();
  const kb = readKnowledgeBase(fixtureRoot);
  const server = await createServer({
    configFile: false,
    plugins: [react(), cataloguePlugin(fixtureRoot)],
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const load = (path) => server.ssrLoadModule(`/src/${path}`);
    const { App } = await load("app/App/App.jsx");
    const html = renderToStaticMarkup(createElement(App));
    assert.ok(html.includes("floor-group"));
    const { FloorsSection } = await load(
      "features/floors/FloorsSection/FloorsSection.jsx",
    );
    const lockedFloorSelectorMarkup = renderToStaticMarkup(
      createElement(FloorsSection, {
        availability: { A: false },
        floorDetails: {},
        status: "idle",
      }),
    );
    assert.ok(lockedFloorSelectorMarkup.includes("floor-selector-lock"));
    const { FloorGroup } = await load(
      "features/floors/FloorGroup/FloorGroup.jsx",
    );
    for (const floor of kb.floors) {
      const floorHtml = renderToStaticMarkup(
        createElement(FloorGroup, { floor, viewMode: "list" }),
      );
      assert.equal(
        (floorHtml.match(/<details class="floor-work-disclosure"/g) || [])
          .length,
        floor.departmentIds.length,
      );
      if (floor.openingConditionText)
        assert.ok(
          !floorHtml.includes(
            floor.openingConditionText
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&#x27;"),
          ),
        );
    }
    const { OverviewSection } = await load(
      "features/overview/OverviewSection/OverviewSection.jsx",
    );
    const overviewMarkup = renderToStaticMarkup(
      createElement(OverviewSection, {
        profileState: {
          status: "ready",
          profile: {
            name: "Тестовый игрок",
            stats: [],
            wallet: [],
            playerLevel: null,
          },
        },
        floorAvailability: { availability: { A: true }, floorDetails: {} },
        departmentState: {
          code: "A",
          departments: [
            {
              blockCode: "A1",
              unlocked: false,
              requirements: [{ type: "boss_kills", bossId: 41, required: 5 }],
            },
          ],
        },
        schedule: { status: "ready", posts: [] },
      }),
    );
    assert.ok(overviewMarkup.includes("Тестовый игрок"));
    assert.ok(!overviewMarkup.includes("Следующий уровень"));
    assert.ok(!overviewMarkup.includes("Следующая цель"));
    const categoryFloor = kb.floors[0];
    const categoryMarkup = (category, targets = [], available = true) =>
      renderToStaticMarkup(
        createElement(FloorGroup, {
          floor: categoryFloor,
          category,
          targets,
          departmentAvailability: { A1: available },
        }),
      );
    const workMarkup = categoryMarkup("work", [
      {
        category: "work",
        departmentId: "dept-A1",
        entityId: "work:31",
        destination: "A2",
        label: "Выполнить тестовую работу 5 раз",
      },
    ]);
    assert.ok(workMarkup.includes("Тестовая работа"));
    assert.ok(workMarkup.includes("A1 • Тестовая работа"));
    assert.ok(!workMarkup.includes("ui-disclosure"));
    assert.ok(!workMarkup.includes("<details"));
    assert.ok(workMarkup.includes("base-card--target"));
    assert.match(workMarkup, /class="[^"]*button--accent-gold[^"]*"/);
    assert.ok(workMarkup.includes('<span class="button-label">Фарм</span>'));
    assert.ok(
      workMarkup.includes('aria-label="Настроить фарм: Тестовая работа"'),
    );
    assert.ok(workMarkup.includes("tabler-icon-brain"));
    assert.equal((workMarkup.match(/<button\b/g) || []).length, 1);
    assert.ok(!workMarkup.includes("Калькулятор"));
    assert.ok(!workMarkup.includes(">Цель</button>"));
    assert.ok(workMarkup.includes("work-card-energy"));
    assert.ok(workMarkup.includes(">10</span>"));
    assert.ok(!workMarkup.includes("floor-target-note"));
    assert.ok(!workMarkup.includes("Для открытия"));
    assert.ok(!workMarkup.includes('role="dialog"'));
    assert.ok(!workMarkup.includes("Условия открытия этажа"));
    assert.ok(!workMarkup.includes("Тестовый босс"));
    const workWithoutTargetMarkup = categoryMarkup("work");
    assert.ok(!workWithoutTargetMarkup.includes("base-card--target"));
    assert.ok(
      workWithoutTargetMarkup.includes(
        '<span class="button-label">Фарм</span>',
      ),
    );
    assert.ok(
      workWithoutTargetMarkup.includes(
        'aria-label="Настроить фарм: Тестовая работа"',
      ),
    );
    assert.ok(workWithoutTargetMarkup.includes("tabler-icon-brain"));
    assert.equal((workWithoutTargetMarkup.match(/<button\b/g) || []).length, 1);
    assert.ok(!workWithoutTargetMarkup.includes("Калькулятор"));
    assert.ok(!workWithoutTargetMarkup.includes(">Цель</button>"));
    const floorBossMarkup = categoryMarkup("bosses");
    assert.ok(floorBossMarkup.includes("Тестовый босс"));
    assert.ok(floorBossMarkup.includes("A1 • Тестовый босс"));
    assert.ok(!floorBossMarkup.includes("ui-disclosure"));
    assert.ok(!floorBossMarkup.includes("<details"));
    assert.ok(!categoryMarkup("bosses").includes("Тестовая работа"));
    const targetedBossMarkup = categoryMarkup("bosses", [
      {
        category: "bosses",
        entityId: kb.bosses[0].id,
        departmentId: kb.bosses[0].departmentId,
        destination: "A2",
        label: "Победить Тестовый босс 5 раз",
        required: 5,
      },
    ]);
    assert.ok(targetedBossMarkup.includes("base-card--target"));
    assert.ok(!targetedBossMarkup.includes('aria-label="Цель открытия"'));
    assert.ok(!targetedBossMarkup.includes(">Цель</button>"));
    const { BossBattleOpeningRequirements } = await load(
      "features/bosses/BossBattle/BossBattleOpeningRequirements.jsx",
    );
    const openingRequirementsMarkup = renderToStaticMarkup(
      createElement(BossBattleOpeningRequirements, {
        targets: [
          {
            destination: "A2",
            label: "Победить Тестовый босс 5 раз",
            note: "Условия неполные",
            verification: "Не проверено",
          },
          { destination: "B1", label: "Победить Тестовый босс 10 раз" },
        ],
      }),
    );
    assert.ok(openingRequirementsMarkup.includes("Для открытия A2"));
    assert.ok(
      openingRequirementsMarkup.includes("Победить Тестовый босс 5 раз"),
    );
    assert.ok(openingRequirementsMarkup.includes("Условия неполные"));
    assert.ok(openingRequirementsMarkup.includes("Не проверено"));
    assert.ok(openingRequirementsMarkup.includes("Для открытия B1"));
    assert.equal(
      renderToStaticMarkup(
        createElement(BossBattleOpeningRequirements, { targets: [] }),
      ),
      "",
    );
    const businessMarkup = categoryMarkup("businesses");
    assert.ok(businessMarkup.includes("Тестовый бизнес"));
    assert.ok(businessMarkup.includes("A1 • Тестовый бизнес"));
    assert.ok(!businessMarkup.includes("ui-disclosure"));
    assert.ok(!businessMarkup.includes("<details"));
    for (const [category, markup] of [
      ["work", categoryMarkup("work", [], false)],
      ["businesses", categoryMarkup("businesses", [], false)],
    ]) {
      assert.ok(
        markup.includes("base-card--locked"),
        `${category} cards render the shared locked state`,
      );
      assert.ok(
        category === "work"
          ? markup.includes('class="lock-indicator lock-indicator--locked')
          : !markup.includes('class="lock-indicator'),
        `${category} cards do not render a lock indicator`,
      );
      assert.ok(
        !markup.includes(">Заблокировано<"),
        `${category} cards do not render literal locked status text`,
      );
    }
    const lockedBossMarkup = categoryMarkup("bosses", [], false);
    assert.ok(lockedBossMarkup.includes("base-card--locked"));
    assert.ok(!lockedBossMarkup.includes('class="lock-indicator'));
    assert.ok(!lockedBossMarkup.includes('aria-label="Бой: Тестовый босс"'));
    // The battle button itself is client-authenticated; SSR verifies its action branch.
    assert.ok(!lockedBossMarkup.includes('class="boss-card-actions"'));
    assert.ok(floorBossMarkup.includes('class="boss-card-actions"'));

    const { departmentById } = await load("model/knowledge-base.js");
    const { FloorDepartmentContent } = await load(
      "features/floors/FloorDepartmentContent/FloorDepartmentContent.jsx",
    );
    const { WorkEnergyDialog } = await load(
      "features/works/WorkCard/WorkCalculatorDialog.jsx",
    );
    const workEnergyDialogMarkup = renderToStaticMarkup(
      createElement(WorkEnergyDialog, {
        work: departmentById["dept-A1"].work,
        energy: 10,
        goalTargets: [
          {
            destination: "A2",
            label: "Выполнить тестовую работу 5 раз",
            required: 5,
          },
        ],
        onClose() {},
      }),
    );
    assert.ok(workEnergyDialogMarkup.includes("A2"));
    assert.ok(
      workEnergyDialogMarkup.includes("Выполнить тестовую работу 5 раз"),
    );
    assert.match(workEnergyDialogMarkup, /<input[^>]*value="5"/);
    assert.match(
      workEnergyDialogMarkup,
      /class="requirement-calculator-energy-value">50\s/,
    );
    assert.ok(workEnergyDialogMarkup.includes("Фарм · Тестовая работа"));
    const { WorkFarmDialog } = await load(
      "features/works/WorkCard/WorkFarmDialog.jsx",
    );
    const farmSnapshot = {
      loaded: true,
      pending: true,
      notice: "Проверка состояния",
      view: {
        workId: 7,
        completedCycles: 20,
        tasks: [
          { id: 1, title: "Задание", required: 5, progress: 3, energyCost: 2 },
        ],
        energy: { current: 1, max: 10 },
        boosters: [],
        walletDollar: 50,
      },
      run: {
        status: "running",
        phase: "performing",
        workId: 7,
        title: "Блиндаж",
        targetCycles: 25,
        completedCycles: 20,
        actionsDone: 2,
        usedBoosters: 0,
        spentDollar: 0,
      },
    };
    const farmMarkup = renderToStaticMarkup(
      createElement(WorkFarmDialog, {
        work: { workId: 7, title: "Блиндаж" },
        onClose() {},
        goalTargets: [
          {
            required: 25,
            destination: "J2",
            label: "Выполнить Блиндаж 25 раз",
          },
        ],
        farmStore: {
          subscribe: () => () => {},
          getSnapshot: () => farmSnapshot,
        },
      }),
    );
    assert.ok(farmMarkup.includes('aria-label="20 из 25, осталось 5"'));
    assert.match(farmMarkup, /class="ui-pill[^"]*"[^>]*>20 из 25<\/span>/);
    assert.match(farmMarkup, /id="work-calculator-count"[^>]*value="5"/);
    assert.ok(farmMarkup.includes("Осталось выполнений работы"));
    assert.ok(!farmMarkup.includes("Итого (оценка)"));
    assert.ok(farmMarkup.includes('class="requirement-calculator-action"'));
    assert.match(
      farmMarkup,
      /class="requirement-calculator-energy-value">44\s/,
    );
    assert.ok(farmMarkup.includes("Вариант 1: ждать энергию"));
    assert.ok(farmMarkup.includes("Вариант 2: купить дефибрилляторы"));
    assert.ok(farmMarkup.includes("Начать фарм"));
    assert.ok(!farmMarkup.includes("Максимум действий"));
    assert.ok(!farmMarkup.includes("Ограничение времени"));
    assert.ok(!farmMarkup.includes("Настройки фарма"));
    assert.ok(farmMarkup.includes('class="requirement-calculator-card"'));
    assert.match(
      farmMarkup,
      /<button(?![^>]*disabled)[^>]*>Остановить<\/button>/,
    );
    assert.ok(farmMarkup.includes('aria-busy="true"'));
    assert.ok(farmMarkup.includes('class="shared-modal-heading-loader"'));
    assert.ok(farmMarkup.includes('class="ui-border-loader"'));
    assert.ok(farmMarkup.includes('aria-label="Прогресс фарма"'));
    const waitProgressIndex = farmMarkup.indexOf(
      'aria-label="Прогресс выбранного варианта"',
    );
    assert.ok(
      waitProgressIndex > farmMarkup.indexOf("Вариант 1: ждать энергию"),
    );
    assert.ok(
      waitProgressIndex <
        farmMarkup.indexOf("Вариант 2: купить дефибрилляторы"),
    );
    assert.ok(!farmMarkup.includes("Фарм идёт · 20 / 25"));
    const activePurchaseSnapshot = {
      ...farmSnapshot,
      run: { ...farmSnapshot.run, config: { mode: "boosters" } },
    };
    const activePurchaseMarkup = renderToStaticMarkup(
      createElement(WorkFarmDialog, {
        work: { workId: 7, title: "Блиндаж" },
        onClose() {},
        goalTargets: [
          {
            required: 25,
            destination: "J2",
            label: "Выполнить Блиндаж 25 раз",
          },
        ],
        farmStore: {
          subscribe: () => () => {},
          getSnapshot: () => activePurchaseSnapshot,
        },
      }),
    );
    assert.ok(
      activePurchaseMarkup.indexOf(
        'aria-label="Прогресс выбранного варианта"',
      ) > activePurchaseMarkup.indexOf("Вариант 2: купить дефибрилляторы"),
    );
    assert.equal(
      (activePurchaseMarkup.match(/>Остановить<\/button>/g) || []).length,
      1,
    );
    assert.match(
      activePurchaseMarkup,
      /<button(?![^>]*disabled)[^>]*>Остановить<\/button>/,
    );
    const farmPurchaseMarkup = (owned) => {
      const snapshot = {
        ...farmSnapshot,
        pending: false,
        run: null,
        view: {
          ...farmSnapshot.view,
          boosters: [
            {
              type: "small",
              count: 0,
              restoreEnergy: 5,
              costDollar: 2,
              maxPurchaseQuantity: 100,
            },
            {
              type: "full",
              count: owned,
              restoreEnergy: 10,
              costDollar: 3,
              maxPurchaseQuantity: 100,
            },
          ],
        },
      };
      return renderToStaticMarkup(
        createElement(WorkFarmDialog, {
          work: { workId: 7, title: "Блиндаж" },
          onClose() {},
          goalTargets: [
            {
              required: 25,
              destination: "J2",
              label: "Выполнить Блиндаж 25 раз",
            },
          ],
          farmStore: { subscribe: () => () => {}, getSnapshot: () => snapshot },
        }),
      );
    };
    const paidFarmMarkup = farmPurchaseMarkup(0);
    assert.ok(paidFarmMarkup.includes("Купить за 14 купюр и начать фарм"));
    assert.ok(!paidFarmMarkup.includes("Итого (оценка)"));
    const freeFarmMarkup = farmPurchaseMarkup(5);
    assert.ok(!freeFarmMarkup.includes("Купить за"));
    assert.match(
      freeFarmMarkup,
      /class="requirement-calculator-action"><button[^>]*>Начать фарм<\/button>/,
    );
    assert.ok(!freeFarmMarkup.includes('class="shared-modal-heading-loader"'));
    const { Modal } = await load("components/ui/Modal/Modal.jsx");
    const genericLoadingModal = renderToStaticMarkup(
      createElement(Modal, {
        title: "Загрузка данных",
        loading: true,
        onClose() {},
      }),
    );
    assert.ok(genericLoadingModal.includes('class="ui-border-loader"'));
    const { SiteHeader } = await load(
      "components/layout/SiteHeader/SiteHeader.jsx",
    );
    const loadingHeader = renderToStaticMarkup(
      createElement(SiteHeader, { loading: true }),
    );
    assert.ok(loadingHeader.includes('class="ui-border-loader"'));
    const dividerlessHeader = renderToStaticMarkup(
      createElement(SiteHeader, { loading: true, showDivider: false }),
    );
    assert.ok(!dividerlessHeader.includes('class="ui-border-loader"'));
    const regularWorkEnergyDialogMarkup = renderToStaticMarkup(
      createElement(WorkEnergyDialog, {
        work: departmentById["dept-A1"].work,
        energy: 10,
        onClose() {},
      }),
    );
    assert.ok(regularWorkEnergyDialogMarkup.includes("Фарм · Тестовая работа"));
    const missingWorkMarkup = renderToStaticMarkup(
      createElement(FloorDepartmentContent, {
        department: { ...departmentById["dept-A1"], work: null },
        category: "work",
        available: false,
      }),
    );
    assert.ok(
      missingWorkMarkup.includes(
        'class="base-card base-card--floor-data base-card--locked',
      ),
    );
    assert.ok(missingWorkMarkup.includes("work-card"));
    assert.ok(
      missingWorkMarkup.includes('<span class="button-label">Фарм</span>'),
    );
    assert.equal((missingWorkMarkup.match(/<button\b/g) || []).length, 1);
    assert.ok(
      missingWorkMarkup.includes(
        'class="lock-indicator lock-indicator--locked',
      ),
    );
    assert.ok(missingWorkMarkup.includes("image-card-placeholder"));
    assert.ok(missingWorkMarkup.includes("work-card-energy"));
    assert.match(
      missingWorkMarkup,
      /class="work-card-energy"><span class="lock-indicator/,
    );
    assert.ok(!missingWorkMarkup.includes("ui-icon--energy"));
    assert.match(missingWorkMarkup, /<button[^>]*disabled=""/);
    assert.ok(!missingWorkMarkup.includes("floor-entity-placeholder"));
    const { BossCard } = await load("features/bosses/BossCard/BossCard.jsx");
    const boss = kb.bosses.find((record) => record.apiId === "41");
    // Static rendering exercises the battle UI without a browser or game requests.
    const { BossBattlePanel, BossBattleDetails } = await load(
      "features/bosses/BossBattle/BossBattlePanel.jsx",
    );
    const { normalizeBattle } = await load(
      "features/bosses/BossBattle/boss-battle-controller.js",
    );
    const battleBoss = { id: 41, name: boss.name, reference: boss };
    const battleState = {
      boss: battleBoss,
      battle: null,
      pending: null,
      canStart: true,
      needsRefresh: false,
      medicineOpen: false,
      medicines: null,
    };
    const panel = (patch = {}, now = 1000) =>
      renderToStaticMarkup(
        createElement(BossBattlePanel, {
          state: { ...battleState, ...patch },
          now,
        }),
      );
    const preview = panel();
    assert.ok(preview.includes("Начать бой"));
    assert.ok(!preview.includes('role="progressbar"'));
    const activeBattle = normalizeBattle(
      {
        battleId: "battle-41",
        bossId: 41,
        status: "active",
        playerHealth: 75,
        playerMaxHealth: 100,
        bossHealth: 50,
        bossMaxHealth: 100,
        myDamage: 50,
        participantCount: 1,
        actions: [{ turn: 1, playerDamage: 50, critical: true }],
      },
      41,
      1000,
    );
    const activePanel = panel({ battle: activeBattle });
    assert.equal((activePanel.match(/role="progressbar"/g) || []).length, 2);
    assert.equal(
      (activePanel.match(/ui-progress-bar-segment-shell/g) || []).length,
      2,
    );
    assert.ok(activePanel.includes('aria-label="Здоровье: Босс"'));
    assert.ok(activePanel.includes('aria-label="Здоровье: Вы"'));
    assert.match(
      activePanel,
      /<span class="card-description[^"]*">Уровень 1\+ · Урон 10–20<\/span>/,
    );
    assert.ok(
      activePanel.indexOf("Аптечки") < activePanel.indexOf("Ударить"),
      "medicine action precedes attack action",
    );

    assert.ok(
      activePanel.indexOf("Ударить") <
        activePanel.indexOf("Включить автоудары"),
    );
    assert.ok(activePanel.includes('aria-pressed="false"'));
    const autoPanel = renderToStaticMarkup(
      createElement(BossBattlePanel, {
        state: {
          ...battleState,
          visible: true,
          battle: { ...activeBattle, cooldownKnown: true },
        },
        now: 1000,
        auto: { enabled: true, nextAttackAt: 8000, pause: true },
      }),
    );
    assert.ok(autoPanel.includes('aria-pressed="true"'));
    assert.ok(autoPanel.includes(">Авто</button>"));
    assert.ok(!autoPanel.includes("Авто включено"));
    assert.ok(autoPanel.includes("button-secondary"));
    assert.ok(!autoPanel.includes("Зевок"));
    assert.ok(!autoPanel.includes("7 с"));
    assert.match(autoPanel, /disabled=""[^>]*>.*?Ударить/s);
    assert.ok(autoPanel.includes("Остановить автоудары"));
    const { ActiveBattleAutoStatus } = await load(
      "features/combat/ActiveBattleDock/ActiveBattleDock.jsx",
    );
    const autoDock = renderToStaticMarkup(
      createElement(ActiveBattleAutoStatus, {
        auto: { enabled: true, nextAttackAt: 8000, pause: false },
        now: 1000,
        onStop: () => {},
      }),
    );
    assert.ok(autoDock.includes("Авто включено"));
    assert.ok(autoDock.includes("Остановить автоудары"));
    assert.ok(autoDock.includes(">Стоп<"));
    const { BossActiveBattleBar } = await load(
      "features/combat/ActiveBattleDock/ActiveBattleDock.jsx",
    );
    const bossBar = renderToStaticMarkup(
      createElement(BossActiveBattleBar, {
        boss: { name: "Босс", reference: { image: "/boss-portrait.webp" } },
        battle: activeBattle,
        auto: { enabled: true },
        onOpen: () => {},
        onStop: () => {},
      }),
    );
    assert.ok(bossBar.includes("/boss-portrait.webp"));
    assert.equal((bossBar.match(/role="progressbar"/g) || []).length, 2);
    assert.equal(
      (bossBar.match(/ui-progress-bar-segment-shell/g) || []).length,
      2,
    );
    assert.ok(bossBar.includes('aria-label="HP босса"'));
    assert.ok(bossBar.includes('aria-label="Ваше HP"'));
    assert.ok(bossBar.includes('aria-haspopup="dialog"'));

    const disabledAutoDock = renderToStaticMarkup(
      createElement(ActiveBattleAutoStatus, {
        auto: { enabled: false },
        onStop: () => {},
      }),
    );
    assert.ok(disabledAutoDock.includes("Авто выключено"));
    assert.ok(!disabledAutoDock.includes(">Стоп<"));
    assert.ok(!activePanel.includes("Ваш урон"));
    assert.ok(!activePanel.includes(">Удары<"));
    assert.ok(!activePanel.includes("Последнее событие"));
    assert.ok(!activePanel.includes("Характеристики босса"));
    const waitingPanel = panel({ battle: { ...activeBattle, readyAt: 4000 } });
    assert.match(waitingPanel, /disabled=""[^>]*>.*?Ударить · 3 с/s);
    const wonPanel = panel({
      battle: {
        ...activeBattle,
        status: "won",
        outcome: "Победа",
        rewards: ["Золото: 10"],
      },
    });
    assert.ok(wonPanel.includes("Результат: Победа"));
    assert.ok(!wonPanel.includes("Золото: 10"));
    assert.ok(!wonPanel.includes("Ударить"));
    assert.ok(!wonPanel.includes("Включить автоудары"));
    const { BossBattleReceivedDrops } = await load(
      "features/bosses/BossBattle/BossBattleReference.jsx",
    );
    const receivedMarkup = renderToStaticMarkup(
      createElement(BossBattleReceivedDrops, {
        boss: {
          reference: {
            possibleDrops: [
              {
                type: "activity_item",
                entityId: 1,
                name: "Полученный трофей",
                image: "/test-loot.webp",
              },
              {
                type: "weapon",
                entityId: 2,
                name: "Не выпавший предмет",
                image: "/not-granted.webp",
              },
            ],
          },
        },
        battle: {
          grantedDrops: [{ type: "activity_item", entityId: 1, amount: 2 }],
          currencyRewards: [{ type: "gold", amount: 10 }],
        },
      }),
    );
    assert.ok(receivedMarkup.includes("Полученный дроп"));
    assert.ok(receivedMarkup.includes("/test-loot.webp"));
    assert.ok(receivedMarkup.includes("Полученный трофей"));
    assert.ok(receivedMarkup.includes("×2"));
    assert.ok(!receivedMarkup.includes("Не выпавший предмет"));
    assert.ok(!receivedMarkup.includes("/not-granted.webp"));

    const battleDetails = renderToStaticMarkup(
      createElement(BossBattleDetails, {
        boss: battleBoss,
        battle: activeBattle,
      }),
    );
    assert.ok(battleDetails.includes("Участники"));
    assert.ok(battleDetails.includes("Журнал боя"));
    assert.ok(battleDetails.includes("Критический удар"));
    assert.ok(!battleDetails.includes("Характеристики босса"));
    const disclosures = [
      ...battleDetails.matchAll(
        /<details class="base-card ui-disclosure"[^>]*>[\s\S]*?<\/details>/g,
      ),
    ].map(([markup]) => markup);
    const participantDisclosure = disclosures.find((markup) =>
      markup.includes("Участники"),
    );
    const journalDisclosure = disclosures.find((markup) =>
      markup.includes("Журнал боя"),
    );
    assert.ok(participantDisclosure, "participants disclosure is rendered");
    assert.ok(journalDisclosure, "journal disclosure is rendered");
    assert.ok(!/^<details[^>]*\sopen(?:="")?/.test(participantDisclosure));
    assert.match(journalDisclosure, /^<details[^>]*\sopen(?:="")?/);
    assert.equal(
      boss.image,
      "https://cdn.cargohustle.online/V3/floor/bosses/prew/P41.webp",
    );
    assert.deepEqual(
      boss.dropItems.map((item) => item.entityId),
      [1],
      "only nested activity_item records are shown as boss drop items",
    );
    assert.equal(
      boss.dropItems[0].image,
      "https://cdn.cargohustle.online/V3/items/1.webp",
    );
    const bossMarkup = renderToStaticMarkup(createElement(BossCard, { boss }));
    assert.ok(bossMarkup.includes("/V3/floor/bosses/prew/P41.webp"));
    assert.ok(bossMarkup.includes("/V3/items/1.webp"));
    const { DepartmentBossCard } = await load(
      "features/bosses/DepartmentBossCard/DepartmentBossCard.jsx",
    );
    const departmentBossMarkup = renderToStaticMarkup(
      createElement(DepartmentBossCard, { boss }),
    );
    assert.ok(departmentBossMarkup.includes("Трофей"));
    assert.ok(!departmentBossMarkup.includes("Мутаген"));
    assert.ok(
      renderToStaticMarkup(
        createElement(DepartmentBossCard, {
          boss: {
            ...boss,
            possibleDrops: [{ type: "activity_item", entityId: 7, name: null }],
            dropItems: [{ type: "activity_item", entityId: 7, name: null }],
          },
        }),
      ).includes("Предмет бизнеса №7"),
    );
    assert.ok(departmentBossMarkup.includes("/V3/floor/bosses/prew/P41.webp"));
    const noBusinessItemMarkup = renderToStaticMarkup(
      createElement(DepartmentBossCard, {
        boss: {
          ...boss,
          possibleDrops: [{ type: "mutagen", name: "Мутаген" }],
          dropItems: [],
        },
      }),
    );
    assert.ok(noBusinessItemMarkup.includes("Добыча не указана"));
    assert.ok(!noBusinessItemMarkup.includes("Мутаген"));
    for (const boss of kb.bosses)
      assert.ok(
        renderToStaticMarkup(createElement(BossCard, { boss })).includes(
          "boss-card",
        ),
      );
    const { RequirementCalculatorDialog } = await load(
      "features/calculator/RequirementCalculatorDialog/RequirementCalculatorDialog.jsx",
    );
    for (const department of kb.departments)
      for (const requirement of department.openingConditions || [])
        assert.ok(
          renderToStaticMarkup(
            createElement(RequirementCalculatorDialog, {
              conditionDialog: { requirement, energy: null },
              onClose: () => {},
            }),
          ).includes(requirement.label || "Условие не указано"),
        );
    const { UpgradeDialog } = await load(
      "features/businesses/UpgradeDialog/UpgradeDialog.jsx",
    );
    const { BusinessAssistantDialog } = await load(
      "features/businesses/BusinessAssistant/BusinessAssistantDialog.jsx",
    );
    const businessPlan = {
      businessId: "business:21",
      targetLevel: 3,
      currentLevel: 1,
      currentLevelSource: "game",
      maxLevel: 6,
      config: { targetLevel: 3, currentLevelOverride: null, maxAttempts: null },
      materials: [
        {
          entityId: 1,
          name: "Трофей",
          requiredAmount: 7,
          ownedAmount: 2,
          missingAmount: 5,
          bosses: [{ id: 41, name: "Тестовый босс" }],
        },
      ],
      cost: {
        total: null,
        currency: null,
        nextAmount: 100,
        nextCurrency: "gold",
        complete: false,
      },
      notes: [],
      sourceNotes: [],
    };
    const externalStore = (snapshot) => ({
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
    });
    const assistantHtml = renderToStaticMarkup(
      createElement(BusinessAssistantDialog, {
        business: kb.businesses[0],
        onClose: () => {},
        assistantStore: externalStore({
          plans: [businessPlan],
          loaded: true,
          pending: false,
        }),
        battleStore: externalStore({}),
        goalStore: externalStore(null),
      }),
    );
    assert.ok(assistantHtml.includes("Трофей"));
    assert.ok(assistantHtml.includes("Не хватает: 5"));
    assert.ok(assistantHtml.includes("Ближайшее улучшение: 100 монет"));
    assert.ok(assistantHtml.includes("Создать цель · 5 шт."));
    assert.ok(assistantHtml.includes("Тестовый босс"));
    assert.ok(assistantHtml.includes("Рассчитать и сохранить"));
    assert.ok(assistantHtml.includes("Собрать все материалы"));
    const collectingHtml = renderToStaticMarkup(
      createElement(BusinessAssistantDialog, {
        business: kb.businesses[0],
        onClose: () => {},
        assistantStore: externalStore({
          plans: [businessPlan],
          loaded: true,
          pending: true,
          run: {
            status: "running",
            phase: "farming",
            name: "Мастерская",
            targetLevel: 3,
            battlesStarted: 2,
            battlesCompleted: 1,
            maxBattles: 5,
            config: { durationHours: 2 },
            currentItemName: "Трофей",
            materials: [
              {
                itemId: 1,
                name: "Трофей",
                collectedAmount: 3,
                targetAmount: 7,
              },
            ],
          },
        }),
        battleStore: externalStore({}),
        goalStore: externalStore(null),
      }),
    );
    assert.ok(collectingHtml.includes("Сбор материалов · бой"));
    assert.ok(collectingHtml.includes("общий лимит боёв: 5"));
    assert.match(
      collectingHtml,
      /<button(?![^>]*disabled)[^>]*>Остановить сбор<\/button>/,
    );

    for (const upgrade of kb.businessUpgrades.filter(
      (record) => record.businessId,
    )) {
      const business = kb.businesses.find(
        (record) => record.id === upgrade.businessId,
      );
      assert.ok(
        renderToStaticMarkup(
          createElement(UpgradeDialog, {
            data: { business, upgrade },
            onClose: () => {},
          }),
        ).includes(business.title),
      );
    }
  } finally {
    await server.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
