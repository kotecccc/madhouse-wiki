import test from "node:test";
import assert from "node:assert/strict";
import { queuedStashCraftAdapter } from "./queued-stash-craft.mjs";
import { createAutomationService } from "./service.mjs";
import { createAutomationStateStore } from "./state-store.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("lost craft response is reconciled without a second POST", async () => {
  const entry = {
    credential: "fake",
    stashCraft: { pending: null, receipts: [] },
  };
  let crafted = 1;
  let posts = 0;
  let offline = false;
  const adapter = queuedStashCraftAdapter({
    entry,
    save() {},
    fetcher: async (_url, init) => {
      if (init.method === "POST") {
        posts++;
        crafted++;
        offline = true;
        throw new Error("lost response");
      }
      if (offline) throw new Error("offline");
      return Response.json({
        sets: [{ setId: 4, craftedCount: crafted, canCraft: true }],
      });
    },
  });
  const job = { id: "craft-test-1", args: { setId: 4 } };
  assert.equal(
    (await adapter.execute(job, { canDispatch: () => true })).status,
    "uncertain",
  );
  assert.equal(entry.stashCraft.pending.before, 1);
  offline = false;
  assert.equal((await adapter.reconcile(job)).status, "completed");
  assert.equal((await adapter.reconcile(job)).status, "completed");
  assert.equal(posts, 1);
});

test("craft does not dispatch when the game says the set is unavailable", async () => {
  let posts = 0;
  const entry = {
    credential: "fake",
    stashCraft: { pending: null, receipts: [] },
  };
  const adapter = queuedStashCraftAdapter({
    entry,
    save() {},
    fetcher: async (_url, init) => {
      if (init.method === "POST") posts++;
      return Response.json({
        sets: [{ setId: 4, craftedCount: 0, canCraft: false }],
      });
    },
  });
  assert.equal(
    (
      await adapter.execute(
        { id: "craft-test-2", args: { setId: 4 } },
        { canDispatch: () => true },
      )
    ).status,
    "failed",
  );
  assert.equal(posts, 0);
});

test("uncertain craft remains blocked when the counter has not changed", async () => {
  let posts = 0;
  const entry = {
    credential: "fake",
    stashCraft: { pending: null, receipts: [] },
  };
  const adapter = queuedStashCraftAdapter({
    entry,
    save() {},
    fetcher: async (_url, init) => {
      if (init.method === "POST") {
        posts++;
        throw new Error("lost reply");
      }
      return Response.json({
        sets: [{ setId: 4, craftedCount: 3, canCraft: true }],
      });
    },
  });
  const job = { id: "craft-test-3", args: { setId: 4 } };
  assert.equal(
    (await adapter.execute(job, { canDispatch: () => true })).status,
    "uncertain",
  );
  assert.equal((await adapter.reconcile(job)).status, "uncertain");
  assert.equal(posts, 1);
  assert.equal(entry.stashCraft.pending.id, job.id);
});

test("a craft known not to have been dispatched clears its reservation", async () => {
  const entry = {
    credential: "fake",
    stashCraft: { pending: null, receipts: [] },
  };
  const adapter = queuedStashCraftAdapter({
    entry,
    save() {},
    fetcher: async (_url, init) => {
      if (init.method === "POST")
        throw Object.assign(new Error("cancelled"), { notDispatched: true });
      return Response.json({
        sets: [{ setId: 4, craftedCount: 0, canCraft: true }],
      });
    },
  });
  const result = await adapter.execute(
    { id: "craft-test-4", args: { setId: 4 } },
    { canDispatch: () => true },
  );
  assert.equal(result.status, "retry");
  assert.equal(entry.stashCraft.pending, null);
});

test("service persists a craft checkpoint before its only POST", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stash-craft-"));
  const store = createAutomationStateStore({ directory });
  let count = 0;
  let posts = 0;
  const service = createAutomationService({
    store,
    identifyPlayer: async () => ({ playerId: 12 }),
    getBoss: () => null,
    getBusinessCatalogue: () => ({ works: [], bosses: [], businesses: [] }),
    fetcher: async (url, init) => {
      if (new URL(url).pathname === "/api/stash/craft") {
        posts++;
        assert.equal(store.read("12").stashCraft.pending.id, "craft-service-1");
        assert.equal(JSON.parse(init.body).setId, 4);
        count++;
        return Response.json({ success: true });
      }
      return Response.json({
        sets: [{ setId: 4, craftedCount: count, canCraft: true }],
      });
    },
  });
  try {
    const entry = await service.identify("Bearer fake");
    await service.command(entry, {
      id: "craft-service-1",
      expectedVersion: 0,
      command: "queue.enqueue",
      args: { type: "stash.craft", action: { setId: 4 } },
    });
    await entry.actionQueue.tick();
    assert.equal(entry.actionQueue.snapshot()[0].status, "completed");
    assert.equal(store.read("12").stashCraft.pending, null);
    assert.equal(posts, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("service restart reconciles a lost craft without submitting again", async () => {
  const directory = mkdtempSync(join(tmpdir(), "stash-craft-restart-"));
  const store = createAutomationStateStore({ directory });
  let count = 0,
    posts = 0,
    offline = false,
    clock = 1_000_000;
  const options = {
    store,
    now: () => clock,
    random: () => 0,
    identifyPlayer: async () => ({ playerId: 12 }),
    getBoss: () => null,
    getBusinessCatalogue: () => ({ works: [], bosses: [], businesses: [] }),
    fetcher: async (url) => {
      if (new URL(url).pathname === "/api/stash/craft") {
        posts++;
        count++;
        offline = true;
        throw new Error("lost reply");
      }
      if (offline) throw new Error("offline");
      return Response.json({
        sets: [{ setId: 4, craftedCount: count, canCraft: true }],
      });
    },
  };
  let service = createAutomationService(options);
  try {
    let entry = await service.identify("Bearer fake");
    await service.command(entry, {
      id: "craft-restart-1",
      expectedVersion: 0,
      command: "queue.enqueue",
      args: { type: "stash.craft", action: { setId: 4 } },
    });
    await entry.actionQueue.tick();
    assert.equal(entry.actionQueue.snapshot()[0].status, "reconciling");
    service.close();
    offline = false;
    clock += 60000;
    service = createAutomationService(options);
    entry = await service.identify("Bearer fake");
    await entry.actionQueue.tick();
    assert.equal(entry.actionQueue.snapshot()[0].status, "completed");
    assert.equal(posts, 1);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
