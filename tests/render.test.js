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
    const { BossCard } = await load("features/bosses/BossCard/BossCard.jsx");
    const boss = kb.bosses.find((record) => record.apiId === "41");
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
