import test from "node:test";
import assert from "node:assert/strict";
import { advanceBusinessUpgrade } from "../scripts/automation/business-upgrade.mjs";

function setup({ lost = false, denied = false } = {}) {
  const run = { targetLevel: 3, pendingUpgrade: null };
  let level = 1;
  let online = true;
  let allowed = true;
  const saves = [];
  const posts = [];
  const detail = () => ({
    id: 7,
    level,
    canUpgrade: true,
    nextUpgradePrice: 10,
    nextUpgradeCurrency: "gold",
    requiredItems: [{ itemId: 55, requiredAmount: 2, playerAmount: 2 }],
  });
  const args = {
    run,
    businessId: 7,
    get: async (path) => {
      if (!online) throw new Error("offline");
      return path === "/api/me" ? { wallet: { gold: 100 } } : detail();
    },
    post: async (path, body) => {
      assert.equal(saves.at(-1).pendingUpgrade.operationId, body.operationId);
      posts.push({ path, body });
      if (!denied) level++;
      if (lost) throw new Error("reply lost");
      return { success: true };
    },
    persist: () => {
      saves.push(structuredClone(run));
    },
    allowed: () => allowed,
    operationId: () => "operation-1",
  };
  return {
    args,
    run,
    saves,
    posts,
    setOnline: (value) => {
      online = value;
    },
    setLevel: (value) => {
      level = value;
    },
    setAllowed: (value) => {
      allowed = value;
    },
  };
}

test("persists a single upgrade before dispatch and verifies the new level", async () => {
  const h = setup();
  assert.deepEqual(await advanceBusinessUpgrade(h.args), {
    status: "confirmed",
    level: 2,
  });
  assert.equal(h.posts.length, 1);
  assert.equal(h.run.pendingUpgrade, null);
  assert.deepEqual(h.run.lastUpgrade, { fromLevel: 1, toLevel: 2 });
});

test("each level is separately verified and uses a new operation", async () => {
  const h = setup();
  let id = 0;
  h.args.operationId = () => `operation-${++id}`;
  assert.equal((await advanceBusinessUpgrade(h.args)).level, 2);
  assert.equal((await advanceBusinessUpgrade(h.args)).level, 3);
  assert.deepEqual(
    h.posts.map(({ body }) => body.operationId),
    ["operation-1", "operation-2"],
  );
  assert.equal((await advanceBusinessUpgrade(h.args)).status, "complete");
  assert.equal(h.posts.length, 2);
});

test("a lost response and unavailable reads preserve the checkpoint without replay", async () => {
  const h = setup({ lost: true });
  h.args.post = async () => {
    h.posts.push("sent");
    h.setLevel(2);
    h.setOnline(false);
    throw new Error("reply lost");
  };
  assert.deepEqual(await advanceBusinessUpgrade(h.args), {
    status: "uncertain",
  });
  assert.ok(h.run.pendingUpgrade);
  assert.deepEqual(await advanceBusinessUpgrade(h.args), {
    status: "uncertain",
  });
  h.setOnline(true);
  assert.deepEqual(await advanceBusinessUpgrade(h.args), {
    status: "confirmed",
    level: 2,
  });
  assert.equal(h.posts.length, 1);
});

test("unconfirmed unchanged level never causes a second upgrade", async () => {
  const h = setup({ denied: true });
  assert.deepEqual(await advanceBusinessUpgrade(h.args), {
    status: "uncertain",
  });
  assert.deepEqual(await advanceBusinessUpgrade(h.args), {
    status: "uncertain",
  });
  assert.equal(h.posts.length, 1);
});

test("missing price, materials, balance or permission causes no mutation", async () => {
  for (const variant of ["quote", "materials", "balance", "permission"]) {
    const h = setup();
    const original = h.args.get;
    h.args.get = async (path) => {
      const value = await original(path);
      if (variant === "quote" && path !== "/api/me")
        delete value.nextUpgradePrice;
      if (variant === "materials" && path !== "/api/me")
        value.requiredItems[0].playerAmount = 1;
      if (variant === "balance" && path === "/api/me") value.wallet.gold = 0;
      return value;
    };
    if (variant === "permission") h.setAllowed(false);
    if (variant === "quote")
      await assert.rejects(advanceBusinessUpgrade(h.args), /quote_unknown/);
    else
      assert.ok(
        ["materials_missing", "funds_missing", "stopped"].includes(
          (await advanceBusinessUpgrade(h.args)).status,
        ),
      );
    assert.equal(h.posts.length, 0, variant);
  }
});

test("invalid or foreign checkpoint cannot be reconciled as this business", async () => {
  const h = setup();
  h.run.pendingUpgrade = { businessId: 8, fromLevel: 1, operationId: "other" };
  await assert.rejects(advanceBusinessUpgrade(h.args), /checkpoint_invalid/);
  assert.equal(h.posts.length, 0);
});

test("does not clear an uncommitted reconciliation after a storage failure", async () => {
  const h = setup();
  let saves = 0;
  h.args.persist = () => ++saves === 1;
  h.args.post = async () => h.setLevel(2);
  await assert.rejects(advanceBusinessUpgrade(h.args), /storage_unavailable/);
  assert.equal(h.run.pendingUpgrade.operationId, "operation-1");
});

test("requires confirmed upgrade availability before spending", async () => {
  const h = setup();
  const original = h.args.get;
  h.args.get = async (path) => {
    const value = await original(path);
    if (path !== "/api/me") delete value.canUpgrade;
    return value;
  };
  await assert.rejects(advanceBusinessUpgrade(h.args), /availability_unknown/);
  assert.equal(h.posts.length, 0);
});

test("an explicit unknown currency never falls back to another currency", async () => {
  const h = setup();
  const original = h.args.get;
  h.args.get = async (path) => {
    const value = await original(path);
    if (path !== "/api/me") {
      value.nextUpgradeCurrency = null;
      value.currency = "gold";
    }
    return value;
  };
  await assert.rejects(advanceBusinessUpgrade(h.args), /quote_unknown/);
  assert.equal(h.posts.length, 0);
});

test("a confirmed zero-price upgrade does not require a currency or wallet", async () => {
  const h = setup();
  const original = h.args.get;
  h.args.get = async (path) => {
    assert.notEqual(path, "/api/me");
    const value = await original(path);
    value.nextUpgradePrice = 0;
    value.nextUpgradeCurrency = null;
    return value;
  };
  assert.equal((await advanceBusinessUpgrade(h.args)).status, "confirmed");
  assert.equal(h.posts.length, 1);
  assert.deepEqual(
    {
      price: h.saves[0].pendingUpgrade.price,
      currency: h.saves[0].pendingUpgrade.currency,
    },
    { price: 0, currency: null },
  );
});

test("a cancelled queued request clears its checkpoint only after durable save", async () => {
  const h = setup();
  h.args.post = async () => {
    throw Object.assign(new Error("cancelled before dispatch"), {
      notDispatched: true,
    });
  };
  assert.deepEqual(await advanceBusinessUpgrade(h.args), { status: "stopped" });
  assert.equal(h.run.pendingUpgrade, null);
  assert.equal(h.saves.at(-1).pendingUpgrade, null);
  assert.equal(h.posts.length, 0);
});
