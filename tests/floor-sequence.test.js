import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CatalogueStore } from "../scripts/catalogue/store.mjs";
import { importFloorSequence } from "../scripts/catalogue/import-floor-sequence.mjs";
import { readKnowledgeBase } from "../scripts/catalogue/query.mjs";

test("all floors after A require the previous final department first, without duplicating existing rules", () => {
  const root = mkdtempSync(join(tmpdir(), "wiki-floor-sequence-"));
  mkdirSync(join(root, "local-data"));
  const store = new CatalogueStore(root);
  try {
    store.source("fixture", "api", "fixture", "fixture");
    const codes = [..."ABCDEFGHIJKLMNO", "$"];
    for (const code of codes)
      store.apiEntity("floor", code, { code }, "fixture");
    store.requirements(
      "floor",
      "floor-C",
      [
        {
          type: "business_level",
          businessId: 8,
          required: 3,
          label: "Business rule",
        },
        {
          type: "department_open",
          targetDepartmentId: "dept-B3",
          label: "Existing sequence rule",
        },
        { type: "boss_kills", bossId: 1, required: 5, label: "Other rule" },
      ],
      "fixture",
    );
    assert.equal(importFloorSequence(store), 14);
    assert.equal(importFloorSequence(store), 0);
    const kb = readKnowledgeBase(root);
    assert.deepEqual(
      kb.floors.find((f) => f.code === "A").openingConditions,
      [],
    );
    for (let i = 1; i < codes.length; i++) {
      const rules = kb.floors.find(
        (f) => f.code === codes[i],
      ).openingConditions;
      assert.equal(rules[0].targetDepartmentId, `dept-${codes[i - 1]}3`);
      assert.equal(rules.filter((r) => r.type === "department_open").length, 1);
    }
    assert.deepEqual(
      kb.floors
        .find((f) => f.code === "C")
        .openingConditions.map((r) => r.label),
      ["Existing sequence rule", "Business rule", "Other rule"],
    );
    assert.equal(
      store.db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok",
    );
    assert.deepEqual(store.db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
