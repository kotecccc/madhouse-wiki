import { catalogueRoute } from "./projection.mjs";

const origin = "https://cargohustle.online";
// Credentials live only in this bounded job's closure, are never returned, and are
// released on completion. There is no arbitrary URL or request-body interface.
export async function importCatalogue(store, authorization, fetcher = fetch) {
  const deadline = Date.now() + 15 * 60 * 1000;
  let stopped = false;
  let lastRequestAt = 0;
  const request = async (path, workId) => {
    if (stopped || Date.now() > deadline) return null;
    const captureKey = workId == null ? path : path + "?workId=" + workId;
    const previous = store.db
      .prepare("SELECT status FROM captures WHERE path=?")
      .get(captureKey)?.status;
    if (path !== "/api/floors" && [200, 409].includes(previous)) return null;
    const wait = Math.max(0, 1100 - (Date.now() - lastRequestAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
    const method = workId == null ? "GET" : "POST";
    if (
      method === "GET"
        ? !catalogueRoute(path)
        : path !== "/api/works/open" ||
          !Number.isSafeInteger(workId) ||
          workId < 1
    )
      throw new Error("Import route rejected");
    try {
      const response = await fetcher(origin + path, {
        method,
        headers: {
          Authorization: authorization,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ workId, locale: "ru" }) }
          : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
      if ([401, 429].includes(response.status)) stopped = true;
      const body = response.ok ? await response.json() : null;
      store.capture(path, response.status, body, method, workId);
      return response.ok ? body : null;
    } catch {
      // Never include request, response, or exception text in logs.
      store.capture(path, 0, null, method, workId);
      return null;
    }
  };
  try {
    const floors = await request("/api/floors");
    if (!Array.isArray(floors)) return;
    for (const floor of floors)
      if (typeof floor.code === "string" && /^[A-O$]$/.test(floor.code))
        await request(`/api/floors/${encodeURIComponent(floor.code)}/info`);
    const discovered = store.db
      .prepare("SELECT * FROM route_discovery ORDER BY kind,id")
      .all();
    for (const r of discovered) {
      if (stopped) break;
      const path =
        r.kind === "work"
          ? "/api/works/open"
          : `/api/${r.kind === "boss" ? "bosses" : "businesses"}/${r.id}`;
      await request(path, r.kind === "work" ? r.id : undefined);
      const entity = store.db
        .prepare("SELECT id FROM entities WHERE kind=? AND api_id=?")
        .get(r.kind, String(r.id));
      const department = store.db
        .prepare("SELECT id FROM entities WHERE kind='department' AND api_id=?")
        .get(r.department_code);
      // Client routing evidence identifies membership only; entity definitions come from API.
      if (entity && department) {
        const source = "client:activity-routing";
        store.source(
          source,
          "public-client",
          "activity routing table",
          "client-routing-only",
          "Entity definitions are independently fetched from API.",
        );
        store.link(
          r.kind,
          entity.id,
          "in_department",
          "department",
          department.id,
          source,
        );
      }
    }
    for (const path of [
      "/api/clothing",
      "/api/rooms",
      "/api/stash/sets",
      "/api/player/customization/options",
      "/api/achievements",
    ])
      await request(path);
    // Bank offers depend on the account's stage; omit them from a global catalogue.
    for (const category of [
      "combat",
      "boss",
      "tasks",
      "stash",
      "mutagen",
      "clothing",
      "weapon",
      "pets",
      "bag",
      "general",
      "floor",
    ])
      await request(`/api/achievements/${category}`);
    for (const type of ["I", "A", "F", "X", "S", "Z", "W"]) {
      await request(`/api/mutagens/state?type=${type}`);
      if (type !== "W")
        await request(`/api/mutagens/exchange/state?type=${type}`);
      else
        for (let level = 8; level <= 20; level++)
          await request(`/api/mutagens/exchange/state?type=W&level=${level}`);
    }
    // These catalogue keys identify weapon/pet definitions; never read ownership lists.
    const keys = store.db
      .prepare(
        "SELECT json_extract(data_json,'$.key') key FROM entities WHERE kind='achievement'",
      )
      .all();
    const routes = new Set();
    for (const { key } of keys) {
      const match =
        typeof key === "string" && key.match(/^(weapon|pet):(\d+):/);
      if (match)
        routes.add(
          `/api/${match[1] === "pet" ? "pets" : "weapons"}/${Number(match[2])}`,
        );
    }
    for (const path of routes) await request(path);
    // The public client has eight quest-chain buttons (aTO, section index + 1).
    for (let section = 1; section <= 8; section++)
      await request(`/api/quests/${section}`);
    const followed = new Set();
    while (!stopped && Date.now() < deadline) {
      const paths = new Set();
      const members = store.db
        .prepare(
          "SELECT json_extract(data_json,'$.zoneId') zoneId,json_extract(data_json,'$.setId') setId FROM entities WHERE kind='ornament_element'",
        )
        .all();
      for (const member of members) {
        if (Number.isSafeInteger(member.zoneId) && member.zoneId > 0)
          paths.add(`/api/ornaments/zones/${member.zoneId}`);
        if (Number.isSafeInteger(member.setId) && member.setId > 0) {
          paths.add(`/api/ornaments/sets/${member.setId}`);
          paths.add(`/api/ornaments/sets/${member.setId}/zones`);
        }
      }
      for (const zone of store.db
        .prepare("SELECT api_id FROM entities WHERE kind='ornament_zone'")
        .all()) {
        if (/^\d+$/.test(zone.api_id))
          paths.add(`/api/ornaments/zones/${zone.api_id}`);
      }
      const pending = [...paths].filter((path) => !followed.has(path));
      if (!pending.length) break;
      for (const path of pending) {
        followed.add(path);
        await request(path);
      }
    }
    store.db
      .prepare("INSERT OR REPLACE INTO metadata VALUES (?,?)")
      .run("last_import_finished_at", new Date().toISOString());
  } finally {
    authorization = null;
    store.report();
  }
}
