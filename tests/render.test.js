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
      stashSetId: 3,
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
  store.capture("/api/stash/sets", 200, {
    sets: [
      {
        setId: 3,
        title: "Тестовый набор",
        ingredients: [
          { ingredientId: 1, imageUrl: "/one.webp", owned: 10 },
          { ingredientId: 2, imageUrl: "/two.webp", owned: 0 },
        ],
      },
    ],
  });
  store.close();
  const kb = readKnowledgeBase(fixtureRoot);
  assert.equal(kb.works[0].stashSet.ingredients.length, 2);
  assert.equal(kb.departments[0].work.stashSet.setId, 3);
  assert.ok(
    kb.works[0].stashSet.ingredients.every(
      (item) => !Object.hasOwn(item, "owned"),
    ),
  );
  const server = await createServer({
    configFile: false,
    plugins: [react(), cataloguePlugin(fixtureRoot)],
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const load = (path) => server.ssrLoadModule(`/src/${path}`);
    const { ActionQueueSection } = await load(
      "features/action-queue/ActionQueueSection.jsx",
    );
    for (const state of [
      { auto: { userPaused: true } },
      { raid: { userPaused: true } },
      { businessAssistant: { run: { status: "paused" } } },
      { workFarm: { run: { status: "paused" } } },
    ]) {
      const markup = renderToStaticMarkup(
        createElement(ActionQueueSection, {
          authenticated: true,
          state,
          catalogue: {},
          onCommand() {},
        }),
      );
      assert.match(markup, />Продолжить<\/button>/);
    }
    const { RaidPost, RaidFriendAction } = await load(
      "features/raids/RaidPost/RaidPost.jsx",
    );
    const friendRaid = {
      raids: [{ boss: "Тестовый босс", leader: "@alice" }],
      raidDateLabel: "сегодня",
    };
    const renderFriendRaid = (status) =>
      renderToStaticMarkup(
        createElement(RaidPost, {
          post: friendRaid,
          authenticated: true,
          subscriptionState: {
            loaded: true,
            friend: { statuses: { "name:alice": status } },
          },
        }),
      );
    assert.match(
      renderFriendRaid("none"),
      /aria-label="Действия: Тестовый босс"/,
    );
    const renderFriendAction = (friendStatus) =>
      renderToStaticMarkup(
        createElement(RaidFriendAction, {
          authenticated: true,
          friendStatus,
          friendTarget: { username: "alice" },
        }),
      );
    assert.match(renderFriendAction("none"), /Добавить ведущего в друзья/);
    assert.match(renderFriendAction("pending"), /Заявка отправлена/);
    assert.doesNotMatch(renderFriendAction("friend"), /В друзьях/);
    assert.doesNotMatch(
      renderFriendAction("friend"),
      /Добавить ведущего в друзья/,
    );
    assert.match(renderFriendAction("uncertain"), /Проверить заявку в друзья/);
    const { bossMenuRows } = await load(
      "features/bosses/BossCard/BossCardView.jsx",
    );
    const { Button } = await load("components/ui/Button/Button.jsx");
    const events = [];
    const rows = bossMenuRows(
      createElement(Button, {
        icon: "user-plus",
        "aria-label": "Добавить ведущего в друзья",
        onClick: () => events.push("action"),
      }),
      () => events.push("close"),
    );
    assert.match(renderToStaticMarkup(rows[0]), /Добавить ведущего в друзья/);
    rows[0].props.onClick({});
    assert.deepEqual(events, ["close", "action"]);
    const disabledRows = bossMenuRows(
      createElement(Button, { disabled: true, "aria-label": "Ожидание" }),
      () => {},
    );
    assert.equal(disabledRows[0].props.disabled, true);
    const { businessStatesFromFloorInfo } = await load(
      "features/floors/useDepartmentAvailability.js",
    );
    const listedBusinessStates = businessStatesFromFloorInfo({
      businesses: [
        { id: 21, level: 0, currentIncome: { gold: 5 } },
        { id: 22, level: 3, currentIncome: 7, currency: "pills" },
        { id: "invalid", level: 1 },
      ],
    });
    assert.deepEqual(listedBusinessStates, {
      21: { id: 21, level: 0, currentIncome: { gold: 5 } },
      22: { id: 22, level: 3, currentIncome: 7, currency: "pills" },
    });
    const { WorkStashCard } = await load(
      "features/works/WorkCard/WorkStashCard.jsx",
    );
    const stashWork = {
      stashSet: {
        setId: 3,
        title: "Набор",
        ingredients: [
          { ingredientId: 1, imageUrl: "/one.webp" },
          { ingredientId: 2, imageUrl: "/two.webp" },
        ],
      },
    };
    const stashHtml = renderToStaticMarkup(
      createElement(WorkStashCard, {
        work: stashWork,
        stash: {
          setId: 3,
          ingredients: [
            { ingredientId: 1, quantity: 0, purchaseUnlocked: false },
          ],
        },
      }),
    );
    assert.equal((stashHtml.match(/role="listitem"/g) || []).length, 0);
    assert.ok(stashHtml.includes("ui-disclosure-summary"));
    assert.ok(stashHtml.includes("— / 2"));
    const guestStashHtml = renderToStaticMarkup(
      createElement(WorkStashCard, { work: stashWork }),
    );
    assert.ok(!guestStashHtml.includes("не разблокирован"));

    const { App } = await load("app/App/App.jsx");
    const html = renderToStaticMarkup(createElement(App));
    assert.ok(html.includes("floor-group"));
    assert.ok(!html.includes('id="screen-floors"'));
    const { MobileNavigation } = await load(
      "components/layout/MobileNavigation/MobileNavigation.jsx",
    );
    const navigationMarkup = renderToStaticMarkup(
      createElement(MobileNavigation, {
        activeScreen: "overview",
        onScreenChange() {},
      }),
    );
    assert.equal((navigationMarkup.match(/<button\b/g) || []).length, 3);
    assert.ok(navigationMarkup.includes('aria-controls="screen-queue"'));
    assert.ok(navigationMarkup.includes('aria-controls="screen-overview"'));
    assert.ok(navigationMarkup.includes('aria-controls="screen-raids"'));
    assert.ok(!navigationMarkup.includes('aria-label="Этажи"'));

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
    assert.ok(lockedFloorSelectorMarkup.includes("floor-selector-indicators"));
    assert.ok(
      lockedFloorSelectorMarkup.includes('aria-label="Заблокировано в игре"'),
    );
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
            stats: [
              ["Безумие", 1000, 10000, "HP"],
              ["Агрессия", 2000, 2000, "урон"],
              ["Ярость", 300, 3.5, "% шанс крита"],
            ],
            statBreakdown: {
              Безумие: { base: 900, bonus: 100, total: 1000 },
            },
            stashBuffs: [
              {
                setId: 1,
                name: "Тестовая заначка",
                expiresAtUtc: "2099-01-01T00:00:00Z",
                expiresAtMs: Date.parse("2099-01-01T00:00:00Z"),
                madness: 50,
                aggression: 0,
                rage: 0,
              },
            ],
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
    assert.ok(overviewMarkup.includes("Тестовая заначка"));
    assert.ok(overviewMarkup.includes("Осталось"));
    assert.match(
      overviewMarkup,
      /<dd>950 <span class="status-text">\+ 50<\/span><\/dd>/,
    );
    for (const name of ["Безумие", "Ярость"])
      assert.match(
        overviewMarkup,
        new RegExp(
          String.raw`<dt><svg[\s\S]*?</svg>${name}<button[^>]*aria-label="${name}"`,
        ),
      );
    for (const stat of ["madness", "aggression", "rage"])
      assert.ok(overviewMarkup.includes(`ui-icon--${stat}`));
    assert.doesNotMatch(overviewMarkup, /<dd>[^<]*(?:HP|урон|шанс крита)/);
    assert.ok(overviewMarkup.includes("HP"));
    assert.match(overviewMarkup, /title="Безумие: 10\s000 HP(?:\.|")/);
    assert.ok(overviewMarkup.includes('title="Ярость: 3,5% шанс крита"'));
    assert.ok(!overviewMarkup.includes('aria-label="Агрессия"'));
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
    assert.ok(workMarkup.includes('aria-label="Действия: Тестовая работа"'));
    assert.ok(workMarkup.includes('aria-expanded="false"'));
    assert.equal((workMarkup.match(/<button\b/g) || []).length, 0);
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
        'aria-label="Действия: Тестовая работа"',
      ),
    );
    assert.equal((workWithoutTargetMarkup.match(/<button\b/g) || []).length, 0);
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
      ["bosses", categoryMarkup("bosses", [], false)],
      ["businesses", categoryMarkup("businesses", [], false)],
    ]) {
      assert.ok(
        markup.includes("base-card--locked"),
        `${category} cards render the shared locked state`,
      );
      assert.ok(
        markup.includes('class="lock-indicator lock-indicator--locked'),
        `${category} cards render a lock indicator where locked`,
      );
      assert.ok(
        !markup.includes(">Заблокировано<"),
        `${category} cards do not render literal locked status text`,
      );
    }
    const { DepartmentBossCard: LevelBossCard } = await load(
      "features/bosses/DepartmentBossCard/DepartmentBossCard.jsx",
    );
    const renderBossLevel = (playerLevel) =>
      renderToStaticMarkup(
        createElement(LevelBossCard, {
          boss: {
            ...kb.bosses[0],
            requiredLevel: 7,
            rewardUntilLevel: 15,
            rewardPreview: { gold: 10, pills: 20, dollar: 30 },
          },
          playerLevel,
        }),
      );
    const overlevelBossMarkup = renderBossLevel(16);
    assert.ok(!overlevelBossMarkup.includes("Переросли"));
    for (const amount of [10, 20, 30])
      assert.ok(overlevelBossMarkup.includes(`<s>${amount}</s>`));
    assert.ok(overlevelBossMarkup.includes("награда по уровню недоступна"));
    assert.ok(!renderBossLevel(15).includes("<s>"));
    assert.ok(!renderBossLevel(null).includes("<s>"));
    assert.ok(!overlevelBossMarkup.includes("Предел награды"));
    assert.match(overlevelBossMarkup, /aria-label="Действия: [^"]+"/);
    assert.ok(renderBossLevel(6).includes("Нужен 7 уровень"));
    assert.ok(!renderBossLevel(15).includes("Переросли"));
    assert.ok(!renderBossLevel(null).includes("boss-level-status"));
    const { BossCollectionStatus } = await load(
      "features/bosses/collection/BossCollectionStatus.jsx",
    );
    const collectionBoss = {
      possibleDrops: [
        { type: "room", entityId: 7, mode: "unlock_for_purchase" },
        { type: "activity_item", entityId: 1, mode: "grant" },
      ],
    };
    const renderCollection = (state) =>
      renderToStaticMarkup(
        createElement(BossCollectionStatus, { boss: collectionBoss, state }),
      );
    const completeCollectionMarkup = renderCollection({
      status: "ready",
      responses: {
        "/api/rooms": {
          catalog: { rooms: [{ id: 7, unlocked: true, owned: false }] },
        },
      },
    });
    assert.ok(!completeCollectionMarkup.includes(">1 из 1<"));
    assert.ok(
      completeCollectionMarkup.includes(
        'aria-label="Получено 1 из 1 вещевых наград"',
      ),
    );
    assert.ok(completeCollectionMarkup.includes("ui-icon--medium"));
    assert.ok(completeCollectionMarkup.includes("ui-pill--completed"));
    for (const status of ["idle", "loading", "partial"]) {
      assert.equal(renderCollection({ status, responses: {} }), "");
      assert.equal(
        renderCollection({
          status,
          responses: {
            "/api/rooms": { catalog: { rooms: [{ id: 7, unlocked: true }] } },
          },
        }),
        "",
      );
    }
    assert.equal(renderCollection({ status: "ready", responses: {} }), "");
    const uncollectedMarkup = renderCollection({
      status: "ready",
      responses: {
        "/api/rooms": {
          catalog: { rooms: [{ id: 7, unlocked: false, owned: false }] },
        },
      },
    });
    assert.ok(uncollectedMarkup.includes(">0 из 1<"));
    assert.ok(uncollectedMarkup.includes("ui-pill--scheduled"));
    const renderTargetBoss = (extra = {}) =>
      renderToStaticMarkup(
        createElement(LevelBossCard, {
          boss: {
            ...kb.bosses[0],
            possibleDrops: collectionBoss.possibleDrops,
          },
          targeted: true,
          goalTargets: [{ required: 10, current: 6 }],
          collectionState: {
            status: "ready",
            responses: {
              "/api/rooms": {
                catalog: { rooms: [{ id: 7, unlocked: false, owned: false }] },
              },
            },
          },
          ...extra,
        }),
      );
    const targetBossMarkup = renderTargetBoss();
    assert.ok(
      targetBossMarkup.includes('aria-label="Осталось побед для задания: 4"'),
    );
    assert.ok(
      targetBossMarkup.indexOf('aria-label="Осталось побед') <
        targetBossMarkup.indexOf('aria-label="Получено'),
    );
    assert.ok(targetBossMarkup.includes("0 из 1"));
    assert.ok(
      !renderTargetBoss({ goalTargets: [{ required: 10 }] }).includes(
        'aria-label="Осталось побед',
      ),
    );
    const lockedTargetMarkup = renderTargetBoss({ locked: true });
    assert.ok(!lockedTargetMarkup.includes('aria-label="Осталось побед'));
    assert.ok(!lockedTargetMarkup.includes('aria-label="Получено'));
    const lockedBossMarkup = categoryMarkup("bosses", [], false);
    assert.ok(lockedBossMarkup.includes("base-card--locked"));
    assert.ok(
      lockedBossMarkup.includes('class="lock-indicator lock-indicator--locked'),
    );
    assert.ok(!lockedBossMarkup.includes('aria-label="Бой: Тестовый босс"'));
    // Menu actions are only rendered after the card is activated.
    assert.ok(!lockedBossMarkup.includes('class="boss-card-actions"'));
    assert.match(floorBossMarkup, /aria-label="Действия: [^"]+"/);

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
    assert.ok(workEnergyDialogMarkup.includes("Работа · Тестовая работа"));
    const { WorkFarmDialog } = await load(
      "features/works/WorkCard/WorkFarmDialog.jsx",
    );
    const assertStopAvailable = (markup) => {
      const buttons = [
        ...markup.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g),
      ].filter(([, , body]) => body.includes(">Остановить</span>"));
      assert.equal(buttons.length, 1);
      assert.doesNotMatch(buttons[0][1], /disabled/);
      assert.match(buttons[0][2], /tabler-icon-player-stop/);
    };
    const loadingFarmSnapshot = {
      loaded: true,
      pending: false,
      view: null,
      run: null,
    };
    const renderFarmState = (snapshot) =>
      renderToStaticMarkup(
        createElement(WorkFarmDialog, {
          work: { workId: 7, title: "Блиндаж", energyCycle: { full: 10 } },
          profileSnapshot: { energy: { current: 360, max: 360 } },
          onClose() {},
          farmStore: { subscribe: () => () => {}, getSnapshot: () => snapshot },
        }),
      );
    for (const snapshot of [
      loadingFarmSnapshot,
      { ...loadingFarmSnapshot, pending: true },
    ]) {
      const markup = renderFarmState(snapshot);
      assert.ok(markup.includes("ui-border-loader"));
      assert.ok(!markup.includes("ui-skeleton"));
      assert.ok(markup.includes("work-calculator-count"));
      assert.ok(!markup.includes("План заданий"));
      assert.ok(markup.includes("Вариант 1: ждать энергию"));
      assert.ok(markup.includes("Необходимо энергии"));
      assert.ok(markup.includes("Количество выполнений"));
      assert.match(markup, /id="work-calculator-count"[^>]*min="1"/);
      assert.ok(markup.includes("MAX"));
      assert.ok(markup.includes('aria-label="Режим выполнения работы"'));
      assert.ok(
        markup.indexOf('aria-label="Режим выполнения работы"') <
          markup.indexOf('id="work-calculator-count"'),
      );
      assert.ok(markup.includes('aria-checked="false"'));
      assert.ok(!markup.includes("Предварительный расчёт по справочнику"));
      assert.ok(markup.includes('aria-checked="true"'));
      assert.match(markup, /<footer[\s\S]*>Начать фарм/);
      assert.equal(
        /<button[^>]*disabled[^>]*>Начать фарм/.test(markup),
        Boolean(snapshot.pending || !snapshot.loaded),
      );
      assert.ok(!markup.includes("стоимость энергии"));
      assert.ok(!markup.includes("Целевое количество выполнений достигнуто"));
    }
    const failedFarmMarkup = renderFarmState({
      ...loadingFarmSnapshot,
      loaded: false,
      error: "Не удалось загрузить работу",
    });
    assert.ok(failedFarmMarkup.includes("Необходимо энергии"));
    assert.doesNotMatch(
      failedFarmMarkup,
      /Не удалось загрузить работу|Обновить данные|Не удалось обновить работу/,
    );
    assert.match(failedFarmMarkup, /<footer[\s\S]*Закрыть[\s\S]*Начать фарм/);
    assert.ok(!failedFarmMarkup.includes("ui-skeleton"));
    const rejectedRefreshMarkup = renderFarmState({
      ...loadingFarmSnapshot,
      notice: "Не удалось подтвердить прогресс работёнки.",
    });
    assert.ok(rejectedRefreshMarkup.includes("Необходимо энергии"));
    assert.ok(!rejectedRefreshMarkup.includes("Сервис недоступен"));
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
        config: {
          mode: "wait",
          maxActions: 30000,
          maxBoosters: 0,
          maxDollar: 0,
          allowPurchase: false,
        },
        energySpent: 0,
        actionsDone: 2,
        usedBoosters: 0,
        spentDollar: 0,
      },
    };
    const energyModeMarkup = renderToStaticMarkup(
      createElement(WorkFarmDialog, {
        work: { workId: 7, title: "Блиндаж", energyCycle: { full: 420 } },
        onClose() {},
        farmStore: {
          subscribe: () => () => {},
          getSnapshot: () => ({
            ...farmSnapshot,
            pending: false,
            view: {
              ...farmSnapshot.view,
              energy: { current: 360, max: 360 },
              tasks: [
                {
                  id: 1,
                  required: 42,
                  progress: 0,
                  energyCost: 10,
                  canPerform: true,
                },
              ],
            },
            run: {
              ...farmSnapshot.run,
              config: { mode: "energy", maxActions: 30000 },
              energyBudget: 360,
              energySpent: 0,
            },
          }),
        },
      }),
    );
    assert.ok(energyModeMarkup.includes('aria-checked="true"'));
    assert.ok(!energyModeMarkup.includes('id="work-calculator-count"'));
    assert.ok(
      energyModeMarkup.includes('aria-label="Режим выполнения работы"'),
    );
    assert.ok(energyModeMarkup.includes("Будут выполнены"));
    assert.ok(energyModeMarkup.includes("×36"));
    assert.ok(!energyModeMarkup.includes("Вариант 2: купить дефибрилляторы"));
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
    assert.ok(farmMarkup.includes("Количество выполнений"));
    assert.ok(!farmMarkup.includes("Проверка состояния"));
    assert.ok(!farmMarkup.includes("Предварительный расчёт по справочнику"));
    assert.ok(!farmMarkup.includes("Итого (оценка)"));
    assert.ok(!farmMarkup.includes('class="requirement-calculator-action"'));
    assert.ok(farmMarkup.includes("Необходимо энергии"));
    assert.ok(farmMarkup.includes("Вариант 1: ждать энергию"));
    assert.ok(!farmMarkup.includes("Начать фарм"));
    assert.match(farmMarkup, /<footer[\s\S]*>Остановить<\/span><\/button>/);
    assert.ok(!farmMarkup.includes("Максимум действий"));
    assert.ok(!farmMarkup.includes("Ограничение времени"));
    assert.ok(!farmMarkup.includes("Настройки фарма"));
    assert.ok(farmMarkup.includes('class="requirement-calculator-card"'));
    assertStopAvailable(farmMarkup);
    assert.ok(farmMarkup.includes('aria-busy="true"'));
    assert.ok(farmMarkup.includes('class="shared-modal-heading-loader"'));
    assert.ok(farmMarkup.includes('class="ui-border-loader"'));
    assert.ok(farmMarkup.includes('aria-label="Прогресс фарма"'));
    const waitProgressIndex = farmMarkup.indexOf(
      'aria-label="Прогресс выбранного варианта"',
    );
    assert.ok(waitProgressIndex > farmMarkup.indexOf("Необходимо энергии"));
    assert.ok(
      waitProgressIndex > farmMarkup.indexOf("Вариант 1: ждать энергию"),
    );
    assert.ok(!farmMarkup.includes("Фарм идёт · 20 / 25"));
    const activePurchaseSnapshot = {
      ...farmSnapshot,
      run: {
        ...farmSnapshot.run,
        config: { ...farmSnapshot.run.config, mode: "boosters" },
      },
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
      (activePurchaseMarkup.match(/>Остановить<\/span><\/button>/g) || [])
        .length,
      1,
    );
    assertStopAvailable(activePurchaseMarkup);
    const farmPurchaseMarkup = (owned) => {
      const snapshot = {
        ...farmSnapshot,
        pending: false,
        run: null,
        configs: { 7: { mode: "boosters" } },
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
    assert.ok(paidFarmMarkup.includes("Фарм за 14 купюр"));
    assert.ok(!paidFarmMarkup.includes("Итого (оценка)"));
    const paidForm = paidFarmMarkup.slice(
      paidFarmMarkup.indexOf("<form"),
      paidFarmMarkup.indexOf("</form>"),
    );
    assert.ok(!paidForm.includes("Начать фарм"));
    assert.ok(!paidForm.includes("Фарм за 14 купюр"));
    assert.match(paidFarmMarkup, /<footer[\s\S]*Фарм за 14 купюр/);
    assert.match(
      paidFarmMarkup,
      /role="button"[^>]*aria-pressed="true"[^>]*>[\s\S]*Вариант 2: купить дефибрилляторы/,
    );

    const freeFarmMarkup = farmPurchaseMarkup(5);
    assert.ok(!freeFarmMarkup.includes("Купить за"));
    assert.match(
      freeFarmMarkup,
      /<footer[\s\S]*<button[^>]*>Начать фарм<\/button>/,
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
    const noFooterModal = renderToStaticMarkup(
      createElement(Modal, {
        title: "Без подвала",
        footer: false,
        onClose() {},
      }),
    );
    assert.ok(!noFooterModal.includes("<footer"));
    assert.ok(noFooterModal.includes("dialog-close-button"));
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
    assert.ok(
      regularWorkEnergyDialogMarkup.includes("Работа · Тестовая работа"),
    );
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
    assert.equal((missingWorkMarkup.match(/<button\b/g) || []).length, 0);
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
    assert.ok(!missingWorkMarkup.includes('role="button"'));
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
          departmentCode: "F1",
        }),
      );
    const preview = panel();
    assert.ok(!preview.includes("Начать бой"));
    assert.ok(preview.includes("F1 •"));
    assert.ok(!preview.includes("Подготовка"));
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
      /<span class="card-description[^"]*">Уровень 1\+<\/span>/,
    );
    assert.ok(
      activePanel.indexOf("Аптечки") < activePanel.indexOf("Ударить"),
      "medicine action precedes attack action",
    );

    assert.ok(!activePanel.includes("Включить автоудары"));
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
    assert.ok(!autoPanel.includes(">Авто</button>"));
    assert.ok(!autoPanel.includes("Авто включено"));
    assert.ok(!autoPanel.includes("boss-battle-panel-controls"));
    assert.ok(!autoPanel.includes("Зевок"));
    assert.ok(!autoPanel.includes("7 с"));
    assert.ok(!autoPanel.includes("Ударить"));
    assert.ok(!autoPanel.includes("Остановить автоудары"));
    const { BossBattleGoalPanel } = await load(
      "features/bosses/BossBattle/BossBattleGoalPanel.jsx",
    );
    const settingsPanel = (patch = {}, auto = { enabled: false }) =>
      renderToStaticMarkup(
        createElement(BossBattleGoalPanel, {
          state: {
            ...battleState,
            openingRequirements: [
              { category: "bosses", required: 65, current: 12 },
            ],
            ...patch,
          },
          goal: null,
          auto,
          onStart: () => true,
          onStopAuto: () => true,
        }),
      );
    const { BossInvitationsContent } = await load(
      "features/bosses/BossInvitations/BossInvitations.jsx",
    );
    const invitationsHtml = renderToStaticMarkup(
      createElement(BossInvitationsContent, {
        state: {
          loaded: true,
          items: [
            {
              invitationId: "test-invite",
              bossId: 41,
              bossName: "Тестовый босс",
              sender: "Друг",
              available: true,
            },
          ],
          unresolved: true,
        },
        onAccept: () => {},
        onReconcile: () => {},
      }),
    );
    assert.ok(invitationsHtml.includes("Принять и открыть бой"));
    assert.ok(invitationsHtml.includes("Проверить вступление"));
    assert.ok(invitationsHtml.includes("Зовёт: Друг"));
    assert.doesNotMatch(
      invitationsHtml,
      /disabled=""[^>]*>Принять и открыть бой/,
    );
    const settingsHtml = settingsPanel();
    assert.ok(settingsHtml.includes("Цель и условия боя"));
    assert.ok(settingsHtml.includes("ui-disclosure ui-disclosure--sm"));
    assert.ok(settingsHtml.includes(">Цель и условия боя</span>"));
    assert.ok(settingsHtml.includes("number-stepper"));
    assert.ok(settingsHtml.includes('aria-label="Увеличить количество"'));
    assert.ok(settingsHtml.includes('aria-label="Цель боя"'));
    assert.equal((settingsHtml.match(/role="radio"/g) || []).length, 7);
    assert.ok(settingsHtml.includes('value="53"'));
    assert.ok(settingsHtml.includes("Количество побед"));
    assert.ok(settingsHtml.includes("Сколько ходить"));
    assert.equal((settingsHtml.match(/<select/g) || []).length, 0);
    for (const removed of [
      "Настроить цель",
      "Настройка цели",
      "Создать цель",
      "Отмена",
      "Тип цели",
      "Лимит боёв",
      "Предмет бизнеса",
      "Для открытия",
    ])
      assert.ok(!settingsHtml.includes(removed), removed);
    assert.ok(settingsHtml.includes('aria-label="Начать автобой"'));
    assert.ok(
      settingsPanel({}, { enabled: true }).includes(
        'aria-label="Остановить автобой"',
      ),
    );
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
    assert.match(waitingPanel, /Ударить · 3 с/);
    assert.doesNotMatch(waitingPanel, /disabled=""[^>]*>.*?Ударить · 3 с/s);
    const wonPanel = panel({
      battle: {
        ...activeBattle,
        status: "won",
        outcome: "Победа",
        rewards: ["Золото: 10"],
      },
    });
    assert.ok(!wonPanel.includes("Результат: Победа"));
    assert.ok(!wonPanel.includes('aria-label="Здоровье: Босс"'));
    assert.ok(!wonPanel.includes("Золото: 10"));
    assert.ok(!wonPanel.includes("Ударить"));
    assert.ok(!wonPanel.includes("Включить автоудары"));
    const { BossBattleReceivedDrops } = await load(
      "features/bosses/BossBattle/BossBattleReference.jsx",
    );
    for (const [rewardKnown, message] of [
      [true, "Предметы не выпали."],
      [false, "Получаем данные о награде…"],
    ]) {
      const rewardMarkup = renderToStaticMarkup(
        createElement(BossBattleReceivedDrops, {
          boss: { reference: {} },
          battle: { rewardKnown, grantedDrops: [] },
        }),
      );
      assert.ok(rewardMarkup.includes(message));
    }
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
        /<details class="base-card[^"]*ui-disclosure[^"]*"[^>]*>[\s\S]*?<\/details>/g,
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
    const lockedDepartmentBossMarkup = renderToStaticMarkup(
      createElement(DepartmentBossCard, { boss, locked: true }),
    );
    assert.match(
      lockedDepartmentBossMarkup,
      /class="lock-indicator lock-indicator--locked"[^>]*aria-label="Босс недоступен"/,
    );
    assert.ok(!lockedDepartmentBossMarkup.includes("boss-battle-status"));
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
    const { BusinessCard } = await load(
      "features/businesses/BusinessCard/BusinessCard.jsx",
    );
    const business = kb.businesses[0];
    const lockedBusinessMarkup = renderToStaticMarkup(
      createElement(BusinessCard, {
        business,
        locked: true,
        onUpgradeSelect: () => {},
        goalAction: createElement("button", null, "Цель"),
      }),
    );
    assert.match(
      lockedBusinessMarkup,
      /class="lock-indicator lock-indicator--locked"[^>]*aria-label="Бизнес недоступен"/,
    );
    assert.doesNotMatch(
      lockedBusinessMarkup,
      /role="button"|business-upgrade-open|>Цель<|aria-haspopup="dialog"/,
    );
    const listedBusinessMarkup = renderToStaticMarkup(
      createElement(BusinessCard, {
        business,
        businessStateProvided: true,
        businessState: {
          id: Number(business.apiId),
          level: 3,
          currentIncome: { gold: 15 },
        },
      }),
    );
    assert.ok(listedBusinessMarkup.includes("Ур. 3"));
    assert.ok(listedBusinessMarkup.includes("15"));
    const missingBusinessMarkup = renderToStaticMarkup(
      createElement(BusinessCard, { business, businessStateProvided: true }),
    );
    assert.ok(!missingBusinessMarkup.includes("Ур. 0"));
    assert.ok(missingBusinessMarkup.includes("Доход неизвестен"));
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
    const renderBusinessRun = (run, queuedBusinessIds = []) =>
      renderToStaticMarkup(
        createElement(BusinessAssistantDialog, {
          business: kb.businesses[0],
          onClose: () => {},
          assistantStore: externalStore({
            plans: [],
            loaded: true,
            run,
            queuedBusinessIds,
          }),
          battleStore: externalStore({}),
          goalStore: externalStore(null),
        }),
      );
    const completedRun = {
      businessId: kb.businesses[0].id,
      status: "completed",
      config: { autoUpgrade: true },
    };
    assert.ok(renderBusinessRun(completedRun).includes("Улучшение завершено"));
    assert.ok(
      !renderBusinessRun({
        ...completedRun,
        businessId: "another-business",
      }).includes("Улучшение завершено"),
    );
    assert.ok(
      !renderBusinessRun(completedRun, [kb.businesses[0].id]).includes(
        "Улучшение завершено",
      ),
    );
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
    assert.match(assistantHtml, /aria-label="Действия: Тестовый босс"/);
    assert.ok(!assistantHtml.includes("Создать цель · 5 шт."));
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
      /<button(?![^>]*disabled)[^>]*>Остановить<\/button>/,
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
