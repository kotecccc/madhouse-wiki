import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAccountSnapshots, isSnapshotPath } from "./snapshots.mjs";
import { createAutomationStateStore } from "../automation/state-store.mjs";

const origin = "https://cargohustle.online";
const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const payload = (response) => response.json();

test("all floor identifiers including the dollar floor use account snapshots", () => {
  assert.equal(isSnapshotPath("/api/floors/%24/info"), true);
  assert.equal(isSnapshotPath("/api/floors/$/info"), true);
  assert.equal(isSnapshotPath("/api/floors/A/info"), true);
  assert.equal(isSnapshotPath("/api/bosses/1/battle"), false);
});

function memoryStore() {
  const snapshots = new Map();
  const values = new Map();
  return {
    readSnapshots: () =>
      [...snapshots.values()].map((value) => structuredClone(value)),
    writeSnapshot: (id, value) =>
      snapshots.set(String(id), structuredClone(value)),
    list: () => [...values].map(([playerId, value]) => ({ playerId, value })),
    write: (playerId, value) => values.set(String(playerId), value),
  };
}

function queueFetcher(steps) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    const step = steps.shift();
    if (typeof step === "function") return step(url, init);
    if (step instanceof Error) throw step;
    if (!step) throw new Error("unexpected fake API request");
    return step;
  };
  return { fetcher, calls };
}

test("encrypted snapshots survive restart and serve stale sections while offline", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "madhouse-snapshot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 1000;
  let store = createAutomationStateStore({ directory });
  const first = queueFetcher([reply({ playerId: 41 }), reply({ coins: 77 })]);
  let snapshots = createAccountSnapshots({
    store,
    fetcher: first.fetcher,
    now: () => now,
  });
  assert.equal(
    (await snapshots.read(`${origin}/api/me`, auth("opaque-a"))).status,
    200,
  );
  assert.deepEqual(
    await payload(
      await snapshots.read(`${origin}/api/me/bag`, auth("opaque-a")),
    ),
    { coins: 77 },
  );
  store.close();

  const databaseText = readFileSync(
    join(directory, "automation.sqlite"),
  ).toString("utf8");
  assert.equal(databaseText.includes("opaque-a"), false);
  store = createAutomationStateStore({ directory });
  t.after(() => store.close());
  now += 1;
  const offline = queueFetcher([reply({ error: "down" }, 503)]);
  snapshots = createAccountSnapshots({
    store,
    fetcher: offline.fetcher,
    now: () => now,
    ttl: 0,
    cooldown: 5000,
  });
  const result = await snapshots.read(`${origin}/api/me/bag`, auth("opaque-a"));
  assert.deepEqual(await payload(result), { coins: 77 });
  assert.equal(result.headers.get("X-Madhouse-Snapshot"), "stale");
});

test("identity response, not forged bearer claims, assigns isolated accounts", async () => {
  const queue = queueFetcher([
    reply({ playerId: 101 }),
    reply({ name: "one" }),
    reply({ playerId: 202 }),
    reply({ name: "two" }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
  });
  await snapshots.read(`${origin}/api/me`, auth("token.playerId-202"));
  await snapshots.read(`${origin}/api/me/bag`, auth("token.playerId-202"));
  await snapshots.read(`${origin}/api/me`, auth("token.playerId-101"));
  await snapshots.read(`${origin}/api/me/bag`, auth("token.playerId-101"));
  assert.deepEqual(
    await payload(
      await snapshots.read(`${origin}/api/me/bag`, auth("token.playerId-202")),
    ),
    { name: "one" },
  );
  assert.deepEqual(
    await payload(
      await snapshots.read(`${origin}/api/me/bag`, auth("token.playerId-101")),
    ),
    { name: "two" },
  );
  assert.deepEqual(
    queue.calls.map(({ url }) => new URL(url).pathname),
    ["/api/me", "/api/me/bag", "/api/me", "/api/me/bag"],
  );
});

test("sparse successful sections merge, while 5xx, 429, and timeout preserve known data", async () => {
  for (const failure of [
    reply({}, 503),
    reply({}, 429),
    new Error("timeout"),
  ]) {
    let now = 100;
    const queue = queueFetcher([
      reply({ playerId: 7 }),
      reply({ profile: { name: "Ada", level: 3 }, inventory: ["a", "b"] }),
      reply({ profile: { level: 4, name: null }, inventory: [] }),
      failure,
    ]);
    const snapshots = createAccountSnapshots({
      store: memoryStore(),
      fetcher: queue.fetcher,
      now: () => now++,
      ttl: 0,
    });
    await snapshots.read(`${origin}/api/me`, auth("a"));
    await snapshots.read(`${origin}/api/me/bag`, auth("a"));
    const merged = await payload(
      await snapshots.read(`${origin}/api/me/bag`, auth("a")),
    );
    assert.deepEqual(merged, {
      profile: { name: "Ada", level: 4 },
      inventory: [],
    });
    const stale = await snapshots.read(`${origin}/api/me/bag`, auth("a"));
    assert.equal(stale.status, 200);
    assert.deepEqual(await payload(stale), merged);
    assert.equal(stale.headers.get("X-Madhouse-Snapshot"), "stale");
  }
});

test("TTL cache and concurrent demand deduplicate upstream section reads", async () => {
  let now = 1_000;
  let release;
  const queue = queueFetcher([
    reply({ playerId: 9 }),
    () =>
      new Promise((resolve) => {
        release = () => resolve(reply({ bag: [1] }));
      }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    now: () => now,
    ttl: 100,
  });
  await snapshots.read(`${origin}/api/me`, auth("a"));
  const a = snapshots.read(`${origin}/api/me/bag`, auth("a"));
  const b = snapshots.read(`${origin}/api/me/bag`, auth("a"));
  await new Promise((resolve) => setImmediate(resolve));
  release();
  await Promise.all([a, b]);
  assert.equal(queue.calls.length, 2);
  await snapshots.read(`${origin}/api/me/bag`, auth("a"));
  assert.equal(queue.calls.length, 2);
  now += 101;
  // Successful health stays current until a failed refresh; expiration forces one request.
  const expired = await snapshots.read(`${origin}/api/me/bag`, auth("a"));
  assert.equal(expired.status, 200);
  assert.deepEqual(await payload(expired), { bag: [1] });
  assert.equal(expired.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(queue.calls.length, 3);
});

test("manual profile refresh bypasses TTL once per minute and persists its limiter", async () => {
  let now = 100_000;
  const store = memoryStore();
  const first = queueFetcher([reply({ playerId: 18, name: "old" })]);
  let snapshots = createAccountSnapshots({
    store,
    fetcher: first.fetcher,
    now: () => now,
    ttl: 10,
  });
  await snapshots.read(`${origin}/api/me`, auth("manual-refresh-user"));
  now += 11;
  const refresh = queueFetcher([
    (url, init) => {
      assert.equal(
        new Headers(init.headers).has("X-Madhouse-Snapshot-Refresh"),
        false,
      );
      return reply({ playerId: 18, name: "fresh" });
    },
  ]);
  snapshots = createAccountSnapshots({
    store,
    fetcher: refresh.fetcher,
    now: () => now,
    ttl: 10,
  });
  const headers = {
    headers: {
      Authorization: "Bearer manual-refresh-user",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  };
  assert.deepEqual(
    await payload(await snapshots.read(`${origin}/api/me`, headers)),
    {
      playerId: 18,
      name: "fresh",
    },
  );
  assert.equal(refresh.calls.length, 1);
  assert.equal(store.readSnapshots()[0].manualHealthRefreshAt, now);

  now += 1;
  snapshots = createAccountSnapshots({
    store,
    fetcher: queueFetcher([]).fetcher,
    now: () => now,
    ttl: 10,
  });
  const limited = await snapshots.read(`${origin}/api/me`, headers);
  assert.deepEqual(await payload(limited), { playerId: 18, name: "fresh" });
  assert.equal(limited.headers.get("X-Madhouse-Snapshot"), "stale");
});

test("manual health refresh retries only failed snapshot APIs and returns final health", async () => {
  let now = 200_000;
  const store = memoryStore();
  const initial = createAccountSnapshots({
    store,
    now: () => now,
    fetcher: queueFetcher([
      reply({ playerId: 82, name: "player" }),
      reply({ weapon: 7 }, 500),
      reply({ tattoo: 2 }, 502),
    ]).fetcher,
  });
  const headers = auth("health-refresh-user");
  await initial.read(`${origin}/api/me`, headers);
  await initial.read(`${origin}/api/weapons/7`, headers);
  assert.equal(
    initial.health("Bearer health-refresh-user").featureCheckedAt.weapons,
    now,
  );
  now += 30_001;
  await initial.read(`${origin}/api/ornaments/zones/2`, headers);

  now += 1;
  const retry = queueFetcher([
    (url, init) => {
      assert.equal(new URL(url).pathname, "/api/weapons/7");
      assert.equal(init.method, "GET");
      return reply({ weapon: 7 });
    },
    (url, init) => {
      assert.equal(new URL(url).pathname, "/api/ornaments/zones/2");
      assert.equal(init.method, "GET");
      return reply({ error: "still unavailable" }, 503);
    },
  ]);
  const snapshots = createAccountSnapshots({
    store,
    now: () => now,
    fetcher: retry.fetcher,
  });
  const response = await snapshots.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer health-refresh-user",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  });
  assert.deepEqual(
    retry.calls.map(({ url }) => new URL(url).pathname),
    ["/api/weapons/7", "/api/ornaments/zones/2"],
  );
  assert.equal(response.headers.get("X-Madhouse-Game-Status"), "unavailable");
  assert.equal(response.headers.get("X-Madhouse-Failed-Features"), "ornaments");
  assert.equal(store.readSnapshots()[0].manualHealthRefreshAt, now);
  assert.equal(
    snapshots.health("Bearer health-refresh-user").featureCheckedAt.weapons,
    now,
  );
  assert.equal(
    snapshots.health("Bearer health-refresh-user").featureCheckedAt.ornaments,
    now,
  );

  now += 1;
  const limited = await snapshots.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer health-refresh-user",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  });
  assert.equal(limited.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(retry.calls.length, 2);
  now += 60_000;
  const recovered = queueFetcher([reply({ tattoo: 2 })]);
  const restarted = createAccountSnapshots({
    store,
    now: () => now,
    fetcher: recovered.fetcher,
  });
  const healthy = await restarted.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer health-refresh-user",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  });
  assert.deepEqual(
    recovered.calls.map(({ url }) => new URL(url).pathname),
    ["/api/ornaments/zones/2"],
  );
  assert.equal(healthy.headers.get("X-Madhouse-Game-Status"), "available");
  assert.equal(healthy.headers.get("X-Madhouse-Failed-Features"), "");
});

test("manual health refresh stops when a failed endpoint invalidates credentials", async () => {
  let now = 300_000;
  const store = memoryStore();
  const initial = createAccountSnapshots({
    store,
    now: () => now,
    fetcher: queueFetcher([
      reply({ playerId: 83, name: "player" }),
      reply({ error: "offline" }, 500),
      reply({ error: "offline" }, 500),
    ]).fetcher,
  });
  const headers = auth("health-refresh-revoked-user");
  await initial.read(`${origin}/api/me`, headers);
  await initial.read(`${origin}/api/weapons/8`, headers);
  now += 30_001;
  await initial.read(`${origin}/api/ornaments/zones/3`, headers);

  const retry = queueFetcher([
    (url) => {
      assert.equal(new URL(url).pathname, "/api/weapons/8");
      return reply({ error: "invalid" }, 401);
    },
  ]);
  const snapshots = createAccountSnapshots({
    store,
    now: () => now + 30_001,
    fetcher: retry.fetcher,
  });
  const response = await snapshots.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer health-refresh-revoked-user",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  });
  assert.equal(response.status, 401);
  assert.deepEqual(
    retry.calls.map(({ url }) => new URL(url).pathname),
    ["/api/weapons/8"],
  );
});

test("manual profile refresh bypasses outage cooldown but is limited after failure", async () => {
  let now = 200_000;
  const store = memoryStore();
  const seed = queueFetcher([reply({ playerId: 19, name: "saved" })]);
  let snapshots = createAccountSnapshots({
    store,
    fetcher: seed.fetcher,
    now: () => now,
    ttl: 10,
  });
  await snapshots.read(`${origin}/api/me`, auth("manual-outage-user"));
  now += 11;
  const failure = queueFetcher([
    reply({ error: "down" }, 503),
    reply({ error: "still down" }, 503),
  ]);
  snapshots = createAccountSnapshots({
    store,
    fetcher: failure.fetcher,
    now: () => now,
    ttl: 10,
    cooldown: 60_000,
  });
  const headers = {
    headers: {
      Authorization: "Bearer manual-outage-user",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  };
  const regular = await snapshots.read(
    `${origin}/api/me`,
    auth("manual-outage-user"),
  );
  assert.deepEqual(await payload(regular), { playerId: 19, name: "saved" });
  assert.equal(failure.calls.length, 1);
  const stale = await snapshots.read(`${origin}/api/me`, headers);
  assert.deepEqual(await payload(stale), { playerId: 19, name: "saved" });
  assert.equal(failure.calls.length, 2);
  const repeat = await snapshots.read(`${origin}/api/me`, headers);
  assert.deepEqual(await payload(repeat), { playerId: 19, name: "saved" });
  assert.equal(failure.calls.length, 2);
});

test("snapshot-only reads immediately serve persisted data without disturbing refreshes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "madhouse-snapshot-only-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = 10_000;
  let store = createAutomationStateStore({ directory });
  const initialQueue = queueFetcher([
    reply({ playerId: 90 }),
    reply({ name: "saved" }),
  ]);
  let snapshots = createAccountSnapshots({
    store,
    fetcher: initialQueue.fetcher,
    now: () => now,
    ttl: 100,
  });
  await snapshots.read(`${origin}/api/me`, auth("snapshot-user"));
  await snapshots.read(`${origin}/api/me/bag`, auth("snapshot-user"));
  const originalUpdatedAt =
    store.readSnapshots()[0].sections["/api/me/bag"].updatedAt;
  store.close();

  now += 101;
  store = createAutomationStateStore({ directory });
  t.after(() => store.close());
  let releaseRefresh;
  const refreshQueue = queueFetcher([
    () =>
      new Promise((resolve) => {
        releaseRefresh = () => resolve(reply({ name: "fresh" }));
      }),
  ]);
  snapshots = createAccountSnapshots({
    store,
    fetcher: refreshQueue.fetcher,
    now: () => now,
    ttl: 100,
  });
  const headers = {
    headers: {
      Authorization: "Bearer snapshot-user",
      "X-Madhouse-Snapshot-Only": "1",
    },
  };
  const saved = await snapshots.read(`${origin}/api/me/bag`, headers);
  assert.deepEqual(await payload(saved), { name: "saved" });
  assert.equal(saved.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(
    saved.headers.get("X-Madhouse-Section-Updated"),
    String(originalUpdatedAt),
  );
  assert.equal(saved.headers.get("X-Madhouse-Snapshot-TTL"), "100");
  assert.equal(refreshQueue.calls.length, 0);

  // A foreground refresh can be pending while snapshot-only callers still
  // receive the durable copy without joining that promise.
  const refreshing = snapshots.read(
    `${origin}/api/me/bag`,
    auth("snapshot-user"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const duringRefresh = await snapshots.read(`${origin}/api/me/bag`, headers);
  assert.deepEqual(await payload(duringRefresh), { name: "saved" });
  assert.equal(refreshQueue.calls.length, 1);
  releaseRefresh();
  const refreshed = await refreshing;
  assert.deepEqual(await payload(refreshed), { name: "fresh" });
  assert.equal(
    Number(refreshed.headers.get("X-Madhouse-Section-Updated")) >
      originalUpdatedAt,
    true,
  );
  const afterRefresh = await snapshots.read(`${origin}/api/me/bag`, headers);
  assert.equal(
    afterRefresh.headers.get("X-Madhouse-Section-Updated"),
    refreshed.headers.get("X-Madhouse-Section-Updated"),
  );
  assert.equal(refreshQueue.calls.length, 1);
});

test("snapshot-only misses perform initial reads and internal header is never forwarded", async () => {
  const queue = queueFetcher([
    (url, init) => {
      assert.equal(
        new Headers(init.headers).has("X-Madhouse-Snapshot-Only"),
        false,
      );
      return reply({ playerId: 91 });
    },
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
  });
  const response = await snapshots.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer first-read",
      "X-Madhouse-Snapshot-Only": "1",
    },
  });
  assert.deepEqual(await payload(response), { playerId: 91 });
  assert.equal(queue.calls.length, 1);
});

test("failed mutations do not invalidate saved sections", async () => {
  let now = 1000;
  const queue = queueFetcher([
    reply({ playerId: 92 }),
    reply({ owned: true }),
    reply({}, 500),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    now: () => now,
    cooldown: 0,
  });
  await snapshots.read(`${origin}/api/me`, auth("mutation-user"));
  await snapshots.read(`${origin}/api/weapons/1`, auth("mutation-user"));
  const failed = await snapshots.liveFetch(`${origin}/api/shop/buy`, {
    ...auth("mutation-user"),
    method: "POST",
  });
  assert.equal(failed.ok, false);
  now += 1;
  const cached = await snapshots.read(`${origin}/api/weapons/1`, {
    headers: {
      Authorization: "Bearer mutation-user",
      "X-Madhouse-Snapshot-Only": "1",
    },
  });
  assert.deepEqual(await payload(cached), { owned: true });
  assert.equal(cached.headers.get("X-Madhouse-Snapshot"), "current");
  assert.equal(queue.calls.length, 3);
});

test("unknown sections never produce invented snapshots and invalid credentials are distinct", async () => {
  const queue = queueFetcher([reply({ playerId: 12 }), reply({}, 401)]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
  });
  await snapshots.read(`${origin}/api/me`, auth("a"));
  const denied = await snapshots.read(`${origin}/api/me/bag`, auth("a"));
  assert.equal(denied.status, 401);
  assert.deepEqual(await payload(denied), {
    error: "game_credentials_invalid",
  });

  const otherQueue = queueFetcher([reply({ playerId: 13 }), reply({}, 503)]);
  const other = createAccountSnapshots({
    store: memoryStore(),
    fetcher: otherQueue.fetcher,
  });
  await other.read(`${origin}/api/me`, auth("b"));
  const missing = await other.read(`${origin}/api/clothing`, auth("b"));
  assert.equal(missing.status, 503);
  assert.deepEqual(await payload(missing), { error: "snapshot_unknown" });
});

test("recovery refreshes data, outage blocks mutations, liveFetch never returns stale reads", async () => {
  let now = 1_000;
  const queue = queueFetcher([
    reply({ playerId: 15 }),
    reply({ balance: 10 }),
    reply({}, 503),
    reply({ balance: 11 }),
    reply({}, 503),
    reply({ balance: 10 }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    now: () => now++,
    ttl: 0,
    cooldown: 100,
  });
  await snapshots.read(`${origin}/api/me`, auth("a"));
  await snapshots.read(`${origin}/api/me/bag`, auth("a"));
  const stale = await snapshots.read(`${origin}/api/me/bag`, auth("a"));
  assert.deepEqual(await payload(stale), { balance: 10 });
  const blocked = await snapshots.liveFetch(`${origin}/api/room/enter`, {
    ...auth("a"),
    method: "POST",
  });
  assert.equal(blocked.status, 503);
  assert.deepEqual(await payload(blocked), {
    error: "game_unavailable_actions_paused",
  });
  await new Promise((resolve) => setImmediate(resolve));
  now += 101;
  const recovered = await snapshots.read(`${origin}/api/me/bag`, auth("a"));
  assert.deepEqual(await payload(recovered), { balance: 11 });
  now += 101;
  const failure = await snapshots.liveFetch(`${origin}/api/me/bag`, auth("a"));
  assert.equal(failure.status, 503);
  assert.deepEqual(await payload(failure), { error: "game_unavailable" });
  assert.equal(failure.headers.get("X-Madhouse-Snapshot"), "none");
});

test("live automation reads cannot share a cached UI result, and forbidden is not invalid identity", async () => {
  const queue = queueFetcher([
    reply({ playerId: 3 }),
    reply({ owned: true }),
    reply({}, 503),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
  });
  await snapshots.read(`${origin}/api/me`, auth("a"));
  await snapshots.read(`${origin}/api/weapons/1`, auth("a"));
  const [view, live] = await Promise.all([
    snapshots.read(`${origin}/api/weapons/1`, auth("a")),
    snapshots.liveFetch(`${origin}/api/weapons/1`, auth("a")),
  ]);
  assert.equal(view.status, 200);
  assert.equal(live.status, 503);
  assert.equal(live.headers.get("X-Madhouse-Snapshot"), "none");
  const forbidden = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queueFetcher([reply({ playerId: 4 }), reply({}, 403)]).fetcher,
  });
  await forbidden.read(`${origin}/api/me`, auth("b"));
  assert.equal(
    (await forbidden.read(`${origin}/api/weapons/1`, auth("b"))).status,
    403,
  );
  assert.equal(forbidden.health("Bearer b").status, "available");
});

test("successful mutations invalidate cached sections and partial failures do not mask each other", async () => {
  let now = 1000;
  const queue = queueFetcher([
    reply({
      playerId: 3,
      wallet: { dollar: 10 },
      nested: { accessToken: "do-not-save" },
    }),
    reply({ owned: false }),
    reply({ ok: true }),
    reply({ owned: true }),
    reply({}, 503),
    reply({ playerId: 3 }),
    reply({ owned: true }),
  ]);
  const store = memoryStore();
  const snapshots = createAccountSnapshots({
    store,
    fetcher: queue.fetcher,
    now: () => now,
    cooldown: 1,
  });
  await snapshots.read(`${origin}/api/me`, auth("a"));
  assert.equal(
    JSON.stringify(store.readSnapshots()).includes("do-not-save"),
    false,
  );
  await snapshots.read(`${origin}/api/weapons/1`, auth("a"));
  await snapshots.liveFetch(`${origin}/api/shop/buy`, {
    ...auth("a"),
    method: "POST",
  });
  assert.deepEqual(
    await payload(await snapshots.read(`${origin}/api/weapons/1`, auth("a"))),
    { owned: true },
  );
  await snapshots.liveFetch(`${origin}/api/weapons/1`, auth("a"));
  now += 2;
  await snapshots.read(`${origin}/api/me`, auth("a"));
  assert.equal(snapshots.health("Bearer a").status, "unavailable");
  await snapshots.read(`${origin}/api/weapons/1`, auth("a"));
  assert.equal(snapshots.health("Bearer a").status, "available");
});

test("explicit partial/error/empty object responses preserve successful sections", async () => {
  for (const invalid of [
    { partial: true, items: [] },
    { success: false },
    {},
    null,
  ]) {
    const queue = queueFetcher([
      reply({ playerId: 5 }),
      reply({ items: [1] }),
      reply(invalid),
    ]);
    const snapshots = createAccountSnapshots({
      store: memoryStore(),
      fetcher: queue.fetcher,
      ttl: 0,
    });
    await snapshots.read(`${origin}/api/me`, auth("a"));
    await snapshots.read(`${origin}/api/me/bag`, auth("a"));
    const response = await snapshots.read(`${origin}/api/me/bag`, auth("a"));
    assert.deepEqual(await payload(response), { items: [1] });
    assert.equal(response.headers.get("X-Madhouse-Game-Status"), "unavailable");
  }
});

test("bounded sections evict old demand data and oversized responses preserve the last success", async () => {
  const store = memoryStore();
  let clock = 1;
  let oversized = false;
  const snapshots = createAccountSnapshots({
    store,
    now: () => clock++,
    ttl: 0,
    fetcher: async (url) => {
      if (new URL(url).pathname === "/api/me") return reply({ playerId: 10 });
      return reply(
        oversized ? { payload: "x".repeat(1024 * 1024) } : { owned: true },
      );
    },
  });
  await snapshots.read(`${origin}/api/me`, auth("a"));
  for (let id = 1; id <= 130; id++)
    await snapshots.read(`${origin}/api/weapons/${id}`, auth("a"));
  const record = store.readSnapshots()[0];
  assert.equal(Object.keys(record.sections).length, 128);
  assert.ok(record.sections["/api/me"]);
  assert.equal(record.sections["/api/weapons/1"], undefined);
  oversized = true;
  const result = await snapshots.read(`${origin}/api/weapons/130`, auth("a"));
  assert.deepEqual(await result.json(), { owned: true });
  assert.equal(result.headers.get("X-Madhouse-Snapshot"), "stale");
});

test("an explicit ended battle reference clears an older active battle instead of resurrecting it", async () => {
  const queue = queueFetcher([
    reply({
      playerId: 6,
      activeBossBattle: { battleId: "old-battle", bossId: 1 },
    }),
    reply({ playerId: 6, activeBossBattle: null }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    ttl: 0,
  });
  await snapshots.read(`${origin}/api/me`, auth("a"));
  const result = await snapshots.read(`${origin}/api/me`, auth("a"));
  assert.equal((await result.json()).activeBossBattle, null);
});

test("stash buff clears survive snapshot restart and retire the alternate API shape", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "madhouse-buff-snapshot-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let store = createAutomationStateStore({ directory });
  const expiresAtUtc = "2030-01-01T01:00:00Z";
  const initial = createAccountSnapshots({
    store,
    fetcher: queueFetcher([
      reply({ playerId: 61 }),
      reply({
        activeStashBuffs: [
          { setId: 1, name: "Набор", madness: 35, expiresAtUtc },
        ],
      }),
    ]).fetcher,
    ttl: 0,
  });
  await initial.read(`${origin}/api/me`, auth("buff-account"));
  assert.deepEqual(
    await payload(
      await initial.read(`${origin}/api/me/bag`, auth("buff-account")),
    ),
    {
      activeStashBuff: null,
      activeStashBuffs: [
        { setId: 1, name: "Набор", madness: 35, expiresAtUtc },
      ],
    },
  );
  store.close();

  store = createAutomationStateStore({ directory });
  t.after(() => store.close());
  const afterRestart = createAccountSnapshots({
    store,
    fetcher: queueFetcher([
      reply({ activeStashBuffs: null }),
      reply({
        activeStashBuff: {
          setId: 2,
          name: "Другой набор",
          madness: 20,
          expiresAtUtc,
        },
      }),
      reply({
        activeStashBuff: { setId: 3, name: "Ярость", rage: 5, expiresAtUtc },
      }),
      reply({ activeStashBuffs: [] }),
    ]).fetcher,
    ttl: 0,
  });

  const expired = await payload(
    await afterRestart.read(`${origin}/api/me/bag`, auth("buff-account")),
  );
  assert.deepEqual(expired, {
    activeStashBuff: null,
    activeStashBuffs: null,
  });

  const legacy = await payload(
    await afterRestart.read(`${origin}/api/me/bag`, auth("buff-account")),
  );
  assert.deepEqual(legacy, {
    activeStashBuff: {
      setId: 2,
      name: "Другой набор",
      madness: 20,
      expiresAtUtc,
    },
    activeStashBuffs: [],
  });

  const replaced = await payload(
    await afterRestart.read(`${origin}/api/me/bag`, auth("buff-account")),
  );
  assert.deepEqual(
    replaced.activeStashBuff,
    {
      setId: 3,
      name: "Ярость",
      rage: 5,
      expiresAtUtc,
    },
    "a replacement effect must not inherit an old set's madness bonus",
  );

  const cleared = await payload(
    await afterRestart.read(`${origin}/api/me/bag`, auth("buff-account")),
  );
  assert.deepEqual(cleared, {
    activeStashBuff: null,
    activeStashBuffs: [],
  });
});

test("bulk wardrobe categories persist and snapshot-only reads survive restart without upstream requests", async () => {
  assert.equal(isSnapshotPath("/api/clothing/by-category/1"), true);
  assert.equal(isSnapshotPath("/api/clothing/by-category/9"), true);
  assert.equal(isSnapshotPath("/api/clothing/by-category/99"), false);
  const store = memoryStore();
  const first = queueFetcher([
    reply({ playerId: 41 }),
    reply({ categoryId: 1, items: [{ weaponId: 7, owned: true }] }),
  ]);
  const snapshots = createAccountSnapshots({ store, fetcher: first.fetcher });
  await snapshots.read(`${origin}/api/me`, auth("wardrobe-user"));
  await snapshots.read(
    `${origin}/api/clothing/by-category/1`,
    auth("wardrobe-user"),
  );
  const offline = queueFetcher([]);
  const restarted = createAccountSnapshots({ store, fetcher: offline.fetcher });
  const result = await restarted.read(`${origin}/api/clothing/by-category/1`, {
    headers: {
      Authorization: "Bearer wardrobe-user",
      "X-Madhouse-Snapshot-Only": "1",
    },
  });
  assert.deepEqual(await result.json(), {
    categoryId: 1,
    items: [{ weaponId: 7, owned: true }],
  });
  assert.equal(offline.calls.length, 0);
});

test("health exposes safe failing functions and removes only recovered functions", async () => {
  let clock = 1000;
  const fake = queueFetcher([
    reply({ playerId: 41 }),
    reply({ error: "private raw error" }, 503),
    reply({ error: "down" }, 429),
    reply({ id: 7, level: 2 }),
    reply({ categoryId: 1, items: [] }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: fake.fetcher,
    now: () => clock,
    cooldown: 0,
  });
  await snapshots.read(`${origin}/api/me`, auth("health-user"));
  await snapshots.read(`${origin}/api/businesses/7`, auth("health-user"));
  const failed = await snapshots.read(
    `${origin}/api/clothing/by-category/1`,
    auth("health-user"),
  );
  assert.equal(
    failed.headers.get("X-Madhouse-Failed-Features"),
    "weapons,businesses",
  );
  assert.deepEqual(snapshots.health("Bearer health-user").failedFeatures, [
    "weapons",
    "businesses",
  ]);
  assert.deepEqual(snapshots.health("Bearer health-user").successfulFeatures, [
    "profile",
  ]);
  clock++;
  await snapshots.read(`${origin}/api/businesses/7`, auth("health-user"));
  assert.deepEqual(snapshots.health("Bearer health-user").failedFeatures, [
    "weapons",
  ]);
  const recovered = await snapshots.read(
    `${origin}/api/clothing/by-category/1`,
    auth("health-user"),
  );
  assert.equal(recovered.headers.get("X-Madhouse-Failed-Features"), "");
  assert.deepEqual(
    recovered.headers.get("X-Madhouse-Successful-Features")?.split(","),
    ["profile", "weapons", "businesses"],
  );
  assert.equal(snapshots.health("Bearer health-user").status, "available");
  assert.deepEqual(snapshots.health("Bearer other-account").failedFeatures, []);
});

test("successful features require fresh clean sections and exclude failed functions", async () => {
  let clock = 1000;
  const fake = queueFetcher([
    reply({ playerId: 42 }),
    reply({ id: 1 }),
    reply({ error: "down" }, 503),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: fake.fetcher,
    now: () => clock,
    ttl: 200,
  });
  await snapshots.read(`${origin}/api/me`, auth("fresh-health"));
  await snapshots.read(`${origin}/api/businesses/1`, auth("fresh-health"));
  assert.deepEqual(snapshots.health("Bearer fresh-health").successfulFeatures, [
    "profile",
    "businesses",
  ]);
  clock += 201;
  assert.deepEqual(
    snapshots.health("Bearer fresh-health").successfulFeatures,
    [],
  );
  await snapshots.read(`${origin}/api/businesses/1`, auth("fresh-health"));
  assert.deepEqual(
    snapshots.health("Bearer fresh-health").successfulFeatures,
    [],
  );
});

test("work state POST is a reader: optional wardrobe outage cannot block it or dirty snapshots", async () => {
  const queue = queueFetcher([
    reply({ playerId: 15 }),
    reply({}, 503),
    reply({ workId: 7 }),
    reply({ success: true }),
  ]);
  const store = memoryStore();
  const snapshots = createAccountSnapshots({ store, fetcher: queue.fetcher });
  await snapshots.read(`${origin}/api/me`, auth("a"));
  await snapshots.read(`${origin}/api/ornaments/zones/14`, auth("a"));
  assert.equal(snapshots.health("Bearer a").status, "unavailable");
  const open = await snapshots.liveFetch(`${origin}/api/works/open`, {
    ...auth("a"),
    method: "POST",
    body: JSON.stringify({ workId: 7 }),
  });
  assert.equal(open.status, 200);
  assert.ok(!store.readSnapshots()[0].sections["/api/me"].dirty);
  const perform = await snapshots.liveFetch(
    `${origin}/api/works/tasks/perform`,
    { ...auth("a"), method: "POST" },
  );
  assert.equal(perform.status, 200);
  assert.equal(store.readSnapshots()[0].sections["/api/me"].dirty, true);
});

test("work actions remain blocked on inventory/global outage while state reads can recover", async () => {
  for (const failedPath of ["/api/me/bag", "/api/me"]) {
    const queue = queueFetcher([
      reply({ playerId: 15 }),
      reply({}, 503),
      reply({ workId: 7 }),
    ]);
    const snapshots = createAccountSnapshots({
      store: memoryStore(),
      fetcher: queue.fetcher,
      ttl: 0,
    });
    await snapshots.read(`${origin}/api/me`, auth("a"));
    await snapshots.liveFetch(`${origin}${failedPath}`, auth("a"));
    const perform = await snapshots.liveFetch(
      `${origin}/api/works/tasks/perform`,
      { ...auth("a"), method: "POST" },
    );
    assert.equal(perform.status, 503);
    const open = await snapshots.liveFetch(`${origin}/api/works/open`, {
      ...auth("a"),
      method: "POST",
    });
    assert.equal(open.status, 200);
    assert.equal(queue.calls.length, 3);
  }
});
