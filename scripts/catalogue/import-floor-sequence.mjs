import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CatalogueStore } from "./store.mjs";

const sourceId = "user:floor-sequence:2026-10-20";
export function importFloorSequence(store) {
  const codes = [..."ABCDEFGHIJKLMNO", "$"];
  let added = 0;
  store.db.exec("BEGIN");
  try {
    store.source(
      sourceId,
      "user-provided",
      "Browser comment: floor opening sequence, 2026-10-20",
      "provided-by-user; not-api-verified",
      "Такие требования на открытие отделения обязательны на всех этажах, начиная с этажа B, включая последний, 16 этаж доллар. Первым выводить открыть отделение, затем бизнес либо любое другое требование.",
    );
    for (let index = 1; index < codes.length; index++) {
      const floorId = `floor-${codes[index]}`;
      const previousCode = `${codes[index - 1]}3`;
      const departmentId = `dept-${previousCode}`;
      if (
        !store.db
          .prepare("SELECT 1 FROM entities WHERE kind='floor' AND id=?")
          .get(floorId)
      )
        throw new Error(`Missing floor ${floorId}`);
      if (
        !store.db
          .prepare("SELECT 1 FROM entities WHERE kind='department' AND id=?")
          .get(departmentId)
      ) {
        store.entity(
          "department",
          departmentId,
          {
            code: previousCode,
            blockCode: previousCode,
            floorId: `floor-${codes[index - 1]}`,
          },
          sourceId,
        );
        store.link(
          "department",
          departmentId,
          "on_floor",
          "floor",
          `floor-${codes[index - 1]}`,
          sourceId,
        );
      }
      const existing = store.db
        .prepare(
          `SELECT 1 FROM entity_links l JOIN entities r ON r.kind=l.to_kind AND r.id=l.to_id
        WHERE l.from_kind='floor' AND l.from_id=? AND l.relation IN ('requires','supplements')
        AND r.kind='requirement' AND json_extract(r.data_json,'$.type')='department_open'
        AND json_extract(r.data_json,'$.targetDepartmentId')=?`,
        )
        .get(floorId, departmentId);
      if (existing) continue;
      const id = `${sourceId}:${codes[index]}`;
      store.entity(
        "requirement",
        id,
        {
          type: "department_open",
          label: `Открыть отделение ${previousCode}`,
          targetDepartmentId: departmentId,
          sourceId,
          verification: "user-provided",
        },
        sourceId,
      );
      store.link("floor", floorId, "supplements", "requirement", id, sourceId);
      store.link(
        "requirement",
        id,
        "target",
        "department",
        departmentId,
        sourceId,
      );
      added++;
    }
    store.db.exec("COMMIT");
    return added;
  } catch (error) {
    store.db.exec("ROLLBACK");
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const store = new CatalogueStore(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  try {
    console.log(JSON.stringify({ added: importFloorSequence(store) }));
  } finally {
    store.close();
  }
}
