import test from "node:test";
import assert from "node:assert/strict";
import { createBossCardsHttp } from "./boss-cards.mjs";

const authorization = "Bearer test-credential";
const catalogue = {
  bosses: [
    {
      numericId: 12,
      possibleDrops: [
        { type: "weapon", itemId: 7, mode: "grant" },
        { type: "ornament", elementId: 2, zoneId: 4, mode: "grant" },
      ],
    },
  ],
};

function harness(sections = {}) {
  const credentials = [];
  const handle = createBossCardsHttp({
    identify: async () => ({ credential: authorization }),
    snapshots: {
      inventory(credential) {
        credentials.push(credential);
        return { sections };
      },
      health: () => ({ status: "available", failedFeatures: [] }),
    },
    getCatalogue: () => catalogue,
    origin: "https://wiki.example",
    canonicalCredential: () => "Bearer canonical",
  });
  const request = (headers = {}) =>
    handle(
      new Request("https://wiki.example/api/automation/bosses", {
        headers: { Authorization: authorization, ...headers },
      }),
    );
  return { handle, request, credentials };
}

test("boss cards use only saved inventory, including after a battle refresh", async () => {
  const h = harness({
    "/api/clothing/by-category/1": {
      items: [{ id: 7, kind: "weapon", owned: true }],
    },
    "/api/ornaments/zones/4": { items: [{ id: 2, owned: true }] },
  });
  const body = await (
    await h.request({ "X-Madhouse-Refresh-Boss": "12" })
  ).json();
  assert.equal(body.bosses[0].collection.known, 2);
  assert.deepEqual(h.credentials, ["Bearer canonical"]);
});

test("missing inventory stays unknown without a game read", async () => {
  const h = harness();
  const body = await (await h.request()).json();
  assert.equal(body.bosses[0].collection.known, 0);
  assert.equal(body.bosses[0].collection.complete, false);
});

test("boss cards reject invalid refresh identifiers, origins and methods", async () => {
  const h = harness();
  assert.equal(
    (await h.request({ "X-Madhouse-Refresh-Boss": "999" })).status,
    404,
  );
  assert.equal(
    (await h.request({ "X-Madhouse-Refresh-Boss": "12x" })).status,
    400,
  );
  assert.equal(
    (await h.request({ Origin: "https://evil.example" })).status,
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

test("saved inventory survives restart and boss cards never fetch missing sections", async () => {
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
      return new URL(url).pathname === "/api/me"
        ? Response.json({ playerId: 41 })
        : Response.json({ items: [{ id: 7, kind: "weapon", owned: true }] });
    },
  });
  const headers = { Authorization: authorization };
  await snapshots.read("https://cargohustle.online/api/me", { headers });
  await snapshots.read(
    "https://cargohustle.online/api/clothing/by-category/1",
    { headers },
  );
  snapshots = createAccountSnapshots({
    store,
    fetcher: async () => {
      throw new Error("unexpected game read");
    },
  });
  const handle = createBossCardsHttp({
    identify: async () => ({ credential: authorization }),
    snapshots,
    getCatalogue: () => catalogue,
  });
  const body = await (
    await handle(
      new Request("https://wiki.example/api/automation/bosses", { headers }),
    )
  ).json();
  assert.equal(body.bosses[0].collection.known, 1);
  assert.equal(gameCalls, 2);
  assert.ok(!JSON.stringify(body).includes(authorization));
});
