import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { CatalogueStore } from "./catalogue/store.mjs";
import { readKnowledgeBase } from "./catalogue/query.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const store = new CatalogueStore(root);
try {
  assert.equal(
    store.db.prepare("PRAGMA integrity_check").get().integrity_check,
    "ok",
  );
  assert.equal(store.db.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.equal(
    store.db
      .prepare(
        "SELECT count(*) n FROM sources WHERE kind IN ('repository','reference')",
      )
      .get().n,
    0,
    "Legacy sources remain",
  );
  const forbidden =
    /^(accessToken|authorization|tgWebAppData|player|playerState|playerAmount|userId|nickname|username|wallet|owned|equipped|unlocked|isAvailable|progress|current|met|completed|completedCycles|level|currentIncome|nextUpgradePrice)$/i;
  for (const row of store.db
    .prepare(
      "SELECT kind,id,data_json FROM entities UNION ALL SELECT kind,id,data_json FROM entity_observations",
    )
    .all()) {
    const inspect = (value, top = false, path = "") => {
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        assert(
          !forbidden.test(key) ||
            (key === "wallet" && [".rewards", ".reward"].includes(path)) ||
            (key === "level" &&
              ((top && row.kind === "mutagen") ||
                (row.kind === "mutagen_exchange_recipe" &&
                  [".first", ".second", ".result"].includes(path)))),
          `Forbidden reference field ${row.kind}.${key}`,
        );
        inspect(child, false, path + "." + key);
      }
    };
    inspect(JSON.parse(row.data_json), true);
  }
  const kb = readKnowledgeBase(root);
  for (const f of kb.floors)
    for (const id of f.departmentIds)
      assert(kb.departments.some((d) => d.id === id && d.floorId === f.id));
  console.log(
    JSON.stringify({
      integrity: "ok",
      counts: store.report().counts,
      unresolvedLinks: store.report().unresolvedLinks,
    }),
  );
} finally {
  store.close();
}
