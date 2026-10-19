import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import kb from "../data/index.js";

test("all sections, boss pages, requirements and upgrade dialogs render from canonical data", async () => {
  const server = await createServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  try {
    const load = (path) => server.ssrLoadModule(`/src/${path}`);
    const { App } = await load("app/App/App.jsx");
    const html = renderToStaticMarkup(createElement(App));
    assert.equal(
      (html.match(/class="floor-group"/g) || []).length,
      kb.floors.length,
    );
    assert.equal(
      (html.match(/class="floor-work-disclosure"/g) || []).length,
      kb.departments.length,
    );
    const { BossCard } = await load("features/bosses/BossCard/BossCard.jsx");
    for (const boss of kb.bosses)
      for (const old of [true, false])
        assert.ok(
          renderToStaticMarkup(createElement(BossCard, { boss, old })).includes(
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
  }
});
