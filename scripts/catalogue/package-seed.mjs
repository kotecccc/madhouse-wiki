import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { referenceRecord } from "./projection.mjs";

// Explicit release export, never a copy of the private database. Rebuilding a
// new SQLite file also excludes deleted pages, observations and raw documents.
export function packageSeed(root, destination) {
  const source = new DatabaseSync(resolve(root, "local-data/madhouse.sqlite"), {
    readOnly: true,
  });
  mkdirSync(dirname(destination), { recursive: true });
  rmSync(destination, { force: true });
  const seed = new DatabaseSync(destination);
  try {
    seed.exec(
      readFileSync(resolve(root, "scripts/catalogue/schema.sql"), "utf8"),
    );
    seed.exec("BEGIN");
    for (const row of source
      .prepare("SELECT * FROM sources ORDER BY id")
      .all()) {
      if (!["api", "public-client", "user-provided"].includes(row.kind))
        throw new Error("Unreviewed source kind");
      if (!/^(api:|client:|user:)/.test(row.id))
        throw new Error("Unreviewed source identifier");
      // Provenance is retained; raw source_documents are deliberately excluded.
      seed
        .prepare("INSERT INTO sources VALUES (?,?,?,?,?,?)")
        .run(
          row.id,
          row.kind,
          row.locator,
          row.verification,
          row.note,
          row.fetched_at,
        );
    }
    for (const row of source
      .prepare("SELECT * FROM entities ORDER BY kind,id")
      .all()) {
      const data = referenceRecord(row.kind, JSON.parse(row.data_json));
      if (!data || !Object.keys(data).length)
        throw new Error("Unreviewed entity kind");
      seed
        .prepare("INSERT INTO entities VALUES (?,?,?,?,?,?,?)")
        .run(
          row.kind,
          row.id,
          row.api_id,
          row.name,
          row.source_id,
          JSON.stringify(data),
          row.updated_at,
        );
    }
    for (const row of source
      .prepare(
        "SELECT * FROM entity_links ORDER BY from_kind,from_id,relation,to_kind,to_id",
      )
      .all())
      seed
        .prepare("INSERT INTO entity_links VALUES (?,?,?,?,?,?,?)")
        .run(
          row.from_kind,
          row.from_id,
          row.relation,
          row.to_kind,
          row.to_id,
          row.ordinal,
          row.source_id,
        );
    for (const row of source
      .prepare("SELECT * FROM route_discovery ORDER BY kind,id")
      .all())
      seed
        .prepare("INSERT INTO route_discovery VALUES (?,?,?,?,?)")
        .run(
          row.kind,
          row.id,
          row.floor_code,
          row.department_code,
          row.client_sha256,
        );
    // Coverage contains only route/status/count/time, never response bodies.
    for (const row of source
      .prepare("SELECT * FROM captures ORDER BY path")
      .all())
      seed
        .prepare("INSERT INTO captures VALUES (?,?,?,?,?)")
        .run(row.path, row.status, row.entity_count, row.captured_at, null);
    seed.exec(
      "INSERT INTO metadata VALUES ('schema_version','3'); PRAGMA user_version=3; COMMIT; VACUUM;",
    );
    console.log(
      "Public SQLite seed packaged:",
      seed.prepare("SELECT count(*) AS entities FROM entities").get().entities,
    );
  } finally {
    seed.close();
    source.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  packageSeed(root, resolve(root, "catalogue/reference.sqlite"));
}
