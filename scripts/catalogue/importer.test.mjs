import assert from "node:assert/strict";
import test from "node:test";
import { legacyDirectRouteResolver } from "../bridge/game-api-client.mjs";
import { importCatalogue } from "./importer.mjs";

const authorization = "Bearer catalogue-import-fixture";
const deviceId = "00000000-0000-4000-8000-000000000001";

function createStore() {
  const captures = [];
  const metadataWrites = [];
  let reportCount = 0;
  return {
    db: {
      prepare(query) {
        return {
          get: () => undefined,
          all: () => [],
          run: (...values) => metadataWrites.push({ query, values }),
        };
      },
    },
    capture: (...values) => captures.push(values),
    report: () => reportCount++,
    get captures() {
      return captures;
    },
    get metadataWrites() {
      return metadataWrites;
    },
    get reportCount() {
      return reportCount;
    },
  };
}

test("catalogue importer requires an explicit route resolver", async () => {
  const store = createStore();
  let directCalls = 0;

  await assert.rejects(
    importCatalogue(store, authorization, async () => {
      directCalls++;
      return Response.json([]);
    }),
    (error) => error.message === "game_route_resolver_required",
  );

  assert.equal(directCalls, 0);
  assert.deepEqual(store.captures, []);
});

test("catalogue importer uses selected bridge reads and fails closed on unreviewed calls", async () => {
  const store = createStore();
  const directCalls = [];
  const bridgeCalls = [];

  await assert.rejects(
    importCatalogue(
      store,
      authorization,
      async (input) => {
        directCalls.push(String(input));
        return Response.json([]);
      },
      {
        resolveRoute: async () => ({
          policy: "bridge_required",
          routeEpoch: 1,
          activeDeviceId: deviceId,
        }),
        bridgeTransport: async ({ path }) => {
          bridgeCalls.push(path);
          return Response.json([]);
        },
      },
    ),
    { code: "bridge_effect_policy_unknown" },
  );

  assert.deepEqual(bridgeCalls, [
    "/api/floors",
    "/api/clothing",
    "/api/rooms",
    "/api/stash/sets",
  ]);
  assert.deepEqual(directCalls, []);
  assert.equal(store.metadataWrites.length, 0);
  assert.equal(store.reportCount, 1);
});

test("catalogue importer retains an explicitly selected direct route", async () => {
  const store = createStore();
  const directCalls = [];

  await importCatalogue(
    store,
    authorization,
    async (input) => {
      directCalls.push(String(input));
      return Response.json({ error: "fixture_unauthorized" }, { status: 401 });
    },
    { resolveRoute: legacyDirectRouteResolver },
  );

  assert.deepEqual(directCalls, ["https://cargohustle.online/api/floors"]);
  assert.equal(store.captures[0][0], "/api/floors");
  assert.equal(store.captures[0][1], 401);
  assert.equal(store.metadataWrites.length, 0);
  assert.equal(store.reportCount, 1);
});
