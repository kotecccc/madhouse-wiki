import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CatalogueStore } from "./store.mjs";
import { readKnowledgeBase } from "./query.mjs";

const GAME_ORIGIN = "https://cargohustle.online";
const FLOOR_CODES = /^[A-O$]$/;
const privateHeaders = { "Cache-Control": "private, no-store, max-age=0" };
const publicData = (kb) => ({
  schemaVersion: kb.schemaVersion,
  floors: kb.floors,
  departments: kb.departments,
  works: kb.works,
  bosses: kb.bosses,
  businesses: kb.businesses,
  stashSets: kb.stashSets,
  businessUpgrades: kb.businessUpgrades,
});

function json(body, status = 200) {
  return Response.json(body, { status, headers: privateHeaders });
}
function safeAuthorization(request) {
  const value = request.headers.get("authorization") || "";
  return /^Bearer [A-Za-z0-9._~-]{20,4096}$/.test(value) ? value : null;
}

export function createCatalogueSyncApi({ root, storeBlob, fetcher = fetch }) {
  async function fetchJson(path, authorization, method = "GET", body) {
    const response = await fetcher(GAME_ORIGIN + path, {
      method,
      headers: {
        Authorization: authorization,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    return {
      status: response.status,
      data: response.ok ? await response.json() : null,
    };
  }

  async function authorizedFloor(code, authorization) {
    const response = await fetchJson("/api/floors", authorization);
    return (
      response.status === 200 &&
      Array.isArray(response.data) &&
      response.data.some(
        (floor) => floor.code === code && floor.isAvailable === true,
      )
    );
  }

  async function getCatalogue() {
    let downloaded;
    try {
      downloaded = await storeBlob.download();
      if (!downloaded)
        return json({
          schemaVersion: 2,
          floors: [],
          departments: [],
          works: [],
          bosses: [],
          businesses: [],
          stashSets: [],
          businessUpgrades: [],
          completeFloors: [],
        });
      const kb = readKnowledgeBase(process.cwd(), downloaded.file);
      const db = new DatabaseSync(downloaded.file, { readOnly: true });
      const completeFloors = db
        .prepare(
          "SELECT f.code FROM entities f WHERE f.kind='floor' AND EXISTS(SELECT 1 FROM captures c WHERE c.path='/api/floors/'||f.code||'/info' AND c.status=200 AND c.entity_count>0) AND NOT EXISTS(SELECT 1 FROM route_discovery r LEFT JOIN captures c ON c.path=CASE WHEN r.kind='work' THEN '/api/works/open?workId='||r.id ELSE '/api/'||CASE WHEN r.kind='boss' THEN 'bosses' ELSE 'businesses' END||'/'||r.id END WHERE r.floor_code=f.code AND (coalesce(c.status,0)<>200 OR coalesce(c.entity_count,0)=0))",
        )
        .all()
        .map((row) => row.code);
      db.close();
      return json({ ...publicData(kb), completeFloors });
    } catch {
      return json({ error: "catalogue_unavailable" }, 503);
    } finally {
      if (downloaded?.directory)
        await rm(downloaded.directory, { recursive: true, force: true });
    }
  }

  async function syncFloor(request) {
    const authorization = safeAuthorization(request);
    if (!authorization) return json({ error: "unauthorized" }, 401);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    if (
      !body ||
      Object.keys(body).length !== 1 ||
      !FLOOR_CODES.test(body.floorCode || "")
    )
      return json({ error: "invalid_request" }, 400);
    const code = body.floorCode;
    try {
      if (!(await authorizedFloor(code, authorization)))
        return json({ error: "floor_unavailable" }, 403);
      const downloaded = await storeBlob.download();
      const directory = downloaded?.mutable
        ? null
        : await mkdtemp(join(tmpdir(), "madhouse-catalogue-work-"));
      const database = downloaded?.mutable
        ? downloaded.file
        : join(directory, "madhouse.sqlite");
      if (!downloaded?.mutable) {
        if (downloaded) await copyFile(downloaded.file, database);
        else await copyFile(join(root, "local-data/madhouse.sqlite"), database);
        if (downloaded)
          await rm(downloaded.directory, { recursive: true, force: true });
      }
      const store = new CatalogueStore(root, database);
      let lastRequestAt = Date.now();
      let stopped = false;
      const requestRoute = async (path, method = "GET", workId = null) => {
        if (stopped) return;
        const previousCapture = store.db
          .prepare("SELECT status,entity_count FROM captures WHERE path=?")
          .get(workId == null ? path : path + "?workId=" + workId);
        if (previousCapture?.status === 200 && previousCapture.entity_count > 0)
          return;
        const wait = 1100 - (Date.now() - lastRequestAt);
        if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
        lastRequestAt = Date.now();
        const result = await fetchJson(
          path,
          authorization,
          method,
          method === "POST" ? { workId, locale: "ru" } : undefined,
        );
        if ([401, 429].includes(result.status)) stopped = true;
        store.capture(path, result.status, result.data, method, workId);
      };
      try {
        await requestRoute(`/api/floors/${code}/info`);
        const routes = store.db
          .prepare(
            "SELECT kind,id FROM route_discovery WHERE floor_code=? ORDER BY kind,id",
          )
          .all(code);
        for (const route of routes) {
          if (stopped) break;
          const path =
            route.kind === "work"
              ? "/api/works/open"
              : `/api/${route.kind === "boss" ? "bosses" : "businesses"}/${route.id}`;
          await requestRoute(
            path,
            route.kind === "work" ? "POST" : "GET",
            route.kind === "work" ? route.id : null,
          );
        }
        const pending = store.db
          .prepare(
            "SELECT path,status FROM captures WHERE (status<>200 OR entity_count=0) AND path LIKE ?",
          )
          .all(`/api/floors/${code}/%`);
        const pendingIds = store.db
          .prepare(
            "SELECT r.kind,r.id,c.status FROM route_discovery r LEFT JOIN captures c ON c.path=CASE WHEN r.kind='work' THEN '/api/works/open?workId='||r.id ELSE '/api/'||CASE WHEN r.kind='boss' THEN 'bosses' ELSE 'businesses' END||'/'||r.id END WHERE r.floor_code=? AND (coalesce(c.status,0)<>200 OR coalesce(c.entity_count,0)=0)",
          )
          .all(code);
        store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        store.db.close();
        if (!downloaded?.mutable)
          await storeBlob.upload(database, downloaded?.etag ?? null);
        const kb = readKnowledgeBase(root, database);
        return json({
          ...publicData(kb),
          floorCode: code,
          complete: pending.length === 0 && pendingIds.length === 0,
          pendingCount: pending.length + pendingIds.length,
        });
      } finally {
        try {
          store.db.close();
        } catch {
          /* already closed */
        }
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    } catch {
      return json({ error: "catalogue_sync_unavailable" }, 503);
    }
  }

  return async (request) => {
    if (request.method === "GET") return getCatalogue();
    if (request.method === "POST") return syncFloor(request);
    return json({ error: "method_not_allowed" }, 405);
  };
}
