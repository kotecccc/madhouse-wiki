import assert from "node:assert/strict";
import test from "node:test";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import { createAccountDataService } from "../scripts/account/data-service.mjs";
import { createDirectBoundary } from "../scripts/game/direct-boundary.mjs";

test("logical cache, join and stored results correlate safely with physical attempts", async () => {
  const rows = new Map();
  const store = {
    readSnapshots: () => [...rows.values()],
    writeSnapshot: (id, value) => rows.set(String(id), structuredClone(value)),
    list: () => [],
  };
  let release;
  let calls = 0;
  const boundary = createDirectBoundary({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
    },
    fetcher: async () => {
      calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
      return Response.json({ owned: true });
    },
  });
  try {
    const snapshots = createAccountSnapshots({
      store,
      fetcher: boundary.request,
    });
    const authorization = "Bearer very-secret-token";
    snapshots.saveBridgeProfile(authorization, { playerId: 42 });
    const events = [];
    const data = createAccountDataService({
      transport: snapshots,
      snapshots,
      onDiagnostic: (event) => events.push(event),
    });
    const url = "https://cargohustle.online/api/weapons/123";
    const options = {
      headers: { Authorization: authorization },
      gameSource: "proxy",
    };
    const first = data.fetch(url, options);
    const second = data.fetch(url, options);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    const attempts = boundary
      .diagnostics()
      .recent.filter((event) => event.outcome === "response");
    assert.equal(attempts.length, 1);
    assert.equal(events.length, 2);
    assert.equal(events[0].correlation, attempts[0].correlation);
    assert.equal(events[1].correlation, attempts[0].correlation);
    assert.deepEqual(
      new Set(events.map((event) => event.cache)),
      new Set(["network", "joined"]),
    );
    await data.fetch(url, options);
    await data.readStored(url, options);
    assert.equal(calls, 1);
    assert.deepEqual(
      events.slice(2).map((event) => event.cache),
      ["stale", "stale"],
    );
    assert.ok(events.every((event) => event.resource === "/api/weapons/:id"));
    assert.doesNotMatch(
      JSON.stringify({ events, attempts }),
      /very-secret-token|123|owned/,
    );
  } finally {
    boundary.close();
  }
});

test("joined consumers retain separate dispatch guards", async () => {
  const rows = new Map();
  const store = {
    readSnapshots: () => [...rows.values()],
    writeSnapshot: (id, value) => rows.set(String(id), structuredClone(value)),
    list: () => [],
  };
  let calls = 0;
  const boundary = createDirectBoundary({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
    },
    fetcher: async () => {
      calls++;
      return Response.json({ owned: true });
    },
  });
  try {
    const snapshots = createAccountSnapshots({
      store,
      fetcher: boundary.request,
    });
    const authorization = "Bearer guard-test";
    snapshots.saveBridgeProfile(authorization, { playerId: 42 });
    const data = createAccountDataService({ transport: snapshots, snapshots });
    const url = "https://cargohustle.online/api/weapons/123";
    const headers = { Authorization: authorization };
    const denied = data.fetch(url, { headers, canDispatch: () => false });
    const allowed = data.fetch(url, { headers, canDispatch: () => true });
    const [first, second] = await Promise.allSettled([denied, allowed]);
    assert.equal(first.status, "rejected");
    assert.equal(first.reason.code, "game_route_changed");
    assert.equal(second.status, "fulfilled");
    assert.deepEqual(await second.value.json(), { owned: true });
    assert.equal(calls, 1);
  } finally {
    boundary.close();
  }
});

test("two verified credentials for the same account share a read", async () => {
  const rows = new Map();
  const store = {
    readSnapshots: () => [...rows.values()],
    writeSnapshot: (id, value) => rows.set(String(id), structuredClone(value)),
    list: () => [],
  };
  let release;
  let calls = 0;
  const snapshots = createAccountSnapshots({
    store,
    fetcher: async () => {
      calls++;
      await new Promise((resolve) => {
        release = resolve;
      });
      return Response.json({ owned: true });
    },
  });
  snapshots.saveBridgeProfile("Bearer first-credential", { playerId: 42 });
  snapshots.saveBridgeProfile("Bearer second-credential", { playerId: 42 });
  const data = createAccountDataService({ transport: snapshots, snapshots });
  const url = "https://cargohustle.online/api/weapons/123";
  const first = data.fetch(url, {
    headers: { Authorization: "Bearer first-credential" },
  });
  const second = data.fetch(url, {
    headers: { Authorization: "Bearer second-credential" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(calls, 1);
});

test("unshared worker reads enforce their guard even on a saved snapshot", async () => {
  const rows = new Map();
  const store = {
    readSnapshots: () => [...rows.values()],
    writeSnapshot: (id, value) => rows.set(String(id), structuredClone(value)),
    list: () => [],
  };
  let calls = 0;
  const snapshots = createAccountSnapshots({
    store,
    fetcher: async () => {
      calls++;
      return Response.json({ owned: true });
    },
  });
  const authorization = "Bearer worker-guard";
  snapshots.saveBridgeProfile(authorization, { playerId: 42 });
  const data = createAccountDataService({ transport: snapshots, snapshots });
  const url = "https://cargohustle.online/api/weapons/123";
  const headers = { Authorization: authorization };
  await data.fetch(url, { headers });
  await assert.rejects(
    data.fetch(url, {
      headers,
      gameSource: "automation",
      canDispatch: () => false,
    }),
    { code: "game_route_changed" },
  );
  const allowed = await data.fetch(url, {
    headers,
    gameSource: "automation",
    canDispatch: () => true,
  });
  assert.deepEqual(await allowed.json(), { owned: true });
  assert.equal(calls, 1);
});
