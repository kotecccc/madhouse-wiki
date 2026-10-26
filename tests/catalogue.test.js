import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CatalogueStore } from "../scripts/catalogue/store.mjs";
import { readKnowledgeBase } from "../scripts/catalogue/query.mjs";
import {
  referenceRecord,
  project,
  projections,
} from "../scripts/catalogue/projection.mjs";

function withStore(run) {
  const root = mkdtempSync(join(tmpdir(), "madhouse-catalogue-test-"));
  const store = new CatalogueStore(root, join(root, "catalogue.sqlite"));
  try {
    run(store);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("projection drops unknown nested fields and account, credential, and access state", () => {
  const record = referenceRecord("weapon", {
    id: 12,
    name: { ru: "Молот", en: "Hammer" },
    title: { ru: "Оружие", en: "Weapon" },
    nameRu: "Молот",
    nameEn: "Hammer",
    Authorization: "secret-header",
    accessToken: "secret-token",
    progress: 4,
    completed: true,
    current: 9,
    met: true,
    player: { id: 99, wallet: { gold: 100 }, access: true },
    wallet: { dollar: 50 },
    unknown: { nested: { player: "private" } },
    unlock: {
      required: true,
      conditionType: "level",
      conditionId: 8,
      requiredLevel: 8,
      progress: 3,
    },
  });

  assert.deepEqual(record, {
    id: 12,
    title: { ru: "Оружие", en: "Weapon" },
    nameRu: "Молот",
    nameEn: "Hammer",
    unlock: {
      required: true,
      conditionType: "level",
      conditionId: 8,
      requiredLevel: 8,
    },
  });
  assert.doesNotThrow(() =>
    project({ title: "Название", titleKey: "weapon.name" }, projections.weapon),
  );
  assert.equal(
    referenceRecord("weapon", { title: "Название" }).title,
    "Название",
  );
});

test("bag activity-item names are projected without inventory quantities and join boss drops by item ID", () => {
  const root = mkdtempSync(join(tmpdir(), "madhouse-activity-items-test-"));
  const store = new CatalogueStore(
    root,
    join(root, "local-data", "madhouse.sqlite"),
  );
  try {
    assert.equal(
      store.capture("/api/me/bag", 200, {
        activityItems: [
          {
            itemId: 17,
            quantity: 42,
            name: "Ключ исповедальни",
            playerAmount: 42,
            owned: true,
          },
        ],
        wallet: { gold: 900 },
      }),
      true,
    );
    store.capture("/api/bosses/1", 200, {
      id: 1,
      nameRu: "Босс",
      possibleDrops: [
        { type: "activity_item", entityId: 17, name: null },
        { type: "activity_item", entityId: 999, name: null },
      ],
    });

    const definition = store.db
      .prepare("SELECT data_json FROM entities WHERE kind='activity_item'")
      .get();
    assert.deepEqual(JSON.parse(definition.data_json), {
      itemId: 17,
      name: "Ключ исповедальни",
    });
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM entities WHERE kind='activity_item'",
        )
        .get().n,
      1,
    );

    const boss = readKnowledgeBase(root).bosses.find(
      (item) => item.apiId === "1",
    );
    assert.deepEqual(
      boss.dropItems.map((item) => item.name),
      ["Ключ исповедальни", "Предмет бизнеса №999"],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("floor info stores all requirement types and links their entity targets", () => {
  withStore((store) => {
    const captured = store.capture("/api/floors/F1/info", 200, {
      floorCode: "F1",
      departments: [
        {
          blockCode: "F1-A",
          nameRu: "Первый сектор",
          requirements: [
            {
              type: "business_level",
              label: "Уровень бизнеса",
              required: 3,
              businessId: 21,
            },
            {
              type: "work_completions",
              label: "Выполнения работ",
              required: 5,
              workId: 31,
            },
            {
              type: "boss_kills",
              label: "Победы над боссом",
              required: 2,
              bossId: 41,
            },
          ],
        },
      ],
    });

    assert.equal(captured, true);
    const requirements = store.db
      .prepare(
        "SELECT id,data_json FROM entities WHERE kind='requirement' ORDER BY id",
      )
      .all()
      .map((row) => ({ id: row.id, ...JSON.parse(row.data_json) }));
    assert.deepEqual(
      requirements.map((item) => item.type),
      ["business_level", "work_completions", "boss_kills"],
    );
    const links = store.db
      .prepare(
        "SELECT from_id,relation,to_kind,to_id FROM entity_links WHERE from_kind='requirement' ORDER BY from_id,relation",
      )
      .all();
    assert.deepEqual(
      links.map(({ relation, to_kind, to_id }) => [relation, to_kind, to_id]),
      [
        ["api_target", "business", "business:21"],
        ["api_target", "work", "work:31"],
        ["api_target", "boss", "boss-41"],
      ],
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) AS n FROM entity_links WHERE from_kind='department' AND relation='requires'",
        )
        .get().n,
      3,
    );
  });
});

test("work projection keeps reference descriptions and omits progress and completion flags", () => {
  const work = referenceRecord("work", {
    id: "work:F1-A",
    name: "Сбор металла",
    title: "Работа сектора",
    description: "Соберите металл для мастерской.",
    departmentId: "F1-A",
    stash: "metal",
    sourceRecordId: 72,
    progress: 6,
    completed: true,
    current: 8,
    met: true,
    player: { wallet: { gold: 1 }, completed: true },
  });

  assert.deepEqual(work, {
    id: "work:F1-A",
    name: "Сбор металла",
    title: "Работа сектора",
    description: "Соберите металл для мастерской.",
    departmentId: "F1-A",
    stash: "metal",
    sourceRecordId: 72,
  });
  assert.equal(Object.hasOwn(work, "progress"), false);
  assert.equal(Object.hasOwn(work, "completed"), false);
});

test("work-open persistence stores definitions, task costs and recipe facts without account state", () => {
  withStore((store) => {
    assert.equal(
      store.capture("/api/works/tasks/perform", 200, {}, "POST"),
      false,
    );
    assert.equal(store.capture("/api/floors", 200, {}, "DELETE"), false);
    store.capture(
      "/api/works/open",
      200,
      {
        workId: 9,
        title: "Архив",
        completedCycles: 8,
        energy: { current: 12 },
        wallet: { gold: 900 },
        topWorker: { userId: 33 },
        tasks: [
          {
            id: 1,
            title: "Разобрать архив",
            required: 5,
            energyCost: 2,
            progress: 3,
            completed: false,
            canPerform: true,
          },
        ],
      },
      "POST",
      9,
    );
    const row = store.db
      .prepare("SELECT data_json FROM works WHERE api_id='9'")
      .get();
    assert.deepEqual(JSON.parse(row.data_json), {
      workId: 9,
      title: "Архив",
      tasks: [{ id: 1, title: "Разобрать архив", required: 5, energyCost: 2 }],
    });
    assert.equal(
      store.db
        .prepare(
          "SELECT status FROM captures WHERE path='/api/works/open?workId=9'",
        )
        .get().status,
      200,
    );
  });
});

test("ornament set and zone responses retain catalogue membership without ownership flags", () => {
  withStore((store) => {
    store.capture("/api/ornaments/zones/2", 200, {
      zoneId: 2,
      items: [
        {
          elementId: 31,
          setId: 7,
          zoneId: 2,
          name: "Элемент",
          setName: "Набор",
          setDescription: "Описание набора",
          itemBonus: { madness: 3 },
          owned: true,
          equipped: true,
          setBonusActive: true,
        },
      ],
    });
    store.capture("/api/ornaments/sets/7", 200, {
      id: 7,
      name: "Набор",
      ornaments: [{ id: 31, zoneId: 2, received: true }],
    });
    store.capture("/api/ornaments/sets/7/zones", 200, {
      zones: [2, { zoneId: 3 }],
    });
    store.capture("/api/ornaments/sets/7/zones", 200, {
      setId: 7,
      items: [
        { elementId: 31, setId: 7, zoneId: 2, itemBonus: { madness: 3 } },
      ],
      collectedCount: 1,
      progress: "1/4",
    });
    const elements = store.db
      .prepare("SELECT data_json FROM entities WHERE kind='ornament_element'")
      .all();
    assert.equal(elements.length, 1);
    assert.deepEqual(JSON.parse(elements[0].data_json), {
      id: 31,
      name: "Элемент",
      elementId: 31,
      setId: 7,
      zoneId: 2,
      setName: "Набор",
      setDescription: "Описание набора",
      itemBonus: { madness: 3 },
    });
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) n FROM entity_links WHERE relation='in_set' AND from_kind='ornament_element'",
        )
        .get().n,
      1,
    );
    assert.equal(
      store.db
        .prepare("SELECT count(*) n FROM entities WHERE kind='ornament_zone'")
        .get().n,
      2,
    );
  });
});

test("refresh replaces an owner requirement set and removes obsolete targets without clearing other owners", () => {
  withStore((store) => {
    const capture = (requirements) =>
      store.capture("/api/floors/A/info", 200, {
        floorCode: "A",
        departments: [{ blockCode: "A1", name: "Отдел", requirements }],
      });
    capture([
      { type: "business_level", label: "Бизнес", required: 3, businessId: 21 },
      { type: "work_completions", label: "Работа", required: 5, workId: 31 },
    ]);
    store.capture("/api/floors/B/info", 200, {
      floorCode: "B",
      departments: [
        {
          blockCode: "B1",
          name: "Другой отдел",
          requirements: [
            { type: "player_level", label: "Уровень", required: 2 },
          ],
        },
      ],
    });
    capture([
      {
        type: "boss_kills",
        label: "Босс",
        required: 7,
        bossId: 41,
        current: 6,
        met: false,
      },
    ]);
    const rows = store.db
      .prepare(
        "SELECT data_json FROM entities WHERE kind='requirement' ORDER BY id",
      )
      .all()
      .map((r) => JSON.parse(r.data_json));
    assert.deepEqual(rows, [
      { type: "boss_kills", label: "Босс", required: 7, bossId: 41 },
      { type: "player_level", label: "Уровень", required: 2 },
    ]);
    assert.deepEqual(
      store.db
        .prepare(
          "SELECT to_kind,to_id FROM entity_links WHERE from_kind='requirement' AND relation='api_target'",
        )
        .all()
        .map((r) => ({ ...r })),
      [{ to_kind: "boss", to_id: "boss-41" }],
    );
    capture([]);
    assert.equal(
      store.db
        .prepare("SELECT count(*) n FROM entities WHERE kind='requirement'")
        .get().n,
      1,
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) n FROM entity_observations WHERE kind='requirement'",
        )
        .get().n,
      1,
    );
    assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  });
});

test("an accessible floor omitting unlock definitions does not erase previously observed rules", () => {
  withStore((store) => {
    store.capture("/api/floors", 200, [
      {
        code: "B",
        number: 2,
        isAvailable: false,
        unlockBlockCode: "B1",
        unlockDescription: "Иметь проходную 5 уровня",
        unlockRequirements: [
          {
            type: "business_level",
            label: "Иметь проходную 5 уровня",
            required: 5,
            businessId: 7,
            current: 1,
            met: false,
          },
        ],
      },
    ]);
    store.capture("/api/floors", 200, [
      {
        code: "B",
        number: 2,
        isAvailable: true,
        unlockBlockCode: null,
        unlockDescription: null,
        unlockRequirements: [],
      },
    ]);
    const floor = JSON.parse(
      store.db
        .prepare(
          "SELECT data_json FROM entities WHERE kind='floor' AND api_id='B'",
        )
        .get().data_json,
    );
    assert.equal(floor.unlockDescription, "Иметь проходную 5 уровня");
    assert.equal(floor.unlockBlockCode, "B1");
    assert.equal(floor.unlockRequirements.length, 1);
    assert(!Object.hasOwn(floor, "isAvailable"));
    assert.equal(
      store.db
        .prepare(
          "SELECT count(*) n FROM entity_links WHERE from_kind='floor' AND relation='requires'",
        )
        .get().n,
      1,
    );
    const requirement = JSON.parse(
      store.db
        .prepare("SELECT data_json FROM entities WHERE kind='requirement'")
        .get().data_json,
    );
    assert.deepEqual(requirement, {
      type: "business_level",
      label: "Иметь проходную 5 уровня",
      required: 5,
      businessId: 7,
    });
    store.capture("/api/floors", 200, [
      {
        code: "B",
        number: 2,
        isAvailable: false,
        unlockDescription: "Новое правило",
        unlockRequirements: [
          {
            type: "boss_kills",
            label: "Новое правило",
            required: 8,
            bossId: 41,
          },
        ],
      },
    ]);
    assert.equal(
      store.db
        .prepare(
          "SELECT to_kind FROM entity_links WHERE from_kind='requirement' AND relation='api_target'",
        )
        .get().to_kind,
      "boss",
    );
  });
});

test("boss reward preview retains currency definitions without account state and reaches the UI model", () => {
  withStore((store) => {
    store.capture("/api/bosses/49", 200, {
      id: 49,
      nameRu: "Босс",
      rewardPreview: {
        gold: 1500,
        pills: 2,
        dollar: 0,
        exp: 100,
        wallet: { gold: 999 },
        playerId: 10,
      },
      wallet: { gold: 999 },
      claimed: true,
    });
    const boss = readKnowledgeBase(store.root, store.file).bosses.find(
      (item) => String(item.apiId) === "49",
    );
    assert.deepEqual(boss.rewardPreview, { gold: 1500, pills: 2, dollar: 0 });
    assert.equal(boss.wallet, undefined);
    assert.equal(boss.claimed, undefined);
  });
});

test("release seed includes the J floor work definitions required by the server executor", () => {
  const data = readKnowledgeBase(
    process.cwd(),
    join(process.cwd(), "catalogue/reference.sqlite"),
  );
  for (const [id, title] of [
    [28, "Блиндаж"],
    [29, "Капище друида"],
  ]) {
    const work = data.works.find(
      (work) => Number(work.workId ?? work.apiId) === id,
    );
    assert.ok(work, `release seed must contain work ${id}`);
    assert.equal(work.title, title);
    assert.ok(work.tasks.length > 0);
    assert.ok(
      data.departments.some((department) => department.work?.id === work.id),
    );
  }
});
