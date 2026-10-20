import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import {
  referenceRecord,
  catalogueRoute,
  project,
  projections,
} from "./projection.mjs";

export class CatalogueStore {
  constructor(root, file = resolve(root, "local-data/madhouse.sqlite")) {
    this.root = root;
    this.file = file;
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL;");
    if (this.db.prepare("PRAGMA user_version").get().user_version < 3) {
      this.db.exec(
        "BEGIN; DROP VIEW IF EXISTS works; DROP VIEW IF EXISTS businesses; DROP VIEW IF EXISTS bosses; COMMIT;",
      );
    }
    this.db.exec(
      readFileSync(new URL("./schema.sql", import.meta.url), "utf8"),
    );
    this.db.exec("PRAGMA user_version=3;");
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS entity_observations (kind TEXT NOT NULL,id TEXT NOT NULL,source_id TEXT NOT NULL REFERENCES sources(id),data_json TEXT NOT NULL CHECK(json_valid(data_json)),observed_at TEXT NOT NULL,FOREIGN KEY(kind,id) REFERENCES entities(kind,id),PRIMARY KEY(kind,id,source_id));`,
    );
    if (
      this.db.prepare("SELECT 1 FROM sources WHERE kind='repository'").get()
    ) {
      this.db.exec(
        "BEGIN; DELETE FROM entity_links; DELETE FROM entity_observations; DELETE FROM entities; DELETE FROM sources; DELETE FROM captures; COMMIT;",
      );
    }
    this.db
      .prepare("INSERT OR REPLACE INTO metadata VALUES (?,?)")
      .run("schema_version", "3");
    this.db
      .prepare("INSERT OR REPLACE INTO metadata VALUES (?,?)")
      .run(
        "privacy",
        "Reference fields only; no credentials, profiles, balances, ownership, counters or access flags.",
      );
  }
  json(path) {
    return JSON.parse(readFileSync(resolve(this.root, path), "utf8"));
  }
  source(id, kind, locator, verification, note = null) {
    this.db
      .prepare(
        "INSERT INTO sources VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fetched_at=excluded.fetched_at",
      )
      .run(id, kind, locator, verification, note, new Date().toISOString());
  }
  entity(kind, id, value, sourceId, apiId = null) {
    const data = referenceRecord(kind, value);
    if (!data || !Object.keys(data).length) return null;
    id = String(id);
    apiId = apiId == null ? null : String(apiId);
    const previous = this.db
      .prepare("SELECT data_json FROM entities WHERE kind=? AND id=?")
      .get(kind, id);
    const merged = {
      ...(previous ? JSON.parse(previous.data_json) : {}),
      ...data,
    };
    const title =
      merged.nameRu ?? merged.name ?? merged.title ?? merged.key ?? null;
    const name =
      typeof title === "object" && title !== null
        ? (title.ru ?? title.en ?? null)
        : title;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO entities VALUES (?,?,?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET api_id=coalesce(excluded.api_id,entities.api_id),name=coalesce(excluded.name,entities.name),source_id=excluded.source_id,data_json=excluded.data_json,updated_at=excluded.updated_at`,
      )
      .run(kind, id, apiId, name, sourceId, JSON.stringify(merged), now);
    this.db
      .prepare("INSERT OR REPLACE INTO entity_observations VALUES (?,?,?,?,?)")
      .run(kind, id, sourceId, JSON.stringify(data), now);
    return id;
  }
  link(fromKind, fromId, relation, toKind, toId, sourceId, ordinal = 0) {
    if (fromId == null || toId == null) return;
    this.db
      .prepare("INSERT OR REPLACE INTO entity_links VALUES (?,?,?,?,?,?,?)")
      .run(
        fromKind,
        String(fromId),
        relation,
        toKind,
        String(toId),
        ordinal,
        sourceId,
      );
  }
  apiEntity(kind, apiId, value, sourceId) {
    if (apiId === undefined || apiId === null || apiId === "") return null;
    const previous = this.db
      .prepare("SELECT id FROM entities WHERE kind=? AND api_id=?")
      .get(kind, String(apiId));
    let id = previous?.id;
    if (!id && kind === "floor") id = "floor-" + apiId;
    if (!id && kind === "department") id = "dept-" + apiId;
    if (!id && kind === "boss") id = "boss-" + apiId;
    id ??= kind + ":" + apiId;
    return this.entity(kind, id, value, sourceId, apiId);
  }
  requirements(ownerKind, ownerId, values, sourceId) {
    if (!Array.isArray(values)) return;
    // A successful definition response replaces this owner's whole rule set.
    // Delete outgoing targets as well: an indexed requirement may change type.
    const previous = this.db
      .prepare(
        "SELECT to_id FROM entity_links WHERE from_kind=? AND from_id=? AND relation='requires' AND to_kind='requirement'",
      )
      .all(ownerKind, ownerId);
    this.db
      .prepare(
        "DELETE FROM entity_links WHERE from_kind=? AND from_id=? AND relation='requires' AND to_kind='requirement'",
      )
      .run(ownerKind, ownerId);
    for (const { to_id: id } of previous) {
      if (
        this.db
          .prepare(
            "SELECT 1 FROM entity_links WHERE to_kind='requirement' AND to_id=?",
          )
          .get(id)
      )
        continue;
      this.db
        .prepare(
          "DELETE FROM entity_links WHERE from_kind='requirement' AND from_id=?",
        )
        .run(id);
      this.db
        .prepare(
          "DELETE FROM entity_observations WHERE kind='requirement' AND id=?",
        )
        .run(id);
      this.db
        .prepare("DELETE FROM entities WHERE kind='requirement' AND id=?")
        .run(id);
    }
    for (let i = 0; i < (values ?? []).length; i++) {
      const r = values[i];
      const id = ownerKind + ":" + ownerId + ":requirement:" + i;
      if (!this.entity("requirement", id, r, sourceId)) continue;
      this.link(ownerKind, ownerId, "requires", "requirement", id, sourceId, i);
      for (const [key, kind] of [
        ["targetDepartmentId", "department"],
        ["targetBossId", "boss"],
        ["targetBusinessId", "business"],
      ])
        if (r[key])
          this.link("requirement", id, "target", kind, r[key], sourceId);
      for (const [key, kind] of [
        ["workId", "work"],
        ["bossId", "boss"],
        ["businessId", "business"],
      ])
        if (r[key] != null) {
          const target = this.db
            .prepare("SELECT id FROM entities WHERE kind=? AND api_id=?")
            .get(kind, String(r[key]));
          this.link(
            "requirement",
            id,
            "api_target",
            kind,
            target?.id ?? (kind === "boss" ? "boss-" : kind + ":") + r[key],
            sourceId,
          );
        }
    }
  }
  initialize() {
    const spec = this.json("public/api-docs/openapi.readonly.json");
    for (const [path, item] of Object.entries(spec.paths))
      this.db
        .prepare("INSERT OR REPLACE INTO api_operations VALUES (?,?,?,?,?)")
        .run(
          "GET",
          path,
          item.get.summary,
          path === "/api/me/bag"
            ? "account-field-allowlist"
            : catalogueRoute(path)
              ? "reference-or-parameterized"
              : "excluded-personal-or-unreviewed",
          JSON.stringify(item.get.responses),
        );
  }
  capture(url, status, body, method = "GET", workId = null) {
    if (method !== "GET" && !(method === "POST" && url === "/api/works/open"))
      return false;
    const path =
      method === "POST" && url === "/api/works/open"
        ? url
        : catalogueRoute(url);
    if (!path) return false;
    const source = "api:" + path;
    this.source(
      source,
      "api",
      path,
      "observed-reference-projection",
      "Only explicitly selected reference fields are persisted.",
    );
    let count = 0;
    const put = (kind, id, v) => {
      const key = this.apiEntity(kind, id, v, source);
      if (key) count++;
      return key;
    };
    const entries = (v) => (Array.isArray(v) ? v : []);
    this.db.exec("BEGIN");
    try {
      if (status === 200 && body && typeof body === "object") {
        const route = path.split("?")[0];
        const segments = route.split("/");
        const last = segments.at(-1);
        if (route === "/api/me/bag")
          for (const item of entries(body.activityItems))
            put("activity_item", item.itemId, item);
        else if (route === "/api/floors")
          for (const f of entries(body)) {
            // The list omits unlock definitions once a floor is accessible to
            // this account. Such an empty response is not a rule deletion.
            const omittedForAccount =
              f.isAvailable === true &&
              f.unlockDescription == null &&
              (!Array.isArray(f.unlockRequirements) ||
                f.unlockRequirements.length === 0);
            const definition = { ...f };
            if (omittedForAccount) {
              delete definition.unlockDescription;
              delete definition.unlockRequirements;
              delete definition.unlockBlockCode;
            }
            const id = put("floor", f.code, definition);
            if (id && !omittedForAccount)
              this.requirements("floor", id, f.unlockRequirements, source);
          }
        else if (/^\/api\/floors\/.+\/info$/.test(route)) {
          const code = body.floorCode ?? segments.at(-2);
          const f = put("floor", code, { code });
          for (const d of entries(body.departments)) {
            const code = d.blockCode ?? d.code;
            const id = put("department", code, { ...d, floorId: f });
            if (id) {
              this.link("department", id, "on_floor", "floor", f, source);
              this.requirements("department", id, d.requirements, source);
            }
          }
          for (const b of entries(body.businesses)) {
            const id = put("business", b.id, b);
            if (id) this.link("business", id, "on_floor", "floor", f, source);
          }
        } else if (route === "/api/works/open") {
          put("work", body.workId, body);
        } else if (/^\/api\/bosses\/\d+$/.test(route))
          put("boss", body.id ?? last, body);
        else if (/^\/api\/businesses\/\d+$/.test(route))
          put("business", body.id ?? last, body);
        else if (route === "/api/clothing") {
          for (const set of entries(body.catalog?.sets)) {
            const setId = put("clothing_set", set.id, set);
            for (const item of entries(set.items)) {
              const itemId = put("clothing_item", item.id, item);
              if (itemId && setId)
                this.link(
                  "clothing_item",
                  itemId,
                  "in_set",
                  "clothing_set",
                  setId,
                  source,
                );
            }
          }
        } else if (/^\/api\/clothing\/by-category\//.test(route))
          for (const item of entries(body.items))
            put("clothing_item", item.id, item);
        else if (/^\/api\/clothing\/sets\//.test(route)) {
          const set = body.set ?? body;
          const id = put("clothing_set", set.id ?? last, set);
          for (const item of entries(set.items ?? body.items)) {
            const itemId = put("clothing_item", item.id, item);
            if (itemId && id)
              this.link(
                "clothing_item",
                itemId,
                "in_set",
                "clothing_set",
                id,
                source,
              );
          }
        } else if (route === "/api/rooms")
          for (const room of entries(body.catalog?.rooms))
            put("room", room.id, room);
        else if (route === "/api/stash/sets")
          for (const set of entries(body.sets)) {
            const id = put("stash_set", set.setId, set);
            for (const ingredient of entries(set.ingredients)) {
              const ingredientId = put(
                "stash_ingredient",
                set.setId + ":" + ingredient.ingredientId,
                { ...ingredient, setId: set.setId },
              );
              if (id && ingredientId)
                this.link(
                  "stash_ingredient",
                  ingredientId,
                  "in_set",
                  "stash_set",
                  id,
                  source,
                );
            }
          }
        else if (route === "/api/bank/packages")
          for (const cat of entries(body.categories))
            for (const pack of entries(cat.packages))
              put("bank_package", pack.id, { ...pack, currency: cat.currency });
        else if (route === "/api/player/customization/options")
          put("customization", "options", body);
        else if (route === "/api/achievements")
          for (const cat of entries(body.categories))
            put("achievement_category", cat.category ?? cat.key ?? cat.id, cat);
        else if (/^\/api\/achievements\//.test(route))
          for (const a of entries(body.achievements))
            put("achievement", a.key ?? a.achievementKey ?? a.id, {
              ...a,
              category: body.category ?? last,
            });
        else if (/^\/api\/quests\//.test(route))
          for (const q of entries(body.quests))
            put("quest", last + ":" + (q.id ?? q.questId ?? q.taskId), {
              ...q,
              section: Number(last),
            });
        else if (route.startsWith("/api/weapons/"))
          put("weapon", body.weapon?.id ?? last, body.weapon ?? body);
        else if (route.startsWith("/api/pets/"))
          put("pet", body.pet?.id ?? last, body.pet ?? body);
        else if (route.startsWith("/api/ornaments/")) {
          if (segments[3] === "zones") {
            const id = put("ornament_zone", body.zoneId ?? last, {
              ...body,
              id: body.zoneId ?? last,
            });
            for (const v of entries(body.items)) {
              const e = put("ornament_element", v.id ?? v.elementId, v);
              if (v.setId != null) {
                const setId = put("ornament_set", v.setId, {
                  id: v.setId,
                  name: v.setName,
                  description: v.setDescription,
                  logo: v.setLogo,
                });
                if (e && setId)
                  this.link(
                    "ornament_element",
                    e,
                    "in_set",
                    "ornament_set",
                    setId,
                    source,
                  );
              }
              if (id && e)
                this.link(
                  "ornament_element",
                  e,
                  "in_zone",
                  "ornament_zone",
                  id,
                  source,
                );
            }
          } else if (last === "zones") {
            for (const value of entries(body.items)) {
              const element = put(
                "ornament_element",
                value.elementId ?? value.id,
                value,
              );
              const zone = put("ornament_zone", value.zoneId, {
                zoneId: value.zoneId,
              });
              if (element && zone)
                this.link(
                  "ornament_element",
                  element,
                  "in_zone",
                  "ornament_zone",
                  zone,
                  source,
                );
              const set = this.db
                .prepare(
                  "SELECT id FROM entities WHERE kind='ornament_set' AND api_id=?",
                )
                .get(String(value.setId));
              if (element && set)
                this.link(
                  "ornament_element",
                  element,
                  "in_set",
                  "ornament_set",
                  set.id,
                  source,
                );
            }
            for (const zone of entries(body.zones ?? body)) {
              const value = typeof zone === "number" ? { zoneId: zone } : zone;
              put("ornament_zone", value.zoneId ?? value.id, value);
            }
          } else {
            const set = body.set ?? body;
            const setId = put("ornament_set", set.id ?? set.setId ?? last, set);
            for (const value of entries(
              set.items ?? set.elements ?? set.ornaments,
            )) {
              const id = put("ornament_element", value.id ?? value.elementId, {
                ...value,
                setId: set.id ?? set.setId ?? Number(last),
              });
              if (id && setId)
                this.link(
                  "ornament_element",
                  id,
                  "in_set",
                  "ornament_set",
                  setId,
                  source,
                );
            }
          }
        } else if (
          route === "/api/mutagens/state" ||
          route === "/api/mutagens/exchange/state"
        ) {
          const type =
            body.type ??
            new URL("http://localhost" + path).searchParams.get("type");
          put("mutagen_type", type, { type });
          for (const m of entries(body.mutagens))
            put("mutagen", m.id ?? m.mutagenId, m);
          if (body.ornamentSet) {
            const set = body.ornamentSet;
            const setId = put("ornament_set", set.id, set);
            for (const ornament of entries(set.ornaments)) {
              const id = put("ornament_element", ornament.id, {
                ...ornament,
                setId: set.id,
              });
              if (id && setId)
                this.link(
                  "ornament_element",
                  id,
                  "in_set",
                  "ornament_set",
                  setId,
                  source,
                );
            }
          }
          const kind = route.includes("/exchange/")
            ? "mutagen_exchange_recipe"
            : "mutagen_recipe";
          for (const recipe of entries(body.recipes))
            for (const member of ["first", "second", "result"]) {
              const m = recipe[member];
              if (m?.mutagenId != null) put("mutagen", m.mutagenId, m);
            }
          for (const r of entries(body.recipes))
            put(kind, (type ?? "") + ":" + (r.id ?? r.recipeId), {
              ...r,
              type,
            });
        }
      }
      this.db
        .prepare("INSERT OR REPLACE INTO captures VALUES (?,?,?,?,?)")
        .run(
          workId == null ? path : path + "?workId=" + workId,
          status,
          count,
          new Date().toISOString(),
          status !== 200
            ? "Response body not retained."
            : count === 0
              ? "No reference records identified; inspect coverage."
              : null,
        );
      this.db.exec("COMMIT");
      this.report();
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  report() {
    const report = {
      database: "local-data/madhouse.sqlite",
      updatedAt: new Date().toISOString(),
      privacy:
        "Reference fields only. Credentials and personal state excluded.",
      counts: this.db
        .prepare(
          "SELECT kind,count(*) records FROM entities GROUP BY kind ORDER BY kind",
        )
        .all(),
      captures: this.db.prepare("SELECT * FROM captures ORDER BY path").all(),
      unresolvedLinks: this.db
        .prepare("SELECT count(*) count FROM unresolved_links")
        .get().count,
    };
    return report;
  }
  close() {
    this.db.close();
  }
}
export { referenceRecord, catalogueRoute, project, projections };
