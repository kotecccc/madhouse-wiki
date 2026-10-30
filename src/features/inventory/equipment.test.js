import test from "node:test";
import assert from "node:assert/strict";
import {
  sendEquipmentCommand,
  sendInventoryCommand,
  reconcileInventoryCommand,
  verifyInventoryAction,
} from "./equipment.js";
test("clothing commands include the item's category for targeted verification", async () => {
  let command;
  await sendInventoryCommand({
    post: async (_path, body) => {
      command = body;
      return {};
    },
    item: { id: "364", type: "clothing_item", categoryId: 5 },
    action: "equip",
    makeId: () => "clothing-command",
  });
  assert.deepEqual(command.args.action, {
    type: "clothing_item",
    id: 364,
    categoryId: 5,
    action: "equip",
  });
});
test("equipment client enqueues without a preflight state read", async () => {
  const calls = [];
  const accepted = [];
  const get = async (path) => {
    calls.push(path);
    return path.endsWith("state")
      ? { version: 3, equipment: {} }
      : { items: [] };
  };
  const post = async (path, body) => {
    calls.push({ path, body });
    return {
      enqueuedJobId: "canonical-job-id",
      equipment: { pending: null, paths: ["/api/clothing/by-category/1"] },
      queuedActions: [],
    };
  };
  const result = await sendEquipmentCommand({
    get,
    post,
    item: { id: "7", equipped: true },
    makeId: () => "receipt123",
    onQueueAccepted: (state) => accepted.push(state),
  });
  assert.deepEqual(calls[0].body, {
    id: "receipt123",
    expectedVersion: 0,
    command: "queue.enqueue",
    args: {
      type: "inventory",
      action: { type: "weapon", id: 7, action: "unequip" },
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(result.enqueuedJobId, "canonical-job-id");
  assert.deepEqual(accepted, [result]);
});
test("safe inventory verification fails closed when server equipment is pending or unknown", async () => {
  for (const state of [
    { equipment: { pending: { id: "uncertain" } } },
    { equipment: {} },
    {},
  ]) {
    const calls = [];
    await assert.rejects(
      verifyInventoryAction({
        get: async (path) => {
          calls.push(path);
          return state;
        },
        item: { id: "12", type: "weapon" },
        action: "equip",
        paths: ["/api/clothing/by-category/1"],
        references: [{ id: "12", type: "weapon" }],
      }),
      /inventory_pending/,
    );
    assert.deepEqual(calls, ["/api/automation/state"]);
  }
});
test("safe inventory verification only confirms a fresh effect with no pending checkpoint", async () => {
  const calls = [];
  let stateReads = 0;
  const result = await verifyInventoryAction({
    get: async (path) => {
      calls.push(path);
      if (path === "/api/automation/state") {
        stateReads += 1;
        return { equipment: { pending: null } };
      }
      return { items: [{ weaponId: 12, owned: true, equipped: true }] };
    },
    item: { id: "12", type: "weapon" },
    action: "equip",
    paths: ["/api/clothing/by-category/1"],
    references: [{ id: "12", type: "weapon" }],
  });
  assert.equal(result.confirmed, true);
  assert.equal(stateReads, 2);
  assert.deepEqual(calls, [
    "/api/automation/state",
    "/api/clothing/by-category/1",
    "/api/automation/state",
  ]);
});

test("safe inventory verification uses live GETs only and releases only after confirmed effect", async () => {
  const reads = [];
  let stateReads = 0;
  const result = await verifyInventoryAction({
    get: async (path, options) => {
      reads.push({ path, options });
      if (path === "/api/automation/state") {
        stateReads += 1;
        return { equipment: { pending: null } };
      }
      return { items: [{ weaponId: 12, owned: true, equipped: false }] };
    },
    item: { id: "12", type: "weapon" },
    action: "equip",
    paths: ["/api/clothing/by-category/1"],
    references: [{ id: "12", type: "weapon" }],
  });

  assert.equal(result.confirmed, false);
  assert.equal(stateReads, 2);
  assert.deepEqual(reads.slice(0, 1), [
    {
      path: "/api/automation/state",
      options: { fresh: true, revalidate: false },
    },
  ]);
  assert.deepEqual(reads[1], {
    path: "/api/clothing/by-category/1",
    options: { fresh: true, serverRefresh: "live", revalidate: false },
  });
  assert.deepEqual(reads[2], {
    path: "/api/automation/state",
    options: { fresh: true, revalidate: false },
  });
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
  assert.equal(commands[0].command, "queue.enqueue");
});
test("observer failure does not turn an accepted enqueue into a command error", async () => {
  const accepted = {
    enqueuedJobId: "canonical-job",
    queuedActions: [{ id: "canonical-job", status: "queued" }],
  };
  const result = await sendEquipmentCommand({
    get: async () => {
      throw new Error("enqueue must not preflight state");
    },
    post: async () => accepted,
    item: { id: "12" },
    makeId: () => "command-id",
    onQueueAccepted: () => {
      throw new Error("observer failed");
    },
  });
  assert.equal(result, accepted);
});

test("enqueue failure preserves command id and reconciliation finds the deduped job", async () => {
  const failure = new Error("connection lost after submit");
  let submittedId;
  await assert.rejects(
    sendEquipmentCommand({
      post: async (_path, body) => {
        submittedId = body.id;
        throw failure;
      },
      item: { id: "12", type: "weapon" },
      commandId: "stable-command-id",
    }),
    (error) => error === failure && error.commandId === "stable-command-id",
  );
  assert.equal(submittedId, "stable-command-id");

  const reads = [];
  const result = await reconcileInventoryCommand({
    get: async (path, options) => {
      reads.push({ path, options });
      return {
        receipts: ["stable-command-id"],
        queueReceiptJobs: [["stable-command-id", "canonical-deduped-job"]],
        queuedActions: [
          {
            id: "canonical-deduped-job",
            type: "inventory",
            args: { type: "weapon", id: 12, action: "equip" },
            status: "queued",
          },
        ],
      };
    },
    commandId: "stable-command-id",
    item: { id: "12", type: "weapon" },
    action: "equip",
  });
  assert.equal(result.accepted, true);
  assert.equal(result.jobId, "canonical-deduped-job");
  assert.deepEqual(reads, [
    {
      path: "/api/automation/state",
      options: { fresh: true, revalidate: false },
    },
  ]);
});

test("missing enqueue receipt does not claim rejection or a safe retry", async () => {
  const result = await reconcileInventoryCommand({
    get: async () => ({ receipts: [], queuedActions: [] }),
    commandId: "uncertain-command-id",
    item: { id: "12", type: "weapon" },
    action: "equip",
  });
  assert.deepEqual(
    { accepted: result.accepted, jobId: result.jobId },
    { accepted: false, jobId: null },
  );
});
test("safe verification fails closed if a live read fails or pending reappears", async () => {
  for (const stage of ["inventory", "after-state"]) {
    let stateReads = 0;
    const failure = Object.assign(new Error("offline"), { status: 503 });
    await assert.rejects(
      verifyInventoryAction({
        get: async (path) => {
          if (path === "/api/automation/state") {
            stateReads += 1;
            if (stage === "after-state" && stateReads === 2)
              return { equipment: { pending: { id: "uncertain" } } };
            return { equipment: { pending: null } };
          }
          if (stage === "inventory") throw failure;
          return { items: [{ weaponId: 12, owned: true, equipped: true }] };
        },
        item: { id: "12", type: "weapon" },
        action: "equip",
        paths: ["/api/clothing/by-category/1"],
        references: [{ id: "12", type: "weapon" }],
      }),
      (error) =>
        stage === "inventory"
          ? error === failure
          : error.message === "inventory_pending",
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
