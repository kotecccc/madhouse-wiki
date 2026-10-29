import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPlayerProgressReader } from "./player-progress.mjs";
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

test("bridge profile writes share byte capacity eviction with direct snapshots", () => {
  const store = memoryStore();
  const authorization = "Bearer bridge-profile-capacity";
  const digest = createHash("sha256").update(authorization).digest("hex");
  store.writeSnapshot("41", {
    schemaVersion: 1,
    playerId: "41",
    sections: {
      "/api/me": {
        data: { playerId: 41, nickname: "Old" },
        updatedAt: 1,
      },
      "/api/weapons/1": {
        data: { payload: "w".repeat(2_100_000) },
        updatedAt: 2,
      },
      "/api/rooms": {
        data: { payload: "r".repeat(500_000) },
        updatedAt: 3,
      },
    },
    credentialHashes: [digest],
  });
  const snapshots = createAccountSnapshots({
    store,
    fetcher: () => assert.fail("snapshot save must not call the game"),
    now: () => 4,
  });

  snapshots.saveBridgeProfile(authorization, {
    playerId: 41,
    nickname: "Current",
    payload: "p".repeat(600_000),
  });

  const record = store.readSnapshots()[0];
  assert.ok(Buffer.byteLength(JSON.stringify(record)) <= 3 * 1024 * 1024);
  assert.equal(record.sections["/api/me"].data.nickname, "Current");
  assert.equal(record.sections["/api/weapons/1"], undefined);
  assert.ok(record.sections["/api/rooms"]);
});

test("bridge profile writes keep at most 128 sections while preserving the profile", () => {
  const store = memoryStore();
  const authorization = "Bearer bridge-profile-section-capacity";
  const digest = createHash("sha256").update(authorization).digest("hex");
  store.writeSnapshot("41", {
    schemaVersion: 1,
    playerId: "41",
    sections: Object.fromEntries(
      Array.from({ length: 128 }, (_, index) => [
        `/api/weapons/${index + 1}`,
        { data: { owned: true }, updatedAt: index + 1 },
      ]),
    ),
    credentialHashes: [digest],
  });
  const snapshots = createAccountSnapshots({ store });

  snapshots.saveBridgeProfile(authorization, { playerId: 41 });

  const sections = store.readSnapshots()[0].sections;
  assert.equal(Object.keys(sections).length, 128);
  assert.ok(sections["/api/me"]);
  assert.equal(sections["/api/weapons/1"], undefined);
  assert.ok(sections["/api/weapons/128"]);
});

test("verified automation credentials retain their player scope without a profile snapshot", () => {
  const store = memoryStore();
  store.write("41", { credential: "Bearer saved" });
  const snapshots = createAccountSnapshots({ store });
  assert.equal(snapshots.identity("Bearer saved"), null);
  assert.equal(snapshots.credentialPlayerId("Bearer saved"), 41);
  assert.equal(snapshots.credentialPlayerId("Bearer unknown"), null);
});

test("identity snapshot returns only verified account identity and never numeric profile data", async () => {
  const queue = queueFetcher([
    reply({
      playerId: 41,
      nickname: "Player",
      wallet: { gold: 123 },
      characterStats: { rage: 99 },
    }),
  ]);
  const store = memoryStore();
  const snapshots = createAccountSnapshots({ store, fetcher: queue.fetcher });
  assert.equal(snapshots.identity("Bearer unknown"), null);
  await snapshots.read(`${origin}/api/me`, auth("identity-a"));
  assert.deepEqual(snapshots.identity("Bearer identity-a"), {
    playerId: 41,
    nickname: "Player",
  });
  assert.equal(snapshots.identity("Bearer identity-b"), null);
  const restarted = createAccountSnapshots({ store, fetcher: queue.fetcher });
  assert.deepEqual(restarted.identity("Bearer identity-a"), {
    playerId: 41,
    nickname: "Player",
  });
  assert.equal(queue.calls.length, 1);
});

test("stored reads never use the game for unknown identity or missing data", async () => {
  const queue = queueFetcher([reply({ playerId: 41 })]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
  });
  assert.equal(
    snapshots.readStored(`${origin}/api/me/bag`, auth("unknown")).status,
    401,
  );
  await snapshots.read(`${origin}/api/me`, auth("known"));
  assert.equal(
    snapshots.readStored(`${origin}/api/me/bag`, auth("known")).status,
    404,
  );
  assert.deepEqual(
    await payload(snapshots.readStored(`${origin}/api/me`, auth("known"))),
    { playerId: 41 },
  );
  assert.equal(queue.calls.length, 1);
});

test("legacy owner resolution requires the exact saved credential and matching verified Telegram identity", async () => {
  const queue = queueFetcher([reply({ playerId: 41, telegramId: 101 })]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
  });
  await snapshots.read(`${origin}/api/me`, auth("known"));
  assert.equal(snapshots.resolveStoredOwner("Bearer known", "101"), 41);
  assert.equal(snapshots.resolveStoredOwner("Bearer known", "102"), null);
  assert.equal(snapshots.resolveStoredOwner("Bearer other", "101"), null);
  assert.equal(queue.calls.length, 1);
  const noOwner = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queueFetcher([reply({ playerId: 42 })]).fetcher,
  });
  await noOwner.read(`${origin}/api/me`, auth("verified-legacy"));
  assert.equal(noOwner.resolveStoredOwner("Bearer verified-legacy", "101"), 42);
});

test("an expired game JWT cannot authorize stored reads without independent Wiki verification", async () => {
  const token = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
  const queue = queueFetcher([reply({ playerId: 41 })]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    now: () => 2000,
  });
  await snapshots.read(`${origin}/api/me`, auth(token));
  assert.equal(
    snapshots.readStored(`${origin}/api/me`, auth(token)).status,
    401,
  );
  assert.equal(
    snapshots.readStored(`${origin}/api/me`, auth(token), {
      verifiedWiki: true,
      verifiedPlayerId: 41,
    }).status,
    200,
  );
  assert.equal(queue.calls.length, 1);
});

test("stored snapshots survive restart and retain their original freshness metadata offline", async () => {
  let now = 1000;
  const store = memoryStore();
  const initial = queueFetcher([reply({ playerId: 41 }), reply([])]);
  let snapshots = createAccountSnapshots({
    store,
    fetcher: initial.fetcher,
    now: () => now,
    ttl: 100,
  });
  await snapshots.read(`${origin}/api/me`, auth("known"));
  await snapshots.read(`${origin}/api/me/bag`, auth("known"));
  now = 1200;
  const offline = queueFetcher([]);
  snapshots = createAccountSnapshots({
    store,
    fetcher: offline.fetcher,
    now: () => now,
    ttl: 100,
  });
  const saved = snapshots.readStored(`${origin}/api/me/bag`, auth("known"));
  assert.deepEqual(await payload(saved), []);
  assert.equal(saved.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(saved.headers.get("X-Madhouse-Section-Updated"), "1000");
  assert.equal(
    snapshots.readStored(`${origin}/api/rooms`, auth("known")).status,
    404,
  );
  assert.equal(
    snapshots.readStored(`${origin}/api/me/bag`, auth("other")).status,
    401,
  );
  assert.equal(offline.calls.length, 0);
});

test("a sparse post-restart refresh preserves prior timestamp and action reads stay raw", async () => {
  let now = 1000;
  const store = memoryStore();
  const initial = queueFetcher([
    reply({ playerId: 43 }),
    reply({ coins: 7, items: ["confirmed"] }),
  ]);
  let snapshots = createAccountSnapshots({
    store,
    fetcher: initial.fetcher,
    now: () => now,
    ttl: 100,
  });
  await snapshots.read(`${origin}/api/me`, auth("sparse-restart"));
  await snapshots.read(`${origin}/api/me/bag`, auth("sparse-restart"));

  now = 1200;
  const refresh = queueFetcher([reply({ coins: 8 }), reply({ coins: 9 })]);
  snapshots = createAccountSnapshots({
    store,
    fetcher: refresh.fetcher,
    now: () => now,
    ttl: 100,
  });
  const display = await snapshots.read(
    `${origin}/api/me/bag`,
    auth("sparse-restart"),
  );
  assert.deepEqual(await payload(display), {
    coins: 8,
    items: ["confirmed"],
  });
  assert.equal(display.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(display.headers.get("X-Madhouse-Section-Updated"), "1000");

  const stored = snapshots.readStored(
    `${origin}/api/me/bag`,
    auth("sparse-restart"),
  );
  assert.deepEqual(await payload(stored), {
    coins: 8,
    items: ["confirmed"],
  });
  assert.equal(stored.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(stored.headers.get("X-Madhouse-Section-Updated"), "1000");

  const actionRead = await snapshots.liveFetch(
    `${origin}/api/me/bag`,
    auth("sparse-restart"),
  );
  assert.deepEqual(await payload(actionRead), { coins: 9 });
  assert.equal(actionRead.headers.get("X-Madhouse-Snapshot"), "current");
  assert.equal(actionRead.headers.get("X-Madhouse-Section-Updated"), "1200");
  const storedAfterAction = snapshots.readStored(
    `${origin}/api/me/bag`,
    auth("sparse-restart"),
  );
  assert.deepEqual(await payload(storedAfterAction), {
    coins: 9,
    items: ["confirmed"],
  });
  assert.equal(storedAfterAction.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(
    storedAfterAction.headers.get("X-Madhouse-Section-Updated"),
    "1000",
  );
  assert.equal(refresh.calls.length, 2);
});

test("live profile returns observation time while its sparse merged snapshot stays stale", async () => {
  let now = 1000;
  const store = memoryStore();
  const initial = queueFetcher([
    reply({ playerId: 45, wallet: { gold: 10 }, energy: { current: 1 } }),
  ]);
  let snapshots = createAccountSnapshots({
    store,
    fetcher: initial.fetcher,
    now: () => now,
    ttl: 100,
  });
  await snapshots.read(`${origin}/api/me`, auth("live-profile-metadata"));

  now = 2000;
  const live = queueFetcher([reply({ playerId: 45, energy: { current: 2 } })]);
  snapshots = createAccountSnapshots({
    store,
    fetcher: live.fetcher,
    now: () => now,
    ttl: 100,
  });
  const response = await snapshots.read(`${origin}/api/me`, {
    headers: {
      ...auth("live-profile-metadata").headers,
      "X-Madhouse-Snapshot-Refresh": "live",
    },
  });
  assert.deepEqual(await payload(response), {
    playerId: 45,
    energy: { current: 2 },
  });
  assert.equal(response.headers.get("X-Madhouse-Snapshot"), "current");
  assert.equal(response.headers.get("X-Madhouse-Section-Updated"), "2000");

  const stored = snapshots.readStored(
    `${origin}/api/me`,
    auth("live-profile-metadata"),
  );
  assert.deepEqual(await payload(stored), {
    playerId: 45,
    wallet: { gold: 10 },
    energy: { current: 2 },
  });
  assert.equal(stored.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(stored.headers.get("X-Madhouse-Section-Updated"), "1000");
});

test("allowed nulls and explicit empty lists replace old values without retaining freshness debt", async () => {
  let now = 100;
  const buff = {
    setId: 2,
    name: "Effect",
    expiresAtUtc: "2030-01-01T00:00:00Z",
  };
  const queue = queueFetcher([
    reply({ playerId: 44 }),
    reply({ activeStashBuff: buff, activeStashBuffs: [buff], items: [1] }),
    reply({ activeStashBuff: null, activeStashBuffs: [], items: [] }),
  ]);
  const store = memoryStore();
  const snapshots = createAccountSnapshots({
    store,
    fetcher: queue.fetcher,
    now: () => now,
    ttl: 1000,
  });
  await snapshots.read(`${origin}/api/me`, auth("allowed-clears"));
  await snapshots.read(`${origin}/api/me/bag`, auth("allowed-clears"));
  now = 1200;
  const response = await snapshots.read(
    `${origin}/api/me/bag`,
    auth("allowed-clears"),
  );

  assert.deepEqual(await payload(response), {
    activeStashBuff: null,
    activeStashBuffs: [],
    items: [],
  });
  assert.equal(response.headers.get("X-Madhouse-Snapshot"), "current");
  const stored = snapshots.readStored(
    `${origin}/api/me/bag`,
    auth("allowed-clears"),
  );
  assert.equal(stored.headers.get("X-Madhouse-Snapshot"), "current");
  assert.equal(stored.headers.get("X-Madhouse-Section-Updated"), "1200");
});

test("a read dispatched before a mutation cannot overwrite the invalidated snapshot", async () => {
  let finishRead;
  let startedRead;
  const started = new Promise((resolve) => {
    startedRead = resolve;
  });
  const queue = queueFetcher([
    reply({ playerId: 41 }),
    reply({ coins: 10 }),
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
        startedRead();
      }),
    reply({ ok: true }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    ttl: 0,
  });
  await snapshots.read(`${origin}/api/me`, auth("known"));
  await snapshots.read(`${origin}/api/me/bag`, auth("known"));
  const pending = snapshots.read(`${origin}/api/me/bag`, auth("known"));
  await started;
  await snapshots.liveFetch(`${origin}/api/shop/buy`, {
    ...auth("known"),
    method: "POST",
  });
  finishRead(reply({ coins: 99 }));
  const result = await pending;
  assert.deepEqual(await payload(result), { coins: 10 });
  assert.equal(result.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.deepEqual(
    await payload(snapshots.readStored(`${origin}/api/me/bag`, auth("known"))),
    { coins: 10 },
  );
});

test("a forced profile refresh does not join an ordinary pending read", async () => {
  let finishRead;
  let signalStarted;
  const started = new Promise((resolve) => {
    signalStarted = resolve;
  });
  const queue = queueFetcher([
    reply({ playerId: 41, nickname: "old" }),
    () =>
      new Promise((resolve) => {
        finishRead = resolve;
        signalStarted();
      }),
    reply({ playerId: 41, nickname: "new" }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    ttl: 0,
  });
  await snapshots.read(`${origin}/api/me`, auth("known"));
  const normal = snapshots.read(`${origin}/api/me`, auth("known"));
  await started;
  const refresh = snapshots.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer known",
      "X-Madhouse-Snapshot-Refresh": "live",
    },
  });
  finishRead(reply({ playerId: 41, nickname: "intermediate" }));
  await normal;
  assert.equal((await payload(await refresh)).nickname, "new");
  assert.equal(queue.calls.length, 3);
});

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

test("snapshot-only tattoo reads never request a missing zone from the game", async () => {
  const upstream = queueFetcher([reply({ playerId: 82, name: "player" })]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: upstream.fetcher,
  });
  await snapshots.read(`${origin}/api/me`, auth("tattoo-snapshot-user"));
  const response = await snapshots.read(`${origin}/api/ornaments/zones/2`, {
    headers: {
      Authorization: "Bearer tattoo-snapshot-user",
      "X-Madhouse-Snapshot-Only": "1",
    },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(
    upstream.calls.map(({ url }) => new URL(url).pathname),
    ["/api/me"],
  );
});

test("manual profile refresh is performed before unrelated failed sections", async () => {
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
      assert.equal(new URL(url).pathname, "/api/me");
      assert.equal(init.method, "GET");
      return reply({ playerId: 82, name: "current" });
    },
    (url, init) => {
      assert.equal(new URL(url).pathname, "/api/weapons/7");
      assert.equal(init.method, "GET");
      return reply({ weapon: 7 });
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
    ["/api/me"],
  );
  assert.equal(response.headers.get("X-Madhouse-Game-Status"), "unavailable");
  assert.equal(
    response.headers.get("X-Madhouse-Failed-Features"),
    "profile,weapons,ornaments",
  );
  assert.equal(store.readSnapshots()[0].manualHealthRefreshAt, now);
  assert.equal(
    JSON.parse(response.headers.get("X-Madhouse-Feature-Failed-At")).weapons,
    now - 30_002,
  );
  assert.equal(
    snapshots.health("Bearer health-refresh-user").featureFailedAt.ornaments,
    now - 1,
  );
  assert.equal(
    snapshots.health("Bearer health-refresh-user").featureCheckedAt.weapons,
    now - 30_002,
  );
  assert.equal(
    snapshots.health("Bearer health-refresh-user").featureCheckedAt.ornaments,
    now - 1,
  );

  now += 1;
  const limited = await snapshots.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer health-refresh-user",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  });
  assert.equal(limited.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(retry.calls.length, 1);
  now += 60_000;
  const recovered = queueFetcher([
    reply({ playerId: 82, name: "current" }),
    reply({ weapon: 7 }),
  ]);
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
    ["/api/me", "/api/weapons/7"],
  );
  assert.equal(healthy.headers.get("X-Madhouse-Failed-Features"), "ornaments");
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
    reply({ playerId: 83, name: "player" }),
    (url) => {
      assert.equal(new URL(url).pathname, "/api/weapons/8");
      return reply({ error: "invalid" }, 401);
    },
    reply({}, 401),
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
    ["/api/me", "/api/weapons/8", "/api/me"],
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

test("a failed mutation leaves its profile invalidation barrier in place", async () => {
  let now = 1000;
  const store = memoryStore();
  const queue = queueFetcher([
    reply({ playerId: 92 }),
    reply({ owned: true }),
    reply({}, 500),
  ]);
  const snapshots = createAccountSnapshots({
    store,
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
  assert.equal(snapshots.health("Bearer mutation-user").profileRevision, 1);
  assert.equal(store.readSnapshots()[0].sections["/api/me"].dirty, true);
  now += 1;
  const cached = await snapshots.read(`${origin}/api/weapons/1`, {
    headers: {
      Authorization: "Bearer mutation-user",
      "X-Madhouse-Snapshot-Only": "1",
    },
  });
  assert.deepEqual(await payload(cached), { owned: true });
  assert.equal(cached.headers.get("X-Madhouse-Snapshot"), "stale");
  assert.equal(queue.calls.length, 3);
});

test("mutation barrier supersedes a delayed GET before its response can commit", async () => {
  const store = memoryStore();
  const calls = [];
  let releaseProfile;
  let releaseMutation;
  const snapshots = createAccountSnapshots({
    store,
    fetcher: async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1)
        return reply({ playerId: 93, wallet: { gold: 1 } });
      if (init.method === "POST")
        return new Promise((resolve) => {
          releaseMutation = resolve;
        });
      return new Promise((resolve) => {
        releaseProfile = resolve;
      });
    },
  });
  await snapshots.read(`${origin}/api/me`, auth("delayed-mutation"));
  const oldRead = snapshots.liveFetch(
    `${origin}/api/me`,
    auth("delayed-mutation"),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const mutation = snapshots.liveFetch(`${origin}/api/shop/buy`, {
    ...auth("delayed-mutation"),
    method: "POST",
  });
  assert.equal(snapshots.health("Bearer delayed-mutation").profileRevision, 1);
  assert.equal(store.readSnapshots()[0].sections["/api/me"].dirty, true);

  releaseProfile(reply({ playerId: 93, wallet: { gold: 99 } }));
  const superseded = await oldRead;
  assert.equal(superseded.status, 409);
  assert.deepEqual(store.readSnapshots()[0].sections["/api/me"].data.wallet, {
    gold: 1,
  });
  releaseMutation(reply({ success: true }));
  assert.equal((await mutation).status, 200);
  assert.equal(calls.filter(({ init }) => init.method === "POST").length, 1);
});

test("lost mutation response keeps the durable barrier and is never replayed", async () => {
  let now = 1234;
  const store = memoryStore();
  const queue = queueFetcher([
    reply({ playerId: 94, wallet: { gold: 2 } }),
    reply({ coins: 4 }),
    reply({ catalog: { rooms: [{ id: 1, owned: true }] } }),
    new Error("connection lost after dispatch"),
  ]);
  const snapshots = createAccountSnapshots({
    store,
    fetcher: queue.fetcher,
    now: () => now,
  });
  await snapshots.read(`${origin}/api/me`, auth("lost-mutation"));
  await snapshots.read(`${origin}/api/me/bag`, auth("lost-mutation"));
  await snapshots.read(`${origin}/api/rooms`, auth("lost-mutation"));
  const response = await snapshots.liveFetch(`${origin}/api/shop/buy`, {
    ...auth("lost-mutation"),
    method: "POST",
  });
  assert.equal(response.status, 503);
  assert.equal(queue.calls.length, 4);
  assert.equal(snapshots.health("Bearer lost-mutation").profileRevision, 1);
  const stored = store.readSnapshots()[0].sections["/api/me"];
  assert.equal(stored.dirty, true);
  assert.deepEqual(stored.data.wallet, { gold: 2 });
  assert.equal(stored.updatedAt, now);
  const record = store.readSnapshots()[0];
  assert.equal(record.sections["/api/me/bag"].dirty, true);
  assert.equal(record.sections["/api/rooms"].dirty, true);
  assert.deepEqual(snapshots.inventory("Bearer lost-mutation").dirty, [
    "/api/rooms",
  ]);
});

test("unknown sections never produce invented snapshots and invalid credentials are distinct", async () => {
  const queue = queueFetcher([
    reply({ playerId: 12 }),
    reply({}, 401),
    reply({}, 401),
  ]);
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

test("section 401 is scoped after profile authorization succeeds, and a revoked hash can recover by profile refresh", async () => {
  const queue = queueFetcher([
    reply({ playerId: 23, energy: { current: 5 } }),
    reply({ coins: 40 }),
    reply({}, 401),
    reply({ playerId: 23 }),
    reply({}, 401),
    reply({ playerId: 23, energy: { current: 7 } }),
  ]);
  const store = memoryStore();
  const snapshots = createAccountSnapshots({
    store,
    fetcher: queue.fetcher,
    ttl: 0,
  });
  await snapshots.read(`${origin}/api/me`, auth("section-401-user"));
  await snapshots.read(`${origin}/api/me/bag`, auth("section-401-user"));

  const sectionFailure = await snapshots.read(
    `${origin}/api/me/bag`,
    auth("section-401-user"),
  );
  assert.equal(sectionFailure.status, 200);
  assert.deepEqual(await payload(sectionFailure), { coins: 40 });
  assert.deepEqual(store.readSnapshots()[0].revokedHashes || [], []);

  const profileFailure = await snapshots.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer section-401-user",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  });
  assert.equal(profileFailure.status, 401);
  assert.deepEqual(await payload(profileFailure), {
    error: "game_credentials_invalid",
  });
  const recovered = await snapshots.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer section-401-user",
      "X-Madhouse-Snapshot-Refresh": "1",
    },
  });
  assert.equal(recovered.status, 200);
  assert.deepEqual((await payload(recovered)).energy, { current: 7 });
  assert.deepEqual(store.readSnapshots()[0].revokedHashes, []);
});

test("recovery preserves reads while live mutations are attempted despite health outages", async () => {
  let now = 1_000;
  const queue = queueFetcher([
    reply({ playerId: 15 }),
    reply({ balance: 10 }),
    reply({}, 503),
    reply({}, 503),
    reply({ balance: 11 }),
    reply({}, 503),
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
  const attempted = await snapshots.liveFetch(`${origin}/api/room/enter`, {
    ...auth("a"),
    method: "POST",
  });
  assert.equal(attempted.status, 503);
  assert.equal(queue.calls.length, 4);
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
  assert.equal(snapshots.health("Bearer a").profileRevision, 0);
  await snapshots.liveFetch(`${origin}/api/shop/buy`, {
    ...auth("a"),
    method: "POST",
  });
  assert.equal(snapshots.health("Bearer a").profileRevision, 1);
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

test("boss detail activeBattle clears only on explicit null for the matching boss", async () => {
  const activeBattle = { battleId: "battle-7", bossId: 7 };
  const queue = queueFetcher([
    reply({ playerId: 7 }),
    reply({ id: 7, name: "Boss", activeBattle }),
    reply({ id: 7, name: "Boss updated" }),
    reply({ id: 8, activeBattle: null }),
    reply({ id: 7, activeBattle: null }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    ttl: 0,
    cooldown: 0,
  });
  await snapshots.read(`${origin}/api/me`, auth("boss-detail-snapshot"));
  await snapshots.read(`${origin}/api/bosses/7`, auth("boss-detail-snapshot"));

  const omitted = await snapshots.read(
    `${origin}/api/bosses/7`,
    auth("boss-detail-snapshot"),
  );
  assert.deepEqual((await payload(omitted)).activeBattle, activeBattle);

  const mismatched = await snapshots.read(
    `${origin}/api/bosses/7`,
    auth("boss-detail-snapshot"),
  );
  assert.deepEqual((await payload(mismatched)).activeBattle, activeBattle);
  assert.equal(mismatched.headers.get("X-Madhouse-Snapshot"), "stale");

  const cleared = await snapshots.read(
    `${origin}/api/bosses/7`,
    auth("boss-detail-snapshot"),
  );
  assert.equal((await payload(cleared)).activeBattle, null);

  const stored = snapshots.readStored(
    `${origin}/api/bosses/7`,
    auth("boss-detail-snapshot"),
  );
  assert.equal((await payload(stored)).activeBattle, null);
  assert.equal(queue.calls.length, 5);
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

test("friends failures are scoped and clear only on a valid friends response", async () => {
  const queue = queueFetcher([
    reply({ playerId: 41 }),
    reply({}, 500),
    reply({ items: [] }),
    reply({ items: [], nextCursor: null }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
  });
  await snapshots.read(`${origin}/api/me`, auth("friends-health"));
  await snapshots.liveFetch(
    `${origin}/api/friends?limit=100`,
    auth("friends-health"),
  );
  assert.deepEqual(snapshots.health("Bearer friends-health").failedFeatures, [
    "friends",
  ]);
  await snapshots.liveFetch(
    `${origin}/api/friends?limit=100`,
    auth("friends-health"),
  );
  assert.deepEqual(snapshots.health("Bearer friends-health").failedFeatures, [
    "friends",
  ]);
  await snapshots.liveFetch(
    `${origin}/api/friends?limit=100`,
    auth("friends-health"),
  );
  assert.equal(snapshots.health("Bearer friends-health").status, "available");
});

test("upstream reads respect caller cancellation", async () => {
  const controller = new AbortController();
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: async (_url, options) => {
      controller.abort();
      assert.equal(options.signal.aborted, true);
      throw new DOMException("Aborted", "AbortError");
    },
  });
  const response = await snapshots.read(`${origin}/api/me`, {
    ...auth("cancelled-read"),
    signal: controller.signal,
  });
  assert.equal(response.status, 503);
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

test("work actions are attempted during inventory/global outage and state reads can recover", async () => {
  for (const failedPath of ["/api/me/bag", "/api/me"]) {
    const queue = queueFetcher([
      reply({ playerId: 15 }),
      reply({}, 503),
      reply({ success: true }),
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
    assert.equal(perform.status, 200);
    const open = await snapshots.liveFetch(`${origin}/api/works/open`, {
      ...auth("a"),
      method: "POST",
    });
    assert.equal(open.status, 200);
    assert.equal(queue.calls.length, 4);
  }
});

test("opening the site revalidates sensitive profile even inside manual refresh cooldown", async () => {
  const queue = queueFetcher([
    reply({
      playerId: 12,
      level: 3,
      currentExp: 10,
      energy: { current: 5, max: 10 },
    }),
    reply({
      playerId: 12,
      level: 4,
      currentExp: 1,
      energy: { current: 9, max: 10 },
    }),
    reply({
      playerId: 12,
      level: 5,
      currentExp: 2,
      energy: { current: 8, max: 10 },
    }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    now: () => 1000,
  });
  await snapshots.read(`${origin}/api/me`, auth("revalidate"));
  const options = {
    headers: {
      ...auth("revalidate").headers,
      "X-Madhouse-Snapshot-Refresh": "live",
    },
  };
  assert.equal(
    (await payload(await snapshots.read(`${origin}/api/me`, options))).level,
    4,
  );
  assert.equal(
    (await payload(await snapshots.read(`${origin}/api/me`, options))).level,
    5,
  );
  assert.equal(queue.calls.length, 3);
  assert.equal(
    queue.calls[1].init.headers.get("X-Madhouse-Snapshot-Refresh"),
    null,
  );
});

test("live profile does not fill missing current fields from an older snapshot", async () => {
  const queue = queueFetcher([
    reply({
      playerId: 41,
      wallet: { gold: 100 },
      characterStats: { rage: { total: 5 } },
    }),
    reply({ playerId: 41, energy: { current: 10, max: 100 } }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
  });
  await snapshots.read(`${origin}/api/me`, auth("sparse-live"));
  const response = await snapshots.read(`${origin}/api/me`, {
    headers: {
      ...auth("sparse-live").headers,
      "X-Madhouse-Snapshot-Refresh": "live",
    },
  });
  const profile = await response.json();
  assert.equal(profile.wallet, undefined);
  assert.equal(profile.characterStats, undefined);
  assert.equal(profile.energy.current, 10);
});

test("live profile enriches current own level and cannot carry old-level experience across a level change", async () => {
  const queue = queueFetcher([
    reply({
      playerId: 41,
      exp: { level: 135, currentExp: 100, expToNextLevel: 500 },
    }),
    reply({ playerId: 41, energy: { current: 10, max: 100 } }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
    refreshProfileProgress: createPlayerProgressReader({
      fetcher: async () => reply({ playerId: 41, level: 136 }),
    }),
  });
  await snapshots.read(`${origin}/api/me`, auth("level-change"));
  const response = await snapshots.read(`${origin}/api/me`, {
    headers: {
      ...auth("level-change").headers,
      "X-Madhouse-Snapshot-Refresh": "live",
    },
  });
  const profile = await response.json();
  assert.deepEqual(profile.exp, { level: 136 });
  assert.equal(profile.energy.current, 10);
});

test("verified profile identity exposes saved experience for its own account", async () => {
  const queue = queueFetcher([
    reply({
      playerId: 41,
      exp: { level: 135, currentExp: 100, expToNextLevel: 500 },
    }),
  ]);
  const snapshots = createAccountSnapshots({
    store: memoryStore(),
    fetcher: queue.fetcher,
  });
  await snapshots.read(`${origin}/api/me`, auth("saved-experience"));
  assert.deepEqual(snapshots.identity("Bearer saved-experience").exp, {
    level: 135,
    currentExp: 100,
    expToNextLevel: 500,
  });
  assert.equal(snapshots.identity("Bearer other"), null);
});

test("inventory snapshots are private, survive restart, and level changes invalidate them without game reads", async () => {
  const store = memoryStore();
  const { fetcher, calls } = queueFetcher([
    reply({ playerId: 44, exp: { level: 7 } }),
    reply({ items: [{ id: 1, owned: false, unlocked: true }] }),
    reply({ playerId: 44, exp: { level: 8 } }),
    reply({ items: [{ id: 1, owned: true }] }),
  ]);
  let snapshots = createAccountSnapshots({ store, fetcher });
  await snapshots.read(`${origin}/api/me`, auth("inventory-a"));
  await snapshots.read(
    `${origin}/api/clothing/by-category/1`,
    auth("inventory-a"),
  );
  snapshots = createAccountSnapshots({ store, fetcher });
  assert.equal(
    snapshots.inventory("Bearer other").sections["/api/clothing/by-category/1"],
    undefined,
  );
  assert.equal(
    snapshots.inventory("Bearer inventory-a").sections[
      "/api/clothing/by-category/1"
    ].items[0].owned,
    false,
  );
  assert.equal(calls.length, 2);
  await snapshots.read(`${origin}/api/me`, {
    headers: {
      Authorization: "Bearer inventory-a",
      "X-Madhouse-Snapshot-Refresh": "live",
    },
  });
  assert.deepEqual(snapshots.inventory("Bearer inventory-a").dirty, [
    "/api/clothing/by-category/1",
  ]);
  assert.equal(
    snapshots.inventory("Bearer inventory-a").sections[
      "/api/clothing/by-category/1"
    ].items[0].owned,
    false,
  );
  await snapshots.read(`${origin}/api/clothing/by-category/1`, {
    headers: {
      Authorization: "Bearer inventory-a",
      "X-Madhouse-Snapshot-Refresh": "live",
    },
  });
  assert.deepEqual(snapshots.inventory("Bearer inventory-a").dirty, []);
  assert.equal(
    snapshots.inventory("Bearer inventory-a").sections[
      "/api/clothing/by-category/1"
    ].items[0].owned,
    true,
  );
});

test("unclassified work writes invalidate conservatively; known weapon purchases stay scoped", async () => {
  const store = memoryStore();
  const { fetcher } = queueFetcher([
    reply({ playerId: 45, exp: { level: 7 } }),
    reply({ items: [{ id: 1, owned: false }] }),
    reply({ items: [{ id: 2, owned: false }] }),
    reply({ success: true }),
    reply({ items: [{ id: 1, owned: false }] }),
    reply({ items: [{ id: 2, owned: false }] }),
    reply({ success: true }),
  ]);
  const snapshots = createAccountSnapshots({ store, fetcher });
  await snapshots.read(`${origin}/api/me`, auth("inventory-b"));
  await snapshots.read(
    `${origin}/api/clothing/by-category/1`,
    auth("inventory-b"),
  );
  await snapshots.read(
    `${origin}/api/clothing/by-category/9`,
    auth("inventory-b"),
  );
  await snapshots.liveFetch(`${origin}/api/works/tasks/perform`, {
    ...auth("inventory-b"),
    method: "POST",
  });
  assert.deepEqual(snapshots.inventory("Bearer inventory-b").dirty, [
    "/api/clothing/by-category/1",
    "/api/clothing/by-category/9",
  ]);
  await snapshots.read(
    `${origin}/api/clothing/by-category/1`,
    auth("inventory-b"),
  );
  await snapshots.read(
    `${origin}/api/clothing/by-category/9`,
    auth("inventory-b"),
  );
  await snapshots.liveFetch(`${origin}/api/weapons/buy`, {
    ...auth("inventory-b"),
    method: "POST",
  });
  assert.deepEqual(snapshots.inventory("Bearer inventory-b").dirty, [
    "/api/clothing/by-category/1",
  ]);
  assert.ok(
    snapshots.inventory("Bearer inventory-b").sections[
      "/api/clothing/by-category/9"
    ],
  );
});

test("known weapon mutation invalidates weapon details; an unknown subroute invalidates all", async () => {
  const store = memoryStore();
  const queue = queueFetcher([
    reply({ playerId: 47 }),
    reply({ items: [{ id: 1, owned: false }] }),
    reply({ id: 12, durability: 4 }),
    reply({ id: 13, active: true }),
    reply({ catalog: { rooms: [{ id: 2, owned: true }] } }),
    reply({ success: true }),
    reply({ success: true }),
  ]);
  const snapshots = createAccountSnapshots({ store, fetcher: queue.fetcher });
  const authorization = auth("mutation-route-map");
  await snapshots.read(`${origin}/api/me`, authorization);
  await snapshots.read(`${origin}/api/clothing/by-category/1`, authorization);
  await snapshots.read(`${origin}/api/weapons/12`, authorization);
  await snapshots.read(`${origin}/api/pets/13`, authorization);
  await snapshots.read(`${origin}/api/rooms`, authorization);

  await snapshots.liveFetch(`${origin}/api/weapons/repair`, {
    ...authorization,
    method: "POST",
  });
  let sections = store.readSnapshots()[0].sections;
  assert.equal(sections["/api/clothing/by-category/1"].dirty, true);
  assert.equal(sections["/api/weapons/12"].dirty, true);
  assert.equal(sections["/api/pets/13"].dirty, undefined);
  assert.equal(sections["/api/rooms"].dirty, undefined);

  await snapshots.liveFetch(`${origin}/api/weapons/repair/12`, {
    ...authorization,
    method: "POST",
  });
  sections = store.readSnapshots()[0].sections;
  assert.ok(Object.values(sections).every((section) => section.dirty === true));
  assert.deepEqual(snapshots.inventory("Bearer mutation-route-map").dirty, [
    "/api/clothing/by-category/1",
    "/api/rooms",
  ]);
});

test("active battle strikes preserve inventory snapshots across restart; terminal or uncertain strikes mark them stale without hiding them", async () => {
  const store = memoryStore();
  const { fetcher, calls } = queueFetcher([
    reply({ playerId: 46, exp: { level: 7 } }),
    reply({ catalog: { rooms: [{ id: 1, owned: false, unlocked: true }] } }),
    reply({ battleFinished: false, battle: { status: "active" } }),
    reply({ battleFinished: true, battle: { status: "won" } }),
    reply({ success: true }),
  ]);
  let snapshots = createAccountSnapshots({ store, fetcher });
  const authorization = "Bearer inventory-c";
  await snapshots.read(`${origin}/api/me`, auth("inventory-c"));
  await snapshots.read(`${origin}/api/rooms`, auth("inventory-c"));
  await snapshots.liveFetch(`${origin}/api/bosses/battles/1/attack`, {
    ...auth("inventory-c"),
    method: "POST",
  });
  snapshots = createAccountSnapshots({ store, fetcher });
  assert.deepEqual(snapshots.inventory(authorization).dirty, []);
  assert.equal(
    snapshots.inventory(authorization).sections["/api/rooms"].catalog.rooms
      .length,
    1,
  );
  assert.equal(calls.length, 3);
  await snapshots.liveFetch(`${origin}/api/bosses/battles/1/attack`, {
    ...auth("inventory-c"),
    method: "POST",
  });
  assert.deepEqual(snapshots.inventory(authorization).dirty, ["/api/rooms"]);
  assert.equal(
    snapshots.inventory(authorization).sections["/api/rooms"].catalog.rooms
      .length,
    1,
  );
  await snapshots.liveFetch(`${origin}/api/bosses/battles/1/attack`, {
    ...auth("inventory-c"),
    method: "POST",
  });
  assert.deepEqual(snapshots.inventory(authorization).dirty, ["/api/rooms"]);
});
