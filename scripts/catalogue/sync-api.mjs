import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CatalogueStore } from "./store.mjs";
import { readKnowledgeBase } from "./query.mjs";

const GAME_ORIGIN = "https://cargohustle.online";
const BOSS_ID = /^[1-9][0-9]{0,8}$/;
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

export function createCatalogueSyncApi({
  root,
  storeBlob,
  fetcher = fetch,
  onCatalogue,
}) {
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
    return response.status === 200 &&
      Array.isArray(response.data) &&
      response.data.some(
        (floor) => floor.code === code && floor.isAvailable === true,
      )
      ? response.data
      : null;
  }

  async function getCatalogue(request) {
    const bossId = new URL(request.url).searchParams.get("bossId");
    if (bossId !== null && !BOSS_ID.test(bossId))
      return json({ error: "invalid_request" }, 400);
    let downloaded;
    let stage = "read_store";
    try {
      downloaded = await storeBlob.download();
      const file = downloaded?.file || join(root, "local-data/madhouse.sqlite");
      stage = "read_model";
      const kb = readKnowledgeBase(root, file);
      onCatalogue?.(kb);
      if (bossId !== null) {
        const boss = kb.bosses.find((boss) => String(boss.apiId) === bossId);
        return boss ? json({ boss }) : json({ error: "boss_not_found" }, 404);
      }
      stage = "open_database";
      const db = new DatabaseSync(file, { readOnly: true });
      stage = "read_completeness";
      let completeFloors;
      let pendingRoutes;
      let missingFloorInfo;
      try {
        completeFloors = db
          .prepare(
            "SELECT json_extract(f.data_json,'$.code') AS code FROM entities f WHERE f.kind='floor' AND EXISTS(SELECT 1 FROM captures c WHERE c.path='/api/floors/'||json_extract(f.data_json,'$.code')||'/info' AND c.status=200 AND c.entity_count>0) AND NOT EXISTS(SELECT 1 FROM route_discovery r LEFT JOIN captures c ON c.path=CASE WHEN r.kind='work' THEN '/api/works/open?workId='||r.id ELSE '/api/'||CASE WHEN r.kind='boss' THEN 'bosses' ELSE 'businesses' END||'/'||r.id END WHERE r.floor_code=json_extract(f.data_json,'$.code') AND (coalesce(c.status,0)<>200 OR coalesce(c.entity_count,0)=0))",
          )
          .all()
          .map((row) => row.code);
        pendingRoutes = db
          .prepare(
            "SELECT r.floor_code AS floorCode, r.department_code AS departmentCode, r.kind, r.id FROM route_discovery r LEFT JOIN captures c ON c.path=CASE WHEN r.kind='work' THEN '/api/works/open?workId='||r.id ELSE '/api/'||CASE WHEN r.kind='boss' THEN 'bosses' ELSE 'businesses' END||'/'||r.id END WHERE r.kind IN ('work','boss','business') AND (coalesce(c.status,0)<>200 OR coalesce(c.entity_count,0)=0) ORDER BY r.floor_code,r.department_code,r.kind,r.id",
          )
          .all();
        missingFloorInfo = [..."ABCDEFGHIJKLMNO$"].filter((code) => {
          const capture = db
            .prepare("SELECT status,entity_count FROM captures WHERE path=?")
            .get(`/api/floors/${code}/info`);
          return capture?.status !== 200 || !capture.entity_count;
        });
      } finally {
        db.close();
      }
      return json({
        ...publicData(kb),
        completeFloors,
        pendingRoutes,
        missingFloorInfo,
      });
    } catch {
      return json({ error: "catalogue_unavailable", stage }, 503);
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
      !FLOOR_CODES.test(body.floorCode || "") ||
      !(
        (Object.keys(body).length === 1 && Object.hasOwn(body, "floorCode")) ||
        (Object.keys(body).length === 2 && body.floorInfo === true) ||
        ([2, 4].includes(Object.keys(body).length) &&
          typeof body.departmentCode === "string" &&
          new RegExp(
            `^${body.floorCode === "$" ? "\\$" : body.floorCode}[1-9][0-9]*$`,
          ).test(body.departmentCode) &&
          (Object.keys(body).length === 2 ||
            (["work", "boss", "business"].includes(body.kind) &&
              Number.isSafeInteger(body.id) &&
              body.id > 0)))
      )
    )
      return json({ error: "invalid_request" }, 400);
    const code = body.floorCode;
    const departmentCode = body.departmentCode;
    const selectedRoute = body.kind ? { kind: body.kind, id: body.id } : null;
    let stage = "verify_floor";
    try {
      const floors = await authorizedFloor(code, authorization);
      if (!floors) return json({ error: "floor_unavailable" }, 403);
      stage = "read_store";
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
      stage = "open_database";
      const store = new CatalogueStore(root, database);
      store.capture("/api/floors", 200, floors);
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
        stage = "fetch_game_definition";
        const result = await fetchJson(
          path,
          authorization,
          method,
          method === "POST" ? { workId, locale: "ru" } : undefined,
        );
        if (
          method === "POST" &&
          result.status === 200 &&
          Number(result.data?.workId) !== workId
        ) {
          store.capture(path, 502, null, method, workId);
          return;
        }
        if (
          selectedRoute &&
          method === "GET" &&
          path !== `/api/floors/${code}/info` &&
          result.status === 200 &&
          Number(result.data?.id) !== selectedRoute.id
        ) {
          store.capture(path, 502, null);
          return;
        }
        if ([401, 429].includes(result.status)) stopped = true;
        store.capture(path, result.status, result.data, method, workId);
      };
      try {
        let unlockedDepartments;
        {
          const result = await fetchJson(
            `/api/floors/${code}/info`,
            authorization,
          );
          if (result.status !== 200 || !Array.isArray(result.data?.departments))
            return json({ error: "department_unavailable" }, 403);
          unlockedDepartments = new Set(
            result.data.departments
              .filter((department) => department.unlocked === true)
              .map((department) => department.blockCode),
          );
          if (
            departmentCode &&
            !result.data.departments.some(
              (department) =>
                department.blockCode === departmentCode &&
                department.unlocked === true,
            )
          )
            return json({ error: "department_unavailable" }, 403);
          store.capture(`/api/floors/${code}/info`, 200, result.data);
        }
        stage = "load_floor_routes";
        const routes = store.db
          .prepare(
            "SELECT kind,id,department_code FROM route_discovery WHERE floor_code=? ORDER BY kind,id",
          )
          .all(code);
        if (
          selectedRoute &&
          !routes.some(
            (route) =>
              route.department_code === departmentCode &&
              route.kind === selectedRoute.kind &&
              route.id === selectedRoute.id,
          )
        )
          return json({ error: "unknown_route" }, 404);
        for (const route of routes) {
          if (stopped) break;
          if (body.floorInfo || !unlockedDepartments.has(route.department_code))
            continue;
          if (
            departmentCode &&
            (route.department_code !== departmentCode ||
              (selectedRoute
                ? route.kind !== selectedRoute.kind ||
                  route.id !== selectedRoute.id
                : route.kind !== "work"))
          )
            continue;
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
        stage = "persist_catalogue";
        if (!downloaded?.mutable)
          await storeBlob.upload(database, downloaded?.etag ?? null);
        stage = "read_model";
        const model = readKnowledgeBase(root, database);
        onCatalogue?.(model);
        return json({
          floorCode: code,
          ...(departmentCode || body.floorInfo
            ? { catalogue: publicData(model) }
            : {}),
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
      return json({ error: "catalogue_sync_unavailable", stage }, 503);
    }
  }

  async function syncBoss(request, bossId) {
    const authorization = safeAuthorization(request);
    if (!authorization) return json({ error: "unauthorized" }, 401);
    if (!BOSS_ID.test(String(bossId)))
      return json({ error: "invalid_request" }, 400);
    const id = String(bossId);
    let downloaded;
    let directory;
    let store;
    let stage = "read_store";
    try {
      downloaded = await storeBlob.download();
      directory = downloaded?.mutable
        ? null
        : await mkdtemp(join(tmpdir(), "madhouse-boss-reference-"));
      const database = downloaded?.mutable
        ? downloaded.file
        : join(directory, "madhouse.sqlite");
      if (!downloaded?.mutable)
        await copyFile(
          downloaded?.file || join(root, "local-data/madhouse.sqlite"),
          database,
        );
      stage = "open_database";
      store = new CatalogueStore(root, database);
      const findBoss = () =>
        readKnowledgeBase(root, database).bosses.find(
          (boss) => String(boss.apiId) === id,
        );
      let boss = findBoss();
      if (!boss) return json({ error: "boss_not_found" }, 404);
      if (boss.rewardPreviewCaptured) return json({ boss, cached: true });
      stage = "fetch_boss_reference";
      const result = await fetchJson(`/api/bosses/${id}`, authorization);
      if (result.status !== 200)
        return json(
          {
            error: "boss_reference_unavailable",
            upstreamStatus: result.status,
          },
          [401, 403, 429].includes(result.status) ? result.status : 502,
        );
      if (!result.data || String(result.data.id) !== id)
        return json({ error: "invalid_boss_reference" }, 502);
      store.capture(`/api/bosses/${id}`, 200, result.data);
      // Successful lookup, including an explicit missing preview, is durable.
      // Do not repeat a game API request because all currencies happen to be null.
      store.db
        .prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)")
        .run(`boss_reward_preview:v1:${id}`, "1");
      store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      boss = findBoss();
      store.close();
      store = null;
      stage = "persist_catalogue";
      if (!downloaded?.mutable)
        await storeBlob.upload(database, downloaded?.etag ?? null);
      return json({ boss, cached: false });
    } catch {
      return json({ error: "boss_reference_sync_unavailable", stage }, 503);
    } finally {
      store?.close();
      if (directory) await rm(directory, { recursive: true, force: true });
      if (downloaded?.directory)
        await rm(downloaded.directory, { recursive: true, force: true });
    }
  }
  // Serialize catalogue writers in this runtime so concurrent openings share the
  // persistent completion check and cannot overwrite each other's local changes.
  let writeTail = Promise.resolve();
  return async (request) => {
    if (request.method === "GET") return getCatalogue(request);
    if (request.method === "POST") {
      const task = writeTail.then(async () => {
        let body;
        try {
          body = await request.clone().json();
        } catch {
          return json({ error: "invalid_request" }, 400);
        }
        if (
          body &&
          Object.keys(body).length === 1 &&
          Object.hasOwn(body, "bossId")
        )
          return syncBoss(request, body.bossId);
        return syncFloor(request);
      });
      writeTail = task.catch(() => {});
      return task;
    }
    return json({ error: "method_not_allowed" }, 405);
  };
}
