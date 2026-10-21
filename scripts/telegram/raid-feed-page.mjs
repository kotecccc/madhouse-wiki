// Optional pagination; requests without query parameters retain the legacy feed.
export function parseRaidPageQuery(url) {
  if (url.hash) throw new Error("invalid_request");
  if (!url.search) return null;
  const params = url.searchParams;
  if (
    [...params.keys()].some((key) => !["limit", "before"].includes(key)) ||
    params.getAll("limit").length !== 1 ||
    params.getAll("before").length > 1 ||
    !/^(?:[1-9]|10)$/.test(params.get("limit") || "")
  )
    throw new Error("invalid_request");
  const before = params.get("before");
  if (before !== null && !/^\d{4}-\d{2}-\d{2}:[1-9]\d{0,9}$/.test(before))
    throw new Error("invalid_request");
  return { limit: Number(params.get("limit")), before };
}

export function raidFeedPage(posts, { limit, before }) {
  const sorted = [...posts].sort(
    (a, b) =>
      String(b.raidDate).localeCompare(String(a.raidDate)) ||
      Number(b.sourceMessageId) - Number(a.sourceMessageId),
  );
  const [date, messageId] = before?.split(":") || [];
  const remaining = before
    ? sorted.filter(
        (post) =>
          post.raidDate < date ||
          (post.raidDate === date &&
            Number(post.sourceMessageId) < Number(messageId)),
      )
    : sorted;
  const page = remaining.slice(0, limit);
  const last = page.at(-1);
  return {
    posts: page,
    nextCursor:
      remaining.length > limit && last
        ? `${last.raidDate}:${last.sourceMessageId}`
        : null,
  };
}
