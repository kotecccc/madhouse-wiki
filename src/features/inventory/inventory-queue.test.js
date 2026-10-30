import assert from "node:assert/strict";
import test from "node:test";
import {
  inventoryActionConfirmed,
  inventoryJobForItem,
  inventoryJobStatusForItem,
  isInventoryJobActive,
} from "./inventory-queue.js";

const item = { type: "weapon", id: "12" };

test("inventory queue observer follows the canonical deduplicated job id", () => {
  const state = {
    queuedActions: [
      {
        id: "existing-job",
        type: "inventory",
        args: { type: "weapon", id: 12, action: "equip" },
        status: "running",
      },
    ],
  };
  assert.equal(
    inventoryJobForItem(state, item, "existing-job").id,
    "existing-job",
  );
  assert.deepEqual(inventoryJobStatusForItem(state, item, "existing-job"), {
    title: "Выполняется",
  });
});

test("queued action exposes its server reason and blocker and stays protected", () => {
  const job = {
    id: "waiting-job",
    type: "inventory",
    args: { type: "weapon", id: 12, action: "equip" },
    status: "waiting",
    reason: "Ожидает освобождения очереди.",
    blockedBy: "game",
  };
  assert.deepEqual(inventoryJobStatusForItem({ queuedActions: [job] }, item), {
    title: "Ожидает выполнения",
    description: "Ожидает освобождения очереди. · Игра временно недоступна",
  });
  assert.equal(isInventoryJobActive(job), true);
  assert.equal(isInventoryJobActive({ ...job, status: "failed" }), false);
});

test("known queue blockers use user-facing explanations", () => {
  const expected = {
    action: "Ожидает завершения другого действия",
    credentials: "Проверьте игровую сессию",
    dependency: "Ожидает связанное действие",
    game: "Игра временно недоступна",
    rate: "Ожидает следующего разрешённого действия",
    storage: "Серверное хранилище временно недоступно",
  };
  for (const [blockedBy, description] of Object.entries(expected))
    assert.equal(
      inventoryJobStatusForItem(
        {
          queuedActions: [
            {
              type: "inventory",
              args: { type: item.type, id: Number(item.id) },
              status: "queued",
              blockedBy,
            },
          ],
        },
        item,
      ).description,
      description,
    );
  assert.equal(
    inventoryJobStatusForItem(
      {
        queuedActions: [
          {
            type: "inventory",
            args: { type: item.type, id: Number(item.id) },
            status: "queued",
            blockedBy: "future_internal_reason",
          },
        ],
      },
      item,
    ).description,
    "Ожидает освобождения очереди",
  );
});

test("observer distinguishes unresolved, failed, completed, and missing jobs", () => {
  const state = {
    queuedActions: [
      {
        id: "checking",
        type: "inventory",
        args: { type: "weapon", id: 12 },
        status: "reconciling",
        reason: "Проверяем результат.",
      },
      {
        id: "failed",
        type: "inventory",
        args: { type: "weapon", id: 12 },
        status: "failed",
        reason: "inventory_action_failed",
      },
      {
        id: "done",
        type: "inventory",
        args: { type: "weapon", id: 12 },
        status: "completed",
      },
    ],
  };
  assert.deepEqual(inventoryJobStatusForItem(state, item, "checking"), {
    title: "Проверяем результат",
    description: "Проверяем результат.",
  });
  assert.deepEqual(
    inventoryJobStatusForItem(
      { queuedActions: [state.queuedActions[1]] },
      item,
      "failed",
    ),
    {
      title: "Не удалось выполнить действие",
      description: "inventory_action_failed",
    },
  );
  assert.deepEqual(inventoryJobStatusForItem(state, item, "done"), {
    title: "Проверяем результат",
    description: "Проверяем результат.",
  });
  assert.deepEqual(
    inventoryJobStatusForItem({ queuedActions: [] }, item, "pruned-job"),
    {
      uncertain: true,
      canCheck: true,
      title: "Не удалось проверить результат",
      description:
        "Проверьте инвентарь. Не повторяйте действие, пока результат не подтверждён.",
    },
  );
});

test("server pending equipment remains guarded and cannot start a local check", () => {
  const state = {
    equipment: {
      pending: {
        id: "pending-operation",
        type: "weapon",
        entityId: 12,
        action: "equip",
      },
    },
    queuedActions: [],
  };
  const job = inventoryJobForItem(state, item);
  assert.equal(isInventoryJobActive(job), true);
  assert.equal(job.pending, true);
  assert.deepEqual(inventoryJobStatusForItem(state, item), {
    uncertain: true,
    canCheck: false,
    title: "Не удалось проверить результат",
    description:
      "Сервер ещё хранит неопределённую операцию. Дождитесь её сверки; не повторяйте действие.",
  });
});

test("remount recovery finds active and failed jobs by inventory item", () => {
  const state = {
    queuedActions: [
      {
        id: "completed-old",
        type: "inventory",
        args: { type: "weapon", id: 12 },
        status: "completed",
      },
      {
        id: "active-new",
        type: "inventory",
        args: { type: "weapon", id: 12 },
        status: "waiting",
      },
    ],
  };
  assert.equal(inventoryJobForItem(state, item).id, "active-new");
  state.queuedActions[1].status = "failed";
  state.queuedActions[1].finishedAt = 20;
  state.queuedActions[0].finishedAt = 10;
  assert.equal(inventoryJobForItem(state, item).id, "active-new");
});

test("only the latest non-dismissed job can leave a terminal error visible", () => {
  const state = {
    queuedActions: [
      {
        id: "old-failure",
        type: "inventory",
        args: { type: "weapon", id: 12 },
        status: "failed",
        createdAt: 1,
        finishedAt: 2,
        reason: "old failure",
      },
      {
        id: "new-success",
        type: "inventory",
        args: { type: "weapon", id: 12 },
        status: "completed",
        createdAt: 3,
        finishedAt: 4,
      },
      {
        id: "dismissed-failure",
        type: "inventory",
        args: { type: "weapon", id: 12 },
        status: "failed",
        createdAt: 5,
        finishedAt: 6,
        dismissed: true,
      },
    ],
  };
  assert.equal(inventoryJobForItem(state, item), null);
  assert.equal(inventoryJobStatusForItem(state, item), null);
  assert.equal(inventoryJobStatusForItem(state, item, "old-failure"), null);
  state.queuedActions[1].status = "failed";
  state.queuedActions[1].reason = "latest failure";
  assert.deepEqual(inventoryJobStatusForItem(state, item), {
    title: "Не удалось выполнить действие",
    description: "latest failure",
  });
});

test("a missing tracked job stays locked until a safe inventory check confirms its result", () => {
  const missing = inventoryJobForItem(
    { queuedActions: [] },
    item,
    "pruned-job",
  );
  assert.equal(isInventoryJobActive(missing), true);
  assert.equal(
    isInventoryJobActive(
      inventoryJobForItem(
        {
          queuedActions: [
            {
              id: "different-job",
              type: "inventory",
              args: { type: "weapon", id: 12 },
              status: "completed",
            },
          ],
        },
        item,
        "pruned-job",
      ),
    ),
    true,
  );
  assert.deepEqual(
    inventoryJobStatusForItem({ queuedActions: [] }, item, "pruned-job"),
    {
      uncertain: true,
      canCheck: true,
      title: "Не удалось проверить результат",
      description:
        "Проверьте инвентарь. Не повторяйте действие, пока результат не подтверждён.",
    },
  );
  assert.equal(
    inventoryActionConfirmed({ ...item, equipped: true }, "equip"),
    true,
  );
  assert.equal(
    inventoryActionConfirmed({ ...item, equipped: false }, "equip"),
    false,
  );
  assert.equal(
    inventoryActionConfirmed(
      { ...item, status: "owned", equipped: false },
      "buy",
    ),
    true,
  );
  assert.equal(
    inventoryActionConfirmed(
      { ...item, durability: 10, durabilityMax: 10, isBroken: false },
      "repair",
    ),
    true,
  );
});
