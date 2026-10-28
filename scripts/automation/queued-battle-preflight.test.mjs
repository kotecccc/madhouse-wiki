import test from "node:test";
import assert from "node:assert/strict";
import { queuedBattleHealAdapter } from "./queued-battle-heal.mjs";
import { queuedBattlePurchaseAdapter } from "./queued-battle-purchase.mjs";

for (const [name, makeAdapter] of [
  ["heal", (entry) => queuedBattleHealAdapter({ entry })],
  [
    "purchase",
    (entry) =>
      queuedBattlePurchaseAdapter({ entry, readWallet: async () => 0 }),
  ],
]) {
  test(`${name} stops on a permanent preflight rejection and retries temporary failures`, async () => {
    for (const [httpStatus, expectedStatus, expectedReason] of [
      [400, "failed", "game_request_rejected"],
      [404, "failed", "game_request_rejected"],
      [401, "failed", "game_session_required"],
      [403, "failed", "game_session_required"],
      [429, "retry", "Ожидаем игру."],
      [503, "retry", "Ожидаем игру."],
      [null, "retry", "Ожидаем игру."],
    ]) {
      let snapshot = {
        boss: { id: 1 },
        battle: { id: "battle-1", status: "active" },
      };
      let writes = 0;
      const entry = {
        controller: {
          getSnapshot: () => snapshot,
          loadMedicines: async () => {
            snapshot = {
              ...snapshot,
              needsRefresh: true,
              error: "unavailable",
              errorStatus: httpStatus,
              errorRetryAfterMs: httpStatus === 429 ? 120000 : null,
            };
          },
        },
        assistant: {
          queuedState: () => ({ pending: null, receipts: [] }),
          use: async () => {
            writes++;
          },
          buy: async () => {
            writes++;
          },
        },
      };
      const adapter = makeAdapter(entry);
      const result = await adapter.execute(
        { id: "queued-action", args: { bossId: 1, battleId: "battle-1" } },
        { canDispatch: () => true },
      );
      assert.deepEqual(result, {
        status: expectedStatus,
        reason: expectedReason,
        ...(httpStatus === 429 ? { retryAfterMs: 120000 } : {}),
      });
      assert.equal(writes, 0);
    }
  });
  test(`${name} keeps an already submitted operation uncertain on a rejected read`, async () => {
    const rejected = async () => {
      throw Object.assign(new Error("rejected"), { status: 400 });
    };
    const entry = {
      assistant: {
        queuedState: () => ({
          pending: { queueId: "queued-action" },
          receipts: [],
        }),
        reconcileQueuedHeal: rejected,
        reconcileQueuedPurchase: rejected,
      },
    };
    const result = await makeAdapter(entry).execute(
      { id: "queued-action" },
      { canDispatch: () => true },
    );
    assert.equal(result.status, "uncertain");
  });
  test(`${name} preserves Retry-After while reconciling a submitted operation`, async () => {
    const entry = {
      controller: { getSnapshot: () => ({ errorRetryAfterMs: 120000 }) },
      assistant: {
        queuedState: () => ({
          pending: { queueId: "queued-action" },
          receipts: [],
        }),
        reconcileQueuedHeal: async () => false,
        reconcileQueuedPurchase: async () => false,
      },
    };
    const result = await makeAdapter(entry).execute(
      { id: "queued-action" },
      { canDispatch: () => true },
    );
    assert.equal(result.status, "uncertain");
    assert.equal(result.retryAfterMs, 120000);
  });
}
