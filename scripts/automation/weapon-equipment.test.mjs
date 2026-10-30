import test from "node:test";
import assert from "node:assert/strict";
import { weaponEquipment } from "./weapon-equipment.mjs";
function context({ failMutation = false, failConfirm = false } = {}) {
  const entry = { credential: "Bearer fake", equipment: { pending: null } };
  let equipped = false;
  const calls = [],
    saved = [];
  const save = () => saved.push(structuredClone(entry.equipment));
  const fetcher = async (url, init = {}) => {
    calls.push({
      method: init.method || "GET",
      path: new URL(url).pathname,
      body: init.body,
    });
    if (new URL(url).pathname.endsWith("/select")) {
      assert.ok(
        entry.equipment.pending,
        "pending is saved before submitting mutation",
      );
      assert.ok(saved.at(-1).pending);
      if (failMutation) throw new Error("timeout");
      equipped = init.method === "PUT";
      return Response.json({ success: true });
    }
    if (failConfirm && calls.length > 1) throw new Error("read failed");
    return Response.json({
      success: true,
      items: [
        { weaponId: 1, owned: true, equipped },
        { weaponId: 2, owned: false, equipped: false },
      ],
    });
  };
  return {
    entry,
    fetcher,
    save,
    calls,
    saved,
    run: (args, refreshOnly = false) =>
      weaponEquipment({
        entry,
        fetcher,
        save,
        args,
        refreshOnly,
        commandId: "command1",
      }),
  };
}
test("equip and remove use exact API methods and confirm state", async () => {
  const ctx = context();
  await ctx.run({ weaponId: 1, equip: true });
  assert.equal(ctx.calls[1].method, "PUT");
  assert.deepEqual(JSON.parse(ctx.calls[1].body), { weaponId: 1 });
  assert.equal(ctx.entry.equipment.pending, null);
  await ctx.run({ weaponId: 1, equip: false });
  assert.equal(ctx.calls[4].method, "DELETE");
  assert.equal(ctx.calls[4].body, undefined);
  assert.equal(ctx.entry.equipment.pending, null);
});
test("unowned items and stale remove requests never submit actions", async () => {
  const ctx = context();
  await assert.rejects(
    ctx.run({ weaponId: 2, equip: true }),
    /weapon_not_owned/,
  );
  await assert.rejects(
    ctx.run({ weaponId: 1, equip: false }),
    /weapon_equipment_changed/,
  );
  assert.ok(ctx.calls.every((call) => call.method === "GET"));
});
test("uncertain submissions retain pending, never replay and require explicit reconciliation", async () => {
  const ctx = context({ failMutation: true });
  await assert.rejects(ctx.run({ weaponId: 1, equip: true }), /timeout/);
  assert.ok(ctx.entry.equipment.pending);
  await assert.rejects(
    ctx.run({ weaponId: 1, equip: true }),
    /weapon_equipment_uncertain/,
  );
  assert.equal(ctx.calls.filter((call) => call.method === "PUT").length, 1);
  await ctx.run({}, true);
  assert.equal(ctx.entry.equipment.pending, null);
  assert.equal(ctx.calls.filter((call) => call.method === "PUT").length, 1);
});
test("a lost confirmation read leaves the completed action uncertain", async () => {
  const ctx = context({ failConfirm: true });
  await assert.rejects(ctx.run({ weaponId: 1, equip: true }), /read failed/);
  assert.ok(ctx.entry.equipment.pending);
  assert.equal(ctx.calls.filter((call) => call.method === "PUT").length, 1);
});
test("failed durable save prevents mutation", async () => {
  const ctx = context();
  await assert.rejects(
    weaponEquipment({
      ...ctx,
      args: { weaponId: 1, equip: true },
      commandId: "x",
      save: () => {
        ctx.entry.storageFailed = true;
      },
    }),
    /automation_storage_unavailable/,
  );
  assert.ok(ctx.calls.every((call) => call.method === "GET"));
});

test("service persists equipment uncertainty across restart and rejects replayed receipts", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { createAutomationStateStore } = await import("./state-store.mjs");
  const { createAutomationService } = await import("./service.mjs");
  const directory = mkdtempSync(join(tmpdir(), "equipment-service-"));
  const store = createAutomationStateStore({ directory });
  let mutations = 0;
  const fetcher = async (_url, init = {}) => {
    if (init.method === "PUT") {
      mutations++;
      assert.ok(store.list()[0].value.equipment.pending);
      throw new Error("timeout");
    }
    return Response.json({
      items: [{ weaponId: 1, owned: true, equipped: false }],
    });
  };
  const makeService = () =>
    createAutomationService({
      store,
      fetcher,
      identifyPlayer: async () => ({ playerId: 17 }),
      getBoss: (id) => ({ numericId: id }),
      now: () => 1000000,
    });
  let service = makeService();
  try {
    let entry = await service.identify("Bearer fake-token");
    const receipt = {
      id: "equip-command-1",
      command: "equipment.weapon",
      expectedVersion: service.snapshot(entry).version,
      args: { weaponId: 1, equip: true },
    };
    await assert.rejects(service.command(entry, receipt));
    assert.ok(store.list()[0].value.equipment.pending);
    service.close();
    service = makeService();
    entry = await service.identify("Bearer fake-token");
    assert.ok(service.snapshot(entry).equipment.pending);
    await assert.rejects(
      service.command(entry, {
        ...receipt,
        expectedVersion: service.snapshot(entry).version,
      }),
      /already_received/,
    );
    const before = mutations;
    await assert.rejects(
      service.command(entry, {
        ...receipt,
        id: "equip-command-2",
        expectedVersion: service.snapshot(entry).version,
      }),
      /weapon_equipment_uncertain/,
    );
    assert.equal(mutations, before);
  } finally {
    service.close();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
