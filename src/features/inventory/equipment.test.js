import test from "node:test";
import assert from "node:assert/strict";
import { sendEquipmentCommand, sendInventoryCommand } from "./equipment.js";
test("equipment client sends one versioned command and reads confirmed inventory", async () => {
  const calls = [];
  const get = async (path) => {
    calls.push(path);
    return path.endsWith("state")
      ? { version: 3, equipment: {} }
      : { items: [] };
  };
  const post = async (path, body) => {
    calls.push({ path, body });
    return {
      equipment: { pending: null, paths: ["/api/clothing/by-category/1"] },
    };
  };
  await sendEquipmentCommand({
    get,
    post,
    item: { id: "7", equipped: true },
    makeId: () => "receipt123",
  });
  assert.deepEqual(calls[1].body, {
    id: "receipt123",
    expectedVersion: 3,
    command: "inventory.action",
    args: { type: "weapon", id: 7, action: "unequip" },
  });
  assert.ok(calls.includes("/api/clothing/by-category/1"));
  assert.equal(calls.at(-1), "/api/me");
});
test("new user action reaches server even when a previous operation is pending", async () => {
  const commands = [];
  await sendEquipmentCommand({
    get: async () => ({ version: 3, equipment: { pending: { id: "old" } } }),
    post: async (_path, body) => {
      commands.push(body);
      return { equipment: { pending: null, paths: [] } };
    },
    item: { id: "1" },
    makeId: () => "new-command",
  });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].id, "new-command");
  assert.equal(commands[0].command, "inventory.action");
});
test("reports whether reconciliation failed at the command or later read", async () => {
  for (const stage of ["command", "inventory"]) {
    const failure = Object.assign(new Error("conflict"), { status: 409 });
    await assert.rejects(
      sendInventoryCommand({
        get: async (path) => {
          if (path.endsWith("state")) return { version: 1, equipment: {} };
          throw failure;
        },
        post: async () => {
          if (stage === "command") throw failure;
          return { equipment: { paths: ["/api/clothing"] } };
        },
        refreshOnly: true,
        type: "clothing_item",
        makeId: () => "receipt123",
      }),
      (error) => error.inventoryStage === stage && error.status === 409,
    );
  }
});

test("checking an action error only unlocks controls when the server confirms no pending action", async () => {
  const { inventoryNeedsCheck } = await import("./equipment.js");
  assert.equal(
    await inventoryNeedsCheck(async () => ({ equipment: { pending: null } })),
    false,
  );
  assert.equal(
    await inventoryNeedsCheck(async () => ({
      equipment: { pending: { id: "pending" } },
    })),
    true,
  );
  assert.equal(await inventoryNeedsCheck(async () => ({})), true);
  assert.equal(
    await inventoryNeedsCheck(async () => {
      throw new Error("offline");
    }),
    true,
  );
});
