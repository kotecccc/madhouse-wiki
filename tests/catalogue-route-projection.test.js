import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { readKnowledgeBase } from "../scripts/catalogue/query.mjs";

test("projects route-only department metadata and route membership", () => {
  const root = mkdtempSync(join(tmpdir(), "madhouse-route-model-"));
  mkdirSync(join(root, "local-data"));
  const db = new DatabaseSync(join(root, "local-data", "madhouse.sqlite"));
  try {
    db.exec(
      readFileSync(
        new URL("../scripts/catalogue/schema.sql", import.meta.url),
        "utf8",
      ),
    );
    db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?)").run(
      "api",
      "api",
      "/api/floors",
      "verified",
      null,
      "2026-10-20",
    );
    const entity = db.prepare("INSERT INTO entities VALUES (?,?,?,?,?,?,?)");
    entity.run(
      "floor",
      "floor-A",
      "A",
      "A",
      "api",
      JSON.stringify({ code: "A" }),
      "2026-10-20",
    );
    entity.run(
      "department",
      "dept-A1",
      "A1",
      "A1",
      "api",
      JSON.stringify({ blockCode: "A1", floorId: "floor-A", name: "API name" }),
      "2026-10-20",
    );
    entity.run(
      "work",
      "work-7",
      "7",
      "API work",
      "api",
      JSON.stringify({ title: "API work", tasks: [] }),
      "2026-10-20",
    );
    entity.run(
      "boss",
      "boss-9",
      "9",
      "API boss",
      "api",
      JSON.stringify({ nameRu: "API boss" }),
      "2026-10-20",
    );
    entity.run(
      "stash_set",
      "stash_set:30",
      "30",
      "Керосинка",
      "api",
      JSON.stringify({
        title: "Набор «Керосинка»",
        setId: 30,
        previewImageUrl: "https://cdn.cargohustle.online/stash/J/3_1.webp",
      }),
      "2026-10-20",
    );
    const route = db.prepare("INSERT INTO route_discovery VALUES (?,?,?,?,?)");
    route.run("work", 7, "A", "A1", "client-hash");
    route.run("boss", 9, "$", "$2", "client-hash");
    route.run("work", 30, "J", "J3", "client-hash");
    const model = readKnowledgeBase(root);
    const floorA = model.floors.find((floor) => floor.code === "A");
    const floorDollar = model.floors.find((floor) => floor.code === "$");
    const deptA1 = model.departments.find(
      (department) => department.code === "A1",
    );
    const deptDollar2 = model.departments.find(
      (department) => department.code === "$2",
    );

    assert.deepEqual(floorA.departmentIds, ["dept-A1"]);
    assert.equal(deptA1.name, "API name");
    assert.equal(
      model.works.find((work) => work.apiId === "7").departmentId,
      "dept-A1",
    );
    assert.equal(
      model.bosses.find((boss) => boss.apiId === "9").departmentId,
      "dept-$2",
    );
    assert.equal(floorDollar.metadataOnly, true);
    assert.equal(deptDollar2.metadataOnly, true);
    assert.equal(deptDollar2.name, undefined);
    const j3 = model.departments.find((department) => department.code === "J3");
    assert.equal(j3.work, null);
    assert.equal(j3.stashPreview.title, "Набор «Керосинка»");
    assert.equal(
      j3.stashPreview.image,
      "https://cdn.cargohustle.online/stash/J/3_1.webp",
    );
    assert.equal(
      model.works.some((work) => work.apiId === "30"),
      false,
    );
    assert.equal(deptDollar2.stashPreview, null);
    assert.equal(model.routeDiscovery.departments, 3);
    assert.equal(model.routeDiscovery.clientSha256, "client-hash");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps API departments and boss relationships when route metadata is absent", () => {
  const root = mkdtempSync(join(tmpdir(), "madhouse-api-model-"));
  mkdirSync(join(root, "local-data"));
  const db = new DatabaseSync(join(root, "local-data", "madhouse.sqlite"));
  try {
    db.exec(
      readFileSync(
        new URL("../scripts/catalogue/schema.sql", import.meta.url),
        "utf8",
      ),
    );
    db.prepare("INSERT INTO sources VALUES (?,?,?,?,?,?)").run(
      "api",
      "api",
      "/api/floors",
      "verified",
      null,
      "2026-10-20",
    );
    const entity = db.prepare("INSERT INTO entities VALUES (?,?,?,?,?,?,?)");
    entity.run(
      "floor",
      "floor-A",
      "A",
      "A",
      "api",
      JSON.stringify({ code: "A" }),
      "2026-10-20",
    );
    entity.run(
      "department",
      "dept-A1",
      "A1",
      "A1 name",
      "api",
      JSON.stringify({ blockCode: "A1", name: "A1 name" }),
      "2026-10-20",
    );
    entity.run(
      "boss",
      "boss-9",
      "9",
      "API boss",
      "api",
      JSON.stringify({ nameRu: "API boss" }),
      "2026-10-20",
    );
    db.prepare("INSERT INTO entity_links VALUES (?,?,?,?,?,?,?)").run(
      "department",
      "dept-A1",
      "on_floor",
      "floor",
      "floor-A",
      0,
      "api",
    );
    db.prepare("INSERT INTO entity_links VALUES (?,?,?,?,?,?,?)").run(
      "boss",
      "boss-9",
      "in_department",
      "department",
      "dept-A1",
      0,
      "api",
    );

    const model = readKnowledgeBase(root);
    assert.equal(model.routeDiscovery, null);
    assert.deepEqual(model.floors[0].departmentIds, ["dept-A1"]);
    assert.equal(model.departments[0].name, "A1 name");
    assert.equal(model.departments[0].metadataOnly, undefined);
    assert.equal(model.bosses[0].departmentId, "dept-A1");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
