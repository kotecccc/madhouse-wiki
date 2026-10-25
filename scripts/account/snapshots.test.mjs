import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAccountSnapshots } from "./snapshots.mjs";
import { createAutomationStateStore } from "../automation/state-store.mjs";

const origin = "https://cargohustle.online";
const auth = (token) => ({ headers: { Authorization: `Bearer ${token}` } });
const reply = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
const payload = (response) => response.json();

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
