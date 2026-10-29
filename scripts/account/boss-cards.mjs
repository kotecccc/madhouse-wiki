import { createHash } from "node:crypto";
import {
  summarizeBossCollection,
  summarizeBossOwnedDrops,
} from "../../src/features/bosses/collection/boss-collection.js";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store, max-age=0",
      "X-Content-Type-Options": "nosniff",
    },
  });

const bossId = (boss) => {
  const id = Number(boss?.numericId ?? boss?.apiId ?? boss?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
};

export function createBossCardsHttp({
  identify,
  snapshots,
  getCatalogue,
  canonicalCredential = (value) => value,
  origin = null,
}) {
  const pending = new Map();

  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/automation/bosses")
      return json({ error: "unknown_automation_route" }, 404);
    if (request.method !== "GET")
      return json({ error: "method_not_allowed" }, 405);
    if (
      request.headers.get("origin") &&
      request.headers.get("origin") !== (origin || url.origin)
    )
      return json({ error: "origin_rejected" }, 403);

    if (url.search) return json({ error: "invalid_query" }, 400);
    let refreshId = null;
    if (request.headers.has("X-Madhouse-Refresh-Boss")) {
      const rawId = request.headers.get("X-Madhouse-Refresh-Boss");
      if (
        !/^\d+$/.test(rawId || "") ||
        !Number.isSafeInteger(Number(rawId)) ||
        Number(rawId) <= 0
      )
        return json({ error: "invalid_query" }, 400);
      refreshId = Number(rawId);
    }

    const authorization = request.headers.get("authorization");
    let identity;
    try {
      identity = await identify(authorization);
    } catch (error) {
      const status =
        Number.isInteger(error?.status) &&
        error.status >= 400 &&
        error.status < 600
          ? error.status
          : 401;
      return json(
        {
          error:
            status === 401 ? "game_session_required" : "boss_data_unavailable",
        },
        status,
      );
    }

    let bosses;
    try {
      bosses = getCatalogue()?.bosses || [];
    } catch {
      return json({ error: "boss_data_unavailable" }, 503);
    }
    if (
      refreshId !== null &&
      !bosses.some((boss) => bossId(boss) === refreshId)
    )
      return json({ error: "unknown_boss" }, 404);

    const credential = identity?.credential || authorization || "";
    const key = `${createHash("sha256").update(credential).digest("hex")}:${refreshId ?? "saved"}`;
    if (pending.has(key)) return (await pending.get(key)).clone();
    const task = (async () => {
      const savedCredential = canonicalCredential(credential);
      const responses = snapshots.inventory(savedCredential).sections;
      return json({
        bosses: bosses.map((boss) => ({
          ...boss,
          collection: summarizeBossCollection(boss, responses),
          ownedDrops: summarizeBossOwnedDrops(boss, responses),
        })),
        gameHealth: snapshots.health(savedCredential),
      });
    })();
    pending.set(key, task);
    try {
      return (await task).clone();
    } finally {
      if (pending.get(key) === task) pending.delete(key);
    }
  };
}
