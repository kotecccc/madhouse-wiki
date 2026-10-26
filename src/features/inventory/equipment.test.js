import test from "node:test";
import assert from "node:assert/strict";
import { sendEquipmentCommand } from "./equipment.js";
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
    return { equipment: { pending: null } };
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
    command: "equipment.weapon",
    args: { weaponId: 7, equip: false },
  });
  assert.equal(calls.at(-1), "/api/clothing/by-category/1");
});
test("uncertain state is never automatically resubmitted", async () => {
  let posts = 0;
  await assert.rejects(
    sendEquipmentCommand({
      get: async () => ({ equipment: { pending: {} } }),
      post: async () => posts++,
      item: { id: "1" },
    }),
    /equipment_pending/,
  );
  assert.equal(posts, 0);
});
