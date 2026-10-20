import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { CatalogueStore } from "./store.mjs";
import { fileURLToPath } from "node:url";

// Parse only the public client's literal floor activity routing table; never execute it.
export function activityRoutes(bundle) {
  const match = bundle.match(/aSz=(\{.*?\});function aSA/s);
  if (!match) throw new Error("Public client activity routing table changed");
  const literal = match[1]
    .replace(/\baSw\b/g, '"boss"')
    .replace(/\baSx\b/g, '"work"')
    .replace(/'([^']*)'/g, (_, v) => JSON.stringify(v))
    .replace(/0x[0-9a-f]+/gi, (v) => String(Number(v)));
  const table = JSON.parse(literal);
  return Object.entries(table).flatMap(([floor, departments]) =>
    Object.entries(departments).flatMap(([department, entries]) =>
      entries
        .filter((e) => ["boss", "work", "BIZ"].includes(e[1]))
        .map(([id, type]) => ({
          kind: type === "BIZ" ? "business" : type,
          id,
          floor,
          department,
        })),
    ),
  );
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const bundle = readFileSync(process.argv[2], "utf8");
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const store = new CatalogueStore(root);
  store.db.exec(
    "CREATE TABLE IF NOT EXISTS route_discovery(kind TEXT,id INTEGER,floor_code TEXT,department_code TEXT,client_sha256 TEXT,PRIMARY KEY(kind,id));",
  );
  const hash = createHash("sha256").update(bundle).digest("hex");
  const routes = activityRoutes(bundle);
  store.db.exec("BEGIN; DELETE FROM route_discovery;");
  for (const r of routes)
    store.db
      .prepare("INSERT INTO route_discovery VALUES(?,?,?,?,?)")
      .run(r.kind, r.id, r.floor, r.department, hash);
  store.db.exec("COMMIT;");
  store.close();
  console.log(
    `Discovered ${routes.length} API route identifiers from public client; no game records imported.`,
  );
}
