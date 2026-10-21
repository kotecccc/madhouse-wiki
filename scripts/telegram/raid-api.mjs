import { createRaidBlobStore } from "./raid-blob-store.mjs";

const MAX_PUBLIC_POSTS = 30;
const PUBLIC_HEADERS = {
  "Cache-Control": "public, max-age=0, s-maxage=60, stale-while-revalidate=300",
  "CDN-Cache-Control": "public, max-age=60",
  "Vercel-CDN-Cache-Control": "public, max-age=60",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function json(status, body, headers = PRIVATE_HEADERS) {
  return new Response(JSON.stringify(body), { status, headers });
}

function publicPost(post) {
  return {
    sourceMessageId: post.sourceMessageId,
    sourceTitle: post.sourceTitle,
    raidDate: post.raidDate,
    raidDateLabel: post.raidDateLabel,
    timeZone: post.timeZone,
    publishedAt: post.publishedAt,
    editedAt: post.editedAt,
    sourceUrl: post.sourceUrl,
    raids: post.raids,
  };
}

export function createRaidApi({ store = createRaidBlobStore() } = {}) {
  return async function handleRaidRequest(request) {
    const url = new URL(request.url);
    if (url.search || url.hash) return json(400, { error: "invalid_request" });
    if (url.pathname !== "/api/raids") return json(404, { error: "not_found" });
    if (request.method !== "GET")
      return json(405, { error: "method_not_allowed" });
    try {
      const posts = await store.readRecent(MAX_PUBLIC_POSTS);
      return json(200, { posts: posts.map(publicPost) }, PUBLIC_HEADERS);
    } catch {
      return json(503, { error: "raid_schedule_unavailable" });
    }
  };
}

export const raidApi = createRaidApi();
