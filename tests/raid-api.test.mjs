import assert from "node:assert/strict";
import test from "node:test";
import { createRaidApi } from "../scripts/telegram/raid-api.mjs";

const posts = [
  { sourceMessageId: "73", raidDate: "2026-10-21", raids: [] },
  { sourceMessageId: "72", raidDate: "2026-10-20", raids: [] },
  { sourceMessageId: "71", raidDate: "2026-10-20", raids: [] },
  { sourceMessageId: "70", raidDate: "2026-10-19", raids: [] },
];
function setup() {
  const limits = [];
  const data = [...posts];
  const api = createRaidApi({
    store: {
      readRecent: async (limit) => {
        limits.push(limit);
        return data.slice(0, limit);
      },
    },
  });
  return {
    limits,
    data,
    get: (query = "") =>
      api(new Request(`https://wiki.invalid/api/raids${query}`)),
  };
}

test("legacy feed keeps its response shape and thirty-post limit", async () => {
  const { get, limits } = setup();
  const response = await get();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const result = await response.json();
  assert.deepEqual(Object.keys(result), ["posts"]);
  assert.equal(result.posts.length, 4);
  assert.deepEqual(limits, [30]);
});

test("pages return a stable cursor without repeating the latest schedule", async () => {
  const { get } = setup();
  const first = await (await get("?limit=1")).json();
  assert.deepEqual(
    first.posts.map((p) => p.sourceMessageId),
    ["73"],
  );
  const second = await (
    await get(`?limit=2&before=${encodeURIComponent(first.nextCursor)}`)
  ).json();
  assert.deepEqual(
    second.posts.map((p) => p.sourceMessageId),
    ["72", "71"],
  );
  const last = await (
    await get(`?limit=2&before=${encodeURIComponent(second.nextCursor)}`)
  ).json();
  assert.deepEqual(
    last.posts.map((p) => p.sourceMessageId),
    ["70"],
  );
  assert.equal(last.nextCursor, null);
});

test("deleting the boundary schedule does not invalidate its cursor", async () => {
  const { get, data } = setup();
  const first = await (await get("?limit=1")).json();
  data.shift();
  const next = await (
    await get(`?limit=1&before=${encodeURIComponent(first.nextCursor)}`)
  ).json();
  assert.equal(next.posts[0].sourceMessageId, "72");
});

test("invalid pagination never reaches storage", async () => {
  const { get, limits } = setup();
  for (const query of [
    "?limit=0",
    "?limit=11",
    "?limit=1&limit=2",
    "?before=x",
    "?limit=1&before=x",
    "?limit=1&other=x",
  ])
    assert.equal((await get(query)).status, 400, query);
  assert.deepEqual(limits, []);
});
