import test from "node:test";
import assert from "node:assert/strict";
import {
  createBossBattleController,
  canUseMedicine,
  canAttackBattle,
} from "../src/features/bosses/BossBattle/boss-battle-controller.js";
import {
  normalizeMedicines,
  medicinePurchaseQuote,
} from "../src/features/bosses/BossBattle/boss-medicines.js";
import { createBossBattleRequest } from "../src/features/bosses/BossBattle/boss-battle-session.js";

const boss = { numericId: 7, name: "Тестовый босс" };
const battle = (patch = {}) => ({
  battleId: "battle-1",
  bossId: 7,
  status: "active",
  playerHealth: 50,
  playerMaxHealth: 100,
  bossHealth: 200,
  bossMaxHealth: 200,
  ...patch,
});
const bag = (patch = {}) => ({
  combatItems: [
    {
      type: "heal_10",
      quantity: 2,
      maxPurchaseQuantity: 10,
      prices: [
        { currency: "gold", amount: 20 },
        { currency: "pills", amount: 3 },
      ],
      ...patch,
    },
    {
      type: "heal_full",
      quantity: 0,
      maxPurchaseQuantity: 5,
      prices: [{ currency: "gold", amount: 100 }],
    },
    { type: "howl", quantity: 5, prices: [] },
  ],
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function setup(options = {}) {
  const calls = [];
  let nextId = 0;
  const server = { battle: battle(), bag: bag(), ...options };
  const store = createBossBattleController({
    operationId: () => `op-${++nextId}`,
    request: async (method, path, body, requestOptions) => {
      calls.push({ method, path, body, signal: requestOptions.signal });
      if (server.intercept) {
        const intercepted = await server.intercept(method, path, body);
        if (intercepted !== undefined) return intercepted;
      }
      if (method === "GET") {
        if (path === "/api/bosses/7")
          return { id: 7, activeBattle: structuredClone(server.battle) };
        if (path === "/api/me/bag") return structuredClone(server.bag);
        return structuredClone(server.battle);
      }
      if (path.endsWith("/items/use")) {
        server.bag.combatItems.find((i) => i.type === body.type).quantity--;
        server.battle.playerHealth = 75;
        return { battle: structuredClone(server.battle) };
      }
      if (path.endsWith("/buy")) {
        server.bag.combatItems.find((i) => i.type === body.type).quantity +=
          body.quantity;
        return null;
      }
      throw new Error("Unexpected request");
    },
  });
  store.open(boss);
  await settle();
  await store.openMedicines();
  return {
    store,
    server,
    calls,
    posts: () => calls.filter((c) => c.method === "POST"),
  };
}

test("medicine projection keeps only supported items and nonambiguous integer quotes", () => {
  const items = normalizeMedicines(bag());
  assert.deepEqual(
    items.map((i) => i.type),
    ["heal_10", "heal_full"],
  );
  assert.deepEqual(medicinePurchaseQuote(items, "heal_10", "gold", 3), {
    type: "heal_10",
    currency: "gold",
    quantity: 3,
    unitPrice: 20,
    total: 60,
  });
  for (const quantity of [0, -1, 1.5, 11, NaN, Infinity])
    assert.equal(
      medicinePurchaseQuote(items, "heal_10", "gold", quantity),
      null,
    );
  assert.equal(medicinePurchaseQuote(items, "howl", "gold", 1), null);
  assert.equal(medicinePurchaseQuote(items, "heal_10", "dollar", 1), null);
  assert.equal(normalizeMedicines({}), null);
  assert.equal(normalizeMedicines(bag({ quantity: -1 }))[0].quantity, null);
  const ambiguous = normalizeMedicines(
    bag({
      prices: [
        { currency: "gold", amount: 20 },
        { currency: "gold", amount: 25 },
      ],
    }),
  );
  assert.equal(medicinePurchaseQuote(ambiguous, "heal_10", "gold", 1), null);
});

test("medicine panel blocks attacks and use reconciles health and stock without buying", async () => {
  const { store, posts } = await setup();
  assert.equal(canAttackBattle(store.getSnapshot()), false);
  await store.attack();
  await store.useMedicine("heal_10");
  assert.deepEqual(
    posts().map((c) => c.body),
    [{ type: "heal_10", operationId: "op-1" }],
  );
  assert.equal(store.getSnapshot().battle.playerHealth, 75);
  assert.equal(store.getSnapshot().medicines[0].quantity, 1);
  assert.equal(store.getSnapshot().needsRefresh, false);
  store.closeMedicines();
  assert.equal(canAttackBattle(store.getSnapshot()), true);
});

test("full health, no stock, cooldown and unsupported item types never send use", async () => {
  for (const patch of [
    { playerHealth: 100 },
    { playerHealth: 0 },
    { retryAfterMilliseconds: 60000 },
    { status: "won" },
  ]) {
    const { store, posts } = await setup({ battle: battle(patch) });
    await store.useMedicine("heal_10");
    assert.equal(posts().length, 0);
  }
  const { store, posts } = await setup();
  await store.useMedicine("heal_full");
  await store.useMedicine("howl");
  assert.equal(posts().length, 0);
});

test("use preflight notices externally consumed stock or completed battle before POST", async () => {
  for (const change of [
    ({ server }) => {
      server.bag.combatItems[0].quantity = 0;
    },
    ({ server }) => {
      server.battle.status = "won";
    },
  ]) {
    const fixture = await setup();
    change(fixture);
    await fixture.store.useMedicine("heal_10");
    assert.equal(fixture.posts().length, 0);
    assert.equal(fixture.store.getSnapshot().needsRefresh, false);
  }
});

test("purchase requires explicit review, sends exact currency and quantity, and never applies automatically", async () => {
  const { store, posts } = await setup();
  await store.buyMedicine();
  assert.equal(posts().length, 0);
  store.preparePurchase("heal_10", "pills", 3);
  assert.equal(store.getSnapshot().purchase.total, 9);
  assert.equal(canUseMedicine(store.getSnapshot(), "heal_10"), false);
  await store.buyMedicine();
  assert.deepEqual(
    posts().map((c) => c.body),
    [{ type: "heal_10", currency: "pills", quantity: 3, operationId: "op-1" }],
  );
  assert.equal(store.getSnapshot().medicines[0].quantity, 5);
  assert.equal(store.getSnapshot().battle.playerHealth, 50);
  assert.equal(store.getSnapshot().purchase, null);
  assert.equal(store.getSnapshot().purchaseUncertain, false);
});

test("price changes, missing prices, smaller limit or battle ending invalidate the purchase review", async () => {
  for (const change of [
    (server) => {
      server.bag.combatItems[0].prices[0].amount = 21;
    },
    (server) => {
      server.bag.combatItems[0].prices = [];
    },
    (server) => {
      server.bag.combatItems[0].maxPurchaseQuantity = 1;
    },
    (server) => {
      server.battle.status = "won";
    },
  ]) {
    const { store, server, posts } = await setup();
    store.preparePurchase("heal_10", "gold", 2);
    change(server);
    await store.buyMedicine();
    assert.equal(posts().length, 0);
    assert.equal(store.getSnapshot().purchase, null);
    assert.match(store.getSnapshot().notice, /изменились/);
  }
});

test("one pending action prevents duplicate purchases, healing and strikes", async () => {
  let release;
  const { store, posts } = await setup({
    intercept: (method, path) => {
      if (method === "POST" && path.endsWith("/buy"))
        return new Promise((resolve) => {
          release = () => resolve(null);
        });
    },
  });
  store.preparePurchase("heal_10", "gold", 1);
  const purchase = store.buyMedicine();
  await settle();
  await store.buyMedicine();
  await store.useMedicine("heal_10");
  await store.attack();
  assert.equal(posts().length, 1);
  release();
  await purchase;
});

test("lost purchase response freezes further purchases until refreshed stock is explicitly acknowledged", async () => {
  const { store, server, posts } = await setup({
    intercept: (method) => {
      if (method === "POST") throw new Error("lost response");
    },
  });
  store.preparePurchase("heal_10", "gold", 1);
  await store.buyMedicine();
  assert.equal(store.getSnapshot().purchaseUncertain, true);
  assert.equal(store.getSnapshot().medicines, null);
  await store.buyMedicine();
  store.preparePurchase("heal_10", "gold", 1);
  assert.equal(store.getSnapshot().purchase, null);
  // The fight can end while the result of the purchase remains unknown.
  server.battle.status = "won";
  await store.refresh();
  assert.equal(store.getSnapshot().medicineOpen, true);
  assert.equal(store.getSnapshot().purchaseUncertain, true);
  store.acknowledgePurchase();
  assert.equal(store.getSnapshot().purchaseUncertain, false);
  assert.equal(posts().length, 1);
});

test("successful purchase response alone is not enough when stock did not increase", async () => {
  const { store, posts } = await setup({
    intercept: (method, path) =>
      method === "POST" && path.endsWith("/buy") ? null : undefined,
  });
  store.preparePurchase("heal_10", "gold", 1);
  await store.buyMedicine();
  assert.equal(store.getSnapshot().purchaseUncertain, true);
  assert.equal(posts().length, 1);
});

test("session reset during purchase preflight discards inventory and cancels later POST", async () => {
  const { store, server, posts } = await setup();
  store.preparePurchase("heal_10", "gold", 1);
  let release;
  server.intercept = (method, path) =>
    method === "GET" && path.includes("/battles/")
      ? new Promise((resolve) => {
          release = resolve;
        })
      : undefined;
  const purchase = store.buyMedicine();
  await settle();
  store.reset();
  release(battle());
  await purchase;
  assert.equal(posts().length, 0);
  assert.equal(store.getSnapshot().medicines, null);
  assert.equal(store.getSnapshot().purchase, null);
});

test("missing inventory and prices cannot authorize spending", async () => {
  const { store, posts } = await setup({ bag: {} });
  store.preparePurchase("heal_10", "gold", 1);
  await store.buyMedicine();
  await store.useMedicine("heal_10");
  assert.equal(posts().length, 0);
});

test("transport accepts medkit routes without reading undocumented purchase response", async () => {
  const calls = [];
  const request = createBossBattleRequest({
    authorize: (r) => ({ ...r, headers: { Authorization: "test-only" } }),
    fetcher: async (path, options) => {
      calls.push({ path, options });
      return {
        ok: true,
        json: () => {
          if (path.endsWith("/buy")) throw new Error("undocumented body");
          return {};
        },
      };
    },
  });
  await request("GET", "/api/me/bag");
  await request("POST", "/api/bosses/battles/battle-1/items/use", {
    type: "heal_10",
    operationId: "test",
  });
  await request("POST", "/api/me/bag/combat-items/buy", {
    type: "heal_10",
    currency: "gold",
    quantity: 1,
    operationId: "test",
  });
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0].options.headers["X-Madhouse-Allow-Mutations"],
    undefined,
  );
  assert.equal(calls[2].options.headers["X-Madhouse-Allow-Mutations"], "true");
  await assert.rejects(request("POST", "/api/me/bag/boosters/buy", {}));
  assert.equal(calls.length, 3);
});

test("buying an out-of-stock medkit and using it are distinct explicit actions", async () => {
  const { store, posts } = await setup();
  store.preparePurchase("heal_full", "gold", 2);
  await store.buyMedicine();
  assert.equal(store.getSnapshot().medicines[1].quantity, 2);
  assert.equal(store.getSnapshot().battle.playerHealth, 50);
  await store.useMedicine("heal_full");
  assert.equal(store.getSnapshot().medicines[1].quantity, 1);
  assert.deepEqual(
    posts().map((c) => c.path),
    ["/api/me/bag/combat-items/buy", "/api/bosses/battles/battle-1/items/use"],
  );
  assert.notEqual(posts()[0].body.operationId, posts()[1].body.operationId);
});

test("unknown purchase cannot be obscured by consuming stock before acknowledgement", async () => {
  const { store, posts } = await setup({
    intercept: (method) => {
      if (method === "POST") throw new Error("lost response");
    },
  });
  store.preparePurchase("heal_10", "gold", 1);
  await store.buyMedicine();
  await store.refresh();
  assert.equal(canUseMedicine(store.getSnapshot(), "heal_10"), false);
  await store.useMedicine("heal_10");
  assert.equal(posts().length, 1);
});

for (const action of ["heal", "buy"])
  test(`a replaced battle cancels ${action} before spending resources`, async () => {
    const { store, server, posts } = await setup();
    if (action === "buy") store.preparePurchase("heal_10", "gold", 1);
    server.battle = battle({ battleId: "battle-2" });
    server.intercept = (method, path) => {
      if (method === "GET" && path === "/api/bosses/battles/battle-1") {
        const error = new Error("old battle removed");
        error.status = 404;
        throw error;
      }
    };
    if (action === "heal") await store.useMedicine("heal_10");
    else await store.buyMedicine();
    assert.equal(posts().length, 0);
    assert.equal(store.getSnapshot().battle.id, "battle-2");
  });
