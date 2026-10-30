import test from "node:test";
import assert from "node:assert/strict";
import { inventoryGame } from "../../tests/helpers/inventory-game.mjs";
import { inventoryAction } from "./inventory-actions.mjs";
function context(options = {}) {
  const entry = { credential: "Bearer fake", equipment: { pending: null } };
  const saved = [];
  const game = inventoryGame({
    ...options,
    beforeMutation: () => {
      assert.ok(saved.at(-1)?.pending);
      assert.ok(entry.equipment.pending);
    },
  });
  const save = () => saved.push(structuredClone(entry.equipment));
  const run = (args, refreshOnly = false) =>
    inventoryAction({
      entry,
      args,
      commandId: "command123",
      refreshOnly,
      fetcher: game.fetcher,
      save,
      makeOperationId: () => "operation123",
    });
  return { entry, game, saved, save, run };
}
const definitions = [
  ["weapon", 1, "weaponId", "/api/weapons", "PUT"],
  ["pet", 2, "petId", "/api/pets", "PUT"],
  ["room", 3, "roomId", "/api/rooms", "PUT"],
  ["clothing_item", 4, "itemId", "/api/clothing", "POST"],
  ["ornament", 5, "elementId", "/api/ornaments", "POST"],
];
test("read-only clothing category inspection validates the returned category", async () => {
  const entry = { credential: "Bearer fake", equipment: { pending: null } };
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ path: new URL(url).pathname, method: init.method ?? "GET" });
    return Response.json({
      categoryId: 5,
      items: [{ id: 364, categoryId: 5, owned: true }],
    });
  };
  await inventoryAction({
    entry,
    args: { type: "clothing_item", categoryId: 5 },
    commandId: "category-read-1",
    refreshOnly: true,
    fetcher,
    save() {},
  });
  assert.deepEqual(calls, [
    { path: "/api/clothing/by-category/5", method: "GET" },
  ]);
  await assert.rejects(
    inventoryAction({
      entry,
      args: { type: "clothing_item", categoryId: 4 },
      commandId: "category-read-2",
      refreshOnly: true,
      fetcher,
      save() {},
    }),
    /inventory_unavailable/,
  );
  assert.equal(
    calls.every(({ method }) => method === "GET"),
    true,
  );
});
test("category inspection cannot bypass an uncertain clothing checkpoint", async () => {
  const pending = {
    id: "prior",
    type: "clothing_item",
    entityId: 364,
    action: "equip",
  };
  const entry = { credential: "Bearer fake", equipment: { pending } };
  const calls = [];
  const result = await inventoryAction({
    entry,
    args: { type: "clothing_item", categoryId: 5 },
    commandId: "category-read-3",
    refreshOnly: true,
    fetcher: async (url) => {
      calls.push(new URL(url).pathname);
      return Response.json({
        catalog: { sets: [{ items: [{ id: 364, equipped: false }] }] },
      });
    },
    save() {},
  });
  assert.deepEqual(calls, ["/api/clothing"]);
  assert.equal(result.pending, true);
  assert.deepEqual(entry.equipment.pending, pending);
});
test("clothing equips and confirms using only its verified category", async () => {
  const ctx = context({ owned: true });
  await ctx.run({
    type: "clothing_item",
    id: 4,
    categoryId: 3,
    action: "equip",
  });
  assert.deepEqual(
    ctx.game.calls.map(({ method, path }) => ({ method, path })),
    [
      { method: "GET", path: "/api/clothing/by-category/3" },
      { method: "POST", path: "/api/clothing/equip" },
      { method: "GET", path: "/api/clothing/by-category/3" },
    ],
  );
  assert.deepEqual(ctx.game.mutations()[0].body, { itemId: 4 });
  assert.equal(ctx.entry.equipment.pending, null);
  assert.equal(ctx.game.items.clothing_item.equipped, true);
});
for (const [type, id, idKey, prefix, equipMethod] of definitions) {
  test(`${type}: purchase uses fresh quote, exact body and confirmed ownership`, async () => {
    const ctx = context();
    await ctx.run({
      type,
      id,
      zoneId: 4,
      action: "buy",
      price: { amount: 100, currency: "gold" },
    });
    const mutation = ctx.game.mutations()[0];
    assert.equal(mutation.method, "POST");
    assert.deepEqual(mutation.body, {
      [idKey]: id,
      operationId: "operation123",
    });
    assert.ok(mutation.path.startsWith(prefix));
    assert.equal(ctx.game.items[type].owned, true);
    assert.equal(ctx.entry.equipment.pending, null);
    assert.equal(ctx.game.mutations().length, 1);
  });
  test(`${type}: selecting owned item uses its evidenced API transport`, async () => {
    const ctx = context({ owned: true });
    await ctx.run({ type, id, zoneId: 4, action: "equip" });
    assert.equal(ctx.game.mutations()[0].method, equipMethod);
    assert.deepEqual(ctx.game.mutations()[0].body, { [idKey]: id });
    assert.equal(ctx.game.items[type].equipped, true);
    if (type !== "room") {
      await ctx.run({ type, id, zoneId: 4, action: "unequip" });
      const removal = ctx.game.mutations()[1];
      assert.equal(removal.method, "DELETE");
      assert.equal(removal.body, undefined);
      assert.equal(ctx.game.items[type].equipped, false);
      if (["clothing_item", "ornament"].includes(type))
        assert.ok(removal.path.endsWith(`/${id}`));
    }
  });
}
test("changed quotes, missing balance, unowned selection and locked purchase never submit", async () => {
  const ctx = context();
  await assert.rejects(
    ctx.run({
      type: "weapon",
      id: 1,
      action: "buy",
      price: { amount: 99, currency: "gold" },
    }),
    /price_changed/,
  );
  await assert.rejects(
    ctx.run({ type: "weapon", id: 1, action: "equip" }),
    /not_owned/,
  );
  ctx.game.items.weapon.unlocked = false;
  await assert.rejects(
    ctx.run({
      type: "weapon",
      id: 1,
      action: "buy",
      price: { amount: 100, currency: "gold" },
    }),
    /not_buyable/,
  );
  ctx.game.items.weapon.unlocked = true;
  ctx.game.wallet.gold = undefined;
  await assert.rejects(
    ctx.run({
      type: "weapon",
      id: 1,
      action: "buy",
      price: { amount: 100, currency: "gold" },
    }),
    /balance_unknown/,
  );
  assert.equal(ctx.game.mutations().length, 0);
});
test("repair requires broken ownership and authoritative pill quote, and confirms restored durability", async () => {
  const ctx = context({ owned: true, broken: true, cost: 35 });
  await ctx.run({
    type: "weapon",
    id: 1,
    action: "repair",
    price: { amount: 35, currency: "pills" },
  });
  assert.deepEqual(ctx.game.mutations()[0], {
    path: "/api/weapons/repair",
    method: "POST",
    body: { weaponId: 1, operationId: "operation123" },
  });
  assert.equal(ctx.game.items.weapon.durability.current, 90);
  assert.equal(ctx.entry.equipment.pending, null);
  await assert.rejects(
    ctx.run({
      type: "weapon",
      id: 1,
      action: "repair",
      price: { amount: 0, currency: "pills" },
    }),
    /not_broken/,
  );
});
test("lost replies and confirmation reads remain pending and never replay automatically", async () => {
  for (const option of [{ failMutation: true }, { failConfirmation: true }]) {
    const ctx = context(option);
    const args = {
      type: "weapon",
      id: 1,
      action: "buy",
      price: { amount: 100, currency: "gold" },
    };
    await assert.rejects(ctx.run(args));
    assert.ok(ctx.entry.equipment.pending);
    assert.equal(ctx.entry.equipment.pending.operationId, "operation123");
    await assert.rejects(ctx.run(args), /uncertain/);
    assert.equal(ctx.game.mutations().length, 1);
  }
});
test("explicit read-only reconciliation clears a lost purchase after ownership confirms", async () => {
  const ctx = context({ failMutation: true });
  await assert.rejects(
    ctx.run({
      type: "ornament",
      id: 5,
      zoneId: 4,
      action: "buy",
      price: { amount: 100, currency: "gold" },
    }),
  );
  ctx.game.items.ornament.owned = true;
  const result = await ctx.run({ type: "ornament" }, true);
  assert.equal(result.pending, false);
  assert.equal(ctx.entry.equipment.pending, null);
  assert.deepEqual(ctx.entry.equipment.paths, ["/api/ornaments/zones/4"]);
  assert.equal(ctx.game.mutations().length, 1);
});

test("a successful refresh without the expected purchase effect keeps the checkpoint", async () => {
  const ctx = context({ failMutation: true });
  await assert.rejects(
    ctx.run({
      type: "weapon",
      id: 1,
      action: "buy",
      price: { amount: 100, currency: "gold" },
    }),
  );
  const checkpoint = structuredClone(ctx.entry.equipment.pending);
  const result = await ctx.run({ type: "weapon" }, true);
  assert.equal(result.item.owned, false);
  assert.equal(result.pending, true);
  assert.deepEqual(ctx.entry.equipment.pending, checkpoint);
  await assert.rejects(
    ctx.run({
      type: "weapon",
      id: 1,
      action: "buy",
      price: { amount: 100, currency: "gold" },
    }),
    /uncertain/,
  );
  assert.equal(ctx.game.mutations().length, 1);
});
test("refresh cannot infer an unequip from a legacy checkpoint with no action", async () => {
  const ctx = context({ owned: true, equipped: false });
  ctx.entry.equipment = { pending: { weaponId: 1 }, checked: false };
  const result = await ctx.run({ type: "weapon" }, true);
  assert.equal(result.pending, true);
  assert.deepEqual(ctx.entry.equipment.pending, { weaponId: 1 });
});
test("failed reconciliation keeps the pending purchase and never submits it again", async () => {
  const ctx = context({ failMutation: true });
  const args = {
    type: "weapon",
    id: 1,
    action: "buy",
    price: { amount: 100, currency: "gold" },
  };
  await assert.rejects(ctx.run(args));
  const checkpoint = structuredClone(ctx.entry.equipment.pending);
  await assert.rejects(
    inventoryAction({
      entry: ctx.entry,
      args: { type: "weapon" },
      commandId: "refresh123",
      refreshOnly: true,
      fetcher: async () => {
        throw new Error("offline");
      },
      save: ctx.save,
    }),
  );
  assert.deepEqual(ctx.entry.equipment.pending, checkpoint);
  assert.equal(ctx.game.mutations().length, 1);
});
test("storage failures and stale snapshots cannot authorize inventory mutations", async () => {
  const stale = context({ stale: true });
  await assert.rejects(
    stale.run({
      type: "weapon",
      id: 1,
      action: "buy",
      price: { amount: 100, currency: "gold" },
    }),
    /unavailable/,
  );
  assert.equal(stale.game.mutations().length, 0);
  const ctx = context({ owned: true });
  await assert.rejects(
    inventoryAction({
      entry: ctx.entry,
      args: { type: "weapon", id: 1, action: "equip" },
      commandId: "x",
      fetcher: ctx.game.fetcher,
      save: () => {
        ctx.entry.storageFailed = true;
      },
    }),
    /storage_unavailable/,
  );
  assert.equal(ctx.game.mutations().length, 0);
});

test("service reconciles an earlier purchase before a new inventory action without replaying it", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "inventory-auto-reconcile-"));
  const game = inventoryGame({ owned: true });
  const service = createAutomationService({
    store: createAutomationStateStore({ directory }),
    fetcher: game.fetcher,
    identifyPlayer: async () => ({ playerId: 17 }),
    getBoss: (id) => ({ numericId: id }),
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    entry.equipment = {
      pending: {
        id: "old-purchase",
        type: "weapon",
        entityId: 1,
        action: "buy",
      },
      checked: false,
    };
    const result = await service.command(entry, {
      id: "new-equip-command",
      expectedVersion: service.snapshot(entry).version,
      command: "inventory.action",
      args: { type: "weapon", id: 1, action: "equip" },
    });
    assert.equal(result.equipment.pending, null);
    assert.deepEqual(
      game.mutations().map((call) => [call.method, call.path]),
      [["PUT", "/api/weapons/select"]],
    );
    assert.ok(
      game.calls.filter(
        (call) =>
          call.method === "GET" && call.path === "/api/clothing/by-category/1",
      ).length >= 2,
    );
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a confirmed earlier purchase is not purchased again on the next click", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(
    join(tmpdir(), "inventory-purchase-reconcile-"),
  );
  const game = inventoryGame({ owned: true });
  const service = createAutomationService({
    store: createAutomationStateStore({ directory }),
    fetcher: game.fetcher,
    identifyPlayer: async () => ({ playerId: 17 }),
    getBoss: (id) => ({ numericId: id }),
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    entry.equipment = {
      pending: {
        id: "old-command",
        type: "weapon",
        entityId: 1,
        action: "buy",
      },
      checked: false,
    };
    const result = await service.command(entry, {
      id: "new-buy-command",
      expectedVersion: service.snapshot(entry).version,
      command: "inventory.action",
      args: {
        type: "weapon",
        id: 1,
        action: "buy",
        price: { currency: "gold", amount: 100 },
      },
    });
    assert.equal(result.equipment.pending, null);
    assert.equal(game.mutations().length, 0);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("new user action stops if the automatic fresh inventory read fails", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "inventory-offline-reconcile-"));
  let mutations = 0;
  const service = createAutomationService({
    store: createAutomationStateStore({ directory }),
    fetcher: async (_url, init = {}) => {
      if (init.method && init.method !== "GET") mutations++;
      throw new Error("offline");
    },
    identifyPlayer: async () => ({ playerId: 17 }),
    getBoss: (id) => ({ numericId: id }),
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    entry.equipment = {
      pending: {
        id: "old-command",
        type: "weapon",
        entityId: 1,
        action: "buy",
      },
      checked: false,
    };
    await assert.rejects(
      service.command(entry, {
        id: "new-equip-command",
        expectedVersion: service.snapshot(entry).version,
        command: "inventory.action",
        args: { type: "weapon", id: 1, action: "equip" },
      }),
    );
    assert.equal(entry.equipment.pending.id, "old-command");
    assert.equal(mutations, 0);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("another user command is not blocked by an old inventory checkpoint", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "other-command-reconcile-"));
  const game = inventoryGame({ owned: true });
  const service = createAutomationService({
    store: createAutomationStateStore({ directory }),
    fetcher: game.fetcher,
    identifyPlayer: async () => ({ playerId: 17 }),
    getBoss: (id) => ({ numericId: id }),
  });
  try {
    const entry = await service.identify("Bearer fake-token");
    entry.equipment = {
      pending: {
        id: "old-purchase",
        type: "weapon",
        entityId: 1,
        action: "buy",
      },
      checked: false,
    };
    const result = await service.command(entry, {
      id: "favorite-friend-1",
      expectedVersion: service.snapshot(entry).version,
      command: "friends.favorite",
      args: { playerId: 99, enabled: false },
    });
    assert.equal(result.equipment.pending, null);
    assert.ok(!result.preferences.favoriteFriendIds.includes(99));
    assert.equal(game.mutations().length, 0);
  } finally {
    service.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a mutation cancelled in the account lane clears only its unsent checkpoint", async () => {
  const entry = { credential: "Bearer fake", equipment: { pending: null } };
  const game = inventoryGame();
  let mutationAttempts = 0;
  const fetcher = async (url, init) => {
    if (init.method === "POST") {
      mutationAttempts++;
      assert.equal(typeof init.canDispatch, "function");
      assert.equal(init.canDispatch(), true);
      throw Object.assign(new Error("cancelled before dispatch"), {
        notDispatched: true,
      });
    }
    return game.fetcher(url, init);
  };
  await assert.rejects(
    inventoryAction({
      entry,
      args: {
        type: "weapon",
        id: 1,
        action: "buy",
        price: { amount: 100, currency: "gold" },
      },
      commandId: "command123",
      fetcher,
      save: () => {},
    }),
    /cancelled before dispatch/,
  );
  assert.equal(mutationAttempts, 1);
  assert.equal(entry.equipment.pending, null);
  assert.equal(game.mutations().length, 0);
});
