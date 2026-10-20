import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogueStore } from "../scripts/catalogue/store.mjs";
import { readKnowledgeBase } from "../scripts/catalogue/query.mjs";
import {
  importUserUpgrades,
  parseUserUpgradeTables,
  normalizeBlockCode,
  USER_UPGRADE_SOURCE,
} from "../scripts/catalogue/import-user-upgrades.mjs";
import {
  getBusinessUpgradeTotals,
  findItemBosses,
} from "../src/lib/business-upgrades.js";

const source = readFileSync(
  new URL(
    "../local-data/sources/user-business-upgrades-2026-10-20.md",
    import.meta.url,
  ),
  "utf8",
);
test("user tables preserve every level, source total and mixed-script department code", () => {
  assert.equal(normalizeBlockCode("С-3"), "C3");
  assert.equal(normalizeBlockCode("М-1"), "M1");
  const records = parseUserUpgradeTables(source);
  assert.equal(records.length, 14);
  assert.equal(
    records.reduce((n, r) => n + r.items[0].levels.length, 0),
    74,
  );
  const mourning = records.find((r) => r.title === "Траурная");
  assert.deepEqual(mourning.items[0].levels, [8, 12, 13, 18, 18]);
  assert.deepEqual(
    getBusinessUpgradeTotals(mourning, 3).map((i) => i.requiredAmount),
    [33, 26],
  );
  assert.deepEqual(
    getBusinessUpgradeTotals(mourning, 5).map((i) => i.requiredAmount),
    [69, 62],
  );
  assert.deepEqual(
    mourning.unlocks.map((u) => [u.targetCode, u.requiredLevel]),
    [
      ["D1", 3],
      ["G1", 5],
    ],
  );
  const mismatch = records.flatMap((r) =>
    r.sourceTotals.filter((t) => !t.matches),
  );
  assert.equal(mismatch.length, 1);
  assert.equal(mismatch[0].itemName, "Палаческий болт");
  assert.equal(mismatch[0].declared, 133);
  assert.equal(mismatch[0].computed, 136);
});

test("user import is transactional, idempotent, traceable and preserves API definitions and unknown recipes", () => {
  const root = mkdtempSync(join(tmpdir(), "madhouse-user-tables-"));
  mkdirSync(join(root, "local-data"));
  const store = new CatalogueStore(root);
  try {
    store.source("test-api", "api", "test", "fixture");
    for (const code of "ABCDEFGHIJKLMN")
      store.apiEntity("floor", code, { code }, "test-api");
    store.apiEntity(
      "department",
      "B1",
      { blockCode: "B1", floorId: "floor-B", name: "API department" },
      "test-api",
    );
    store.apiEntity("business", 8, { title: "Исследовательская" }, "test-api");
    store.link(
      "business",
      "business:8",
      "in_department",
      "department",
      "dept-B1",
      "test-api",
    );
    store.apiEntity("business", 6, { title: "Проходная" }, "test-api");
    const names = [
      ...new Set(
        parseUserUpgradeTables(source).flatMap((r) =>
          r.items.map((i) => i.name),
        ),
      ),
    ];
    const ids = new Map();
    names.forEach((name, index) => {
      const itemId = 200 + index;
      ids.set(name, itemId);
      // Boss and item identities deliberately differ; some item names come from bag definitions.
      const canonicalName =
        name === "Инквизитора печать" ? "Инквизиторская печать" : name;
      store.apiEntity(
        "activity_item",
        itemId,
        { itemId, name: canonicalName },
        "test-api",
      );
      store.apiEntity(
        "boss",
        index + 1,
        {
          nameRu: `Босс ${index + 1}`,
          possibleDrops: [
            { type: "activity_item", entityId: itemId, name: null },
          ],
        },
        "test-api",
      );
    });
    assert.throws(
      () =>
        importUserUpgrades(
          store,
          source.replaceAll("Трофейный череп", "Несуществующий предмет"),
        ),
      /Cannot uniquely map/,
    );
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM business_upgrades").get().n,
      0,
    );
    assert.equal(
      store.db
        .prepare("SELECT count(*) n FROM sources WHERE id=?")
        .get(USER_UPGRADE_SOURCE).n,
      0,
    );
    importUserUpgrades(store, source);
    const count = store.db.prepare("SELECT count(*) n FROM entities").get().n;
    importUserUpgrades(store, source);
    assert.equal(
      store.db.prepare("SELECT count(*) n FROM entities").get().n,
      count,
    );
    assert.equal(
      store.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(
      store.db
        .prepare("SELECT content FROM source_documents WHERE source_id=?")
        .get(USER_UPGRADE_SOURCE).content,
      source,
    );
    assert.equal(
      store.db
        .prepare(
          "SELECT source_id FROM entities WHERE kind='business' AND id='business:8'",
        )
        .get().source_id,
      "test-api",
    );
    let kb = readKnowledgeBase(root);
    assert.equal(kb.businessUpgrades.length, 14);
    assert(!kb.businessUpgrades.some((u) => u.businessId === "business:6"));
    const research = kb.businessUpgrades.find(
      (u) => u.businessId === "business:8",
    );
    assert.equal(research.items[0].entityId, ids.get("Трофейный череп"));
    assert.equal(
      findItemBosses(kb.bosses, research.items[1].entityId)[0].name,
      "Босс 2",
    );
    const n3 = kb.departments.find((d) => d.code === "N3");
    assert.equal(
      n3.openingConditions.filter((r) => r.type === "business_level").length,
      2,
    );
    assert(
      n3.openingConditions.some((r) => r.targetDepartmentId === "dept-N2"),
    );
    assert.equal(
      kb.floors
        .find((f) => f.code === "C")
        .openingConditions.filter((r) => r.type === "business_level").length,
      1,
    );
    // API captures may refresh their own rules; user supplements must survive and deduplicate.
    store.source("recapture", "api", "test", "fixture");
    store.requirements(
      "floor",
      "floor-C",
      [
        {
          type: "business_level",
          businessId: 8,
          required: 3,
          label: "API wording retained",
        },
      ],
      "recapture",
    );
    kb = readKnowledgeBase(root);
    const conditions = kb.floors.find((f) => f.code === "C").openingConditions;
    assert.equal(
      conditions.filter((r) => r.type === "business_level").length,
      1,
    );
    assert(conditions.some((r) => r.targetDepartmentId === "dept-B3"));
    assert(conditions.some((r) => r.label === "API wording retained"));
    assert.equal(
      kb.businessUpgrades.every((r) => r.sourceId === USER_UPGRADE_SOURCE),
      true,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
