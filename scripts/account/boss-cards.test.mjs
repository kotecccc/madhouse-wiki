import test from "node:test";
import assert from "node:assert/strict";
import { createBossCardsHttp } from "./boss-cards.mjs";

const authorization = "Bearer test-credential";
const boss = {
  numericId: 12,
  name: "Reference boss",
  possibleDrops: [
    { type: "weapon", itemId: 7, mode: "grant" },
    { type: "room", itemId: 9, mode: "unlock_for_purchase" },
  ],
};
const catalogue = {
  bosses: [boss, { numericId: 13, name: "Other boss", possibleDrops: [] }],
};

function harness({
  fetcher = async () => new Response("{}"),
  auth = async () => ({ credential: authorization }),
} = {}) {
  const reads = [];
  const health = [];
  const snapshots = {
    async read(url, init) {
      reads.push({
        url: new URL(url).pathname,
        headers: new Headers(init.headers),
      });
      return fetcher(url, init);
    },
    health(value) {
      health.push(value);
      return { status: "available", failedFeatures: [] };
    },
  };
  const handle = createBossCardsHttp({
    identify: auth,
    snapshots,
    getCatalogue: () => catalogue,
    origin: "https://wiki.example",
  });
  const request = (
    url = "https://wiki.example/api/automation/bosses",
    headers = {},
  ) =>
    handle(
      new Request(url, {
        headers: { Authorization: authorization, ...headers },
      }),
    );
  return { handle, request, reads, health };
}

test("aggregate reads each section through snapshot-only and returns shared card summary", async () => {
  const { request, reads, health } = harness({
    fetcher: async (url) =>
      new Response(
        JSON.stringify(
          new URL(url).pathname === "/api/clothing/by-category/1"
            ? { items: [{ id: 7, kind: "weapon", owned: true }] }
            : {
                catalog: { rooms: [{ id: 9, unlocked: false, owned: false }] },
              },
        ),
      ),
  });
  const response = await request();
  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "private, no-store, max-age=0",
  );
  const body = await response.json();
  assert.deepEqual(body.bosses[0].collection, {
    total: 2,
    collected: 1,
    known: 2,
    complete: false,
  });
  assert.deepEqual(reads.map(({ url }) => url).sort(), [
    "/api/clothing/by-category/1",
    "/api/rooms",
  ]);
  assert.ok(
    reads.every(
      ({ headers }) => headers.get("X-Madhouse-Snapshot-Only") === "1",
    ),
  );
  assert.deepEqual(health, [authorization]);
});

test("partial failures leave section state unknown", async () => {
  const { request } = harness({
    fetcher: async (url) =>
      new URL(url).pathname === "/api/rooms"
        ? new Response("failure", { status: 503 })
        : new Response(
            JSON.stringify({ items: [{ id: 7, kind: "weapon", owned: true }] }),
          ),
  });
  const body = await (await request()).json();
  assert.deepEqual(body.bosses[0].collection, {
    total: 2,
    collected: 1,
    known: 1,
    complete: false,
  });
});

test("auth, origin, method and query guards are strict", async () => {
  const h = harness({
    auth: async () => {
      throw Object.assign(new Error("secret detail"), { status: 401 });
    },
  });
  const denied = await h.request();
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "game_session_required" });
  assert.equal(
    (await h.request("https://wiki.example/api/automation/bosses?x=1")).status,
    400,
  );
  assert.equal(
    (
      await h.request("https://wiki.example/api/automation/bosses", {
        Origin: "https://evil.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await h.handle(
        new Request("https://wiki.example/api/automation/bosses", {
          method: "POST",
        }),
      )
    ).status,
    405,
  );
});

test("refresh header allows only a canonical catalogue boss and forces only its paths", async () => {
  const { request, reads } = harness();
  assert.equal(
    (await request(undefined, { "X-Madhouse-Refresh-Boss": "999" })).status,
    404,
  );
  const response = await request(undefined, {
    "X-Madhouse-Refresh-Boss": "12",
  });
  assert.equal(response.status, 200);
  const headersByPath = Object.fromEntries(
    reads.map(({ url, headers }) => [url, headers]),
  );
  assert.equal(
    headersByPath["/api/clothing/by-category/1"].has(
      "X-Madhouse-Snapshot-Only",
    ),
    false,
  );
  assert.equal(
    headersByPath["/api/rooms"].has("X-Madhouse-Snapshot-Only"),
    false,
  );
  assert.equal(
    (await request(undefined, { "X-Madhouse-Refresh-Boss": "12x" })).status,
    400,
  );
});

test("concurrent clients receive independently readable combined card responses", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    fetcher: async () => {
      await gate;
      return Response.json({ items: [] });
    },
  });
  const one = h.request();
  const two = h.request();
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  const responses = await Promise.all([one, two]);
  const bodies = await Promise.all(
    responses.map((response) => response.json()),
  );
  assert.deepEqual(bodies[0], bodies[1]);
  assert.equal(h.reads.length, 2);
});

test("combined boss cards reuse durable private sections after restart with no game traffic", async () => {
  const { createAccountSnapshots } = await import("./snapshots.mjs");
  const records = new Map();
  const store = {
    readSnapshots: () =>
      [...records.values()].map((record) => structuredClone(record)),
    writeSnapshot: (id, record) => records.set(id, structuredClone(record)),
    list: () => [],
  };
  let gameCalls = 0;
  let snapshots = createAccountSnapshots({
    store,
    fetcher: async (url) => {
      gameCalls++;
      const path = new URL(url).pathname;
      if (path === "/api/me") return Response.json({ playerId: 41 });
      if (path === "/api/rooms")
        return Response.json({ catalog: { rooms: [{ id: 9, owned: true }] } });
      return Response.json({ items: [{ weaponId: 7, owned: true }] });
    },
  });
  await snapshots.read("https://cargohustle.online/api/me", {
    headers: { Authorization: authorization },
  });
  const createHandle = () =>
    createBossCardsHttp({
      identify: async () => ({ credential: authorization }),
      snapshots,
      getCatalogue: () => catalogue,
    });
  const request = () =>
    new Request("https://wiki.example/api/automation/bosses", {
      headers: { Authorization: authorization },
    });
  const first = await (await createHandle()(request())).json();
  assert.equal(first.bosses[0].collection.complete, true);
  assert.equal(gameCalls, 3);
  snapshots = createAccountSnapshots({
    store,
    fetcher: async () => {
      throw new Error("game must not be called");
    },
  });
  const restored = await (await createHandle()(request())).json();
  assert.deepEqual(restored.bosses, first.bosses);
  assert.equal(gameCalls, 3);
  assert.ok(!JSON.stringify(restored).includes(authorization));
});
