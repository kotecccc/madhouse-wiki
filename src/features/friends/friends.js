const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const number = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
const text = (value) => (typeof value === "string" ? value.trim() : "");

function safeAvatar(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function normalizeFriend(player) {
  if (!positiveId(player?.playerId))
    throw new Error("Не удалось определить друга в ответе игры.");
  const date =
    typeof player.lastSeenAtUtc === "string"
      ? Date.parse(player.lastSeenAtUtc)
      : NaN;
  return {
    playerId: player.playerId,
    nickname: text(player.nickname),
    username: text(player.username).replace(/^@/, ""),
    avatarUrl: safeAvatar(player.avatarUrl),
    level: number(player.level),
    experience: number(player.experience),
    madness: number(player.stats?.madness),
    aggression: number(player.stats?.aggression),
    rage: number(player.stats?.rage),
    isOnline: typeof player.isOnline === "boolean" ? player.isOnline : null,
    lastSeenAt: Number.isFinite(date) ? date : null,
  };
}

export async function loadFriendPage(get, cursor = null, signal) {
  signal?.throwIfAborted();
  const query = new URLSearchParams({ limit: "20" });
  if (cursor) query.set("cursor", cursor);
  const result = await get(`/api/friends?${query}`, {
    fresh: true,
    revalidate: false,
    signal,
  });
  signal?.throwIfAborted();
  if (
    !Array.isArray(result?.items) ||
    !Object.hasOwn(result, "nextCursor") ||
    result.partial ||
    result.success === false ||
    result.error ||
    (result.nextCursor != null &&
      result.nextCursor !== "" &&
      (typeof result.nextCursor !== "string" ||
        result.nextCursor.length > 1024 ||
        result.nextCursor === cursor))
  )
    throw new Error("Список друзей получен не полностью.");
  return {
    items: result.items.map((item) => normalizeFriend(item?.player)),
    nextCursor: result.nextCursor || null,
  };
}

export async function loadFriends(get, signal) {
  const friends = new Map();
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    signal?.throwIfAborted();
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const result = await get(`/api/friends?${query}`, { fresh: true });
    signal?.throwIfAborted();
    if (
      !Array.isArray(result?.items) ||
      !Object.hasOwn(result, "nextCursor") ||
      result.partial ||
      result.success === false ||
      result.error
    )
      throw new Error("Список друзей получен не полностью.");
    for (const item of result.items) {
      const friend = normalizeFriend(item?.player);
      friends.set(friend.playerId, friend);
    }
    const next = result.nextCursor;
    if (next == null || next === "") return [...friends.values()];
    if (typeof next !== "string" || seen.has(next))
      throw new Error("Не удалось загрузить все страницы друзей.");
    seen.add(next);
    cursor = next;
  }
  throw new Error("Превышено ограничение страниц друзей.");
}

export function selectFriends(
  friends,
  { search = "", filter = "all", sort = "name", buddyFriends = [] } = {},
) {
  const query = search.trim().toLocaleLowerCase("ru").replace(/^@/, "");
  const name = (friend) =>
    friend.nickname || friend.username || `Игрок №${friend.playerId}`;
  const selected = friends.filter((friend) => {
    if (filter === "buddy" && !buddyFriends.includes(friend.playerId))
      return false;
    if (filter === "online" && friend.isOnline !== true) return false;
    if (filter === "offline" && friend.isOnline !== false) return false;
    return (
      !query ||
      [friend.nickname, friend.username, String(friend.playerId)].some(
        (value) => value.toLocaleLowerCase("ru").includes(query),
      )
    );
  });
  return selected.sort((a, b) => {
    if (sort === "priority") {
      const left = buddyFriends.indexOf(a.playerId);
      const right = buddyFriends.indexOf(b.playerId);
      const leftRank = left < 0 ? Infinity : left;
      const rightRank = right < 0 ? Infinity : right;
      if (leftRank !== rightRank) return leftRank - rightRank;
    } else if (sort === "online") {
      const rank = (friend) =>
        friend.isOnline === true ? 0 : friend.isOnline === false ? 1 : 2;
      const difference = rank(a) - rank(b);
      if (difference) return difference;
      if (a.lastSeenAt == null && b.lastSeenAt != null) return 1;
      if (b.lastSeenAt == null && a.lastSeenAt != null) return -1;
      if (
        a.lastSeenAt != null &&
        b.lastSeenAt != null &&
        a.lastSeenAt !== b.lastSeenAt
      )
        return b.lastSeenAt - a.lastSeenAt;
    } else if (sort !== "name") {
      const left = a[sort],
        right = b[sort];
      if (left == null && right != null) return 1;
      if (right == null && left != null) return -1;
      if (left != null && right != null && left !== right) return right - left;
    }
    return name(a).localeCompare(name(b), "ru") || a.playerId - b.playerId;
  });
}
