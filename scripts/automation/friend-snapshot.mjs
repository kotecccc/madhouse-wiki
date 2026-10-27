import { normalizeFriend } from "../../src/features/friends/friends.js";

// Commit only a complete, bounded traversal. This snapshot is presentation
// data and is never consulted to authorize a game mutation.
export async function readFriendSnapshot({ fetcher, credential }) {
  const items = new Map(),
    seen = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await fetcher(
      `https://cargohustle.online/api/friends?${query}`,
      {
        headers: { Authorization: credential, Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) {
      const error = Object.assign(new Error("friends_unavailable"), {
        status: response.status,
      });
      const header = response.headers.get("Retry-After");
      if (header) {
        const delay = /^\d+$/.test(header)
          ? Number(header) * 1000
          : Date.parse(header) - Date.now();
        if (Number.isFinite(delay) && delay >= 0) error.retryAfterMs = delay;
      }
      throw error;
    }
    const body = await response.json();
    if (
      !Array.isArray(body?.items) ||
      !Object.hasOwn(body, "nextCursor") ||
      body.partial ||
      body.success === false ||
      body.error
    )
      throw new Error("friends_incomplete");
    for (const row of body.items) {
      const friend = normalizeFriend(row?.player);
      friend.nickname = friend.nickname.slice(0, 100);
      friend.username = friend.username.slice(0, 100);
      if (friend.avatarUrl?.length > 2048) friend.avatarUrl = null;
      items.set(friend.playerId, friend);
      if (items.size > 10000) throw new Error("friends_capacity_exceeded");
    }
    const next = body.nextCursor;
    if (next == null || next === "") {
      const result = [...items.values()];
      if (Buffer.byteLength(JSON.stringify(result)) > 512 * 1024)
        throw new Error("friends_capacity_exceeded");
      return result;
    }
    if (typeof next !== "string" || next.length > 1024 || seen.has(next))
      throw new Error("friends_incomplete");
    seen.add(next);
    cursor = next;
  }
  throw new Error("friends_incomplete");
}
