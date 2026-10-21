import { timingSafeEqual } from "node:crypto";
import { synchronizeRaids } from "./raid-synchronizer.mjs";

const HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: HEADERS });
}

function matchesSecret(supplied, expected) {
  if (
    typeof supplied !== "string" ||
    typeof expected !== "string" ||
    expected.length < 16 ||
    expected.length > 256 ||
    !/^[A-Za-z0-9_-]+$/.test(expected)
  )
    return false;
  const suppliedBytes = Buffer.from(supplied);
  const expectedBytes = Buffer.from(expected);
  return (
    suppliedBytes.length === expectedBytes.length &&
    timingSafeEqual(suppliedBytes, expectedBytes)
  );
}

export function createRaidSyncApi({
  sync = synchronizeRaids,
  secret = () => process.env.CRON_SECRET,
} = {}) {
  return async function handleRaidSyncRequest(request) {
    const url = new URL(request.url);
    if (url.search || url.hash) return json(400, { error: "invalid_request" });
    if (url.pathname !== "/api/telegram/raids-sync")
      return json(404, { error: "not_found" });
    if (request.method !== "GET")
      return json(405, { error: "method_not_allowed" });
    if (
      !matchesSecret(
        request.headers.get("authorization")?.replace(/^Bearer /, ""),
        secret(),
      )
    )
      return json(401, { error: "unauthorized" });
    try {
      return json(200, await sync());
    } catch {
      return json(503, { error: "raid_schedule_sync_unavailable" });
    }
  };
}

export const raidSyncApi = createRaidSyncApi();
