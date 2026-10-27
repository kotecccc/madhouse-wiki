import { medicinePurchaseQuote } from "../../src/features/bosses/BossBattle/boss-medicines.js";

export function queuedBattlePurchaseAdapter({ entry, readWallet }) {
  const status = () => entry.assistant.queuedState();
  const confirmed = (job) => status().receipts.includes(job.id);
  async function reconcile(job) {
    const pending = status().pending;
    if (!confirmed(job) && !pending)
      return { status: "retry", reason: "Ожидаем игру." };
    if (!confirmed(job) && pending.queueId !== job.id)
      return { status: "retry", reason: "Проверяем предыдущее действие." };
    try {
      return (await entry.assistant.reconcileQueuedPurchase(job.id, readWallet))
        ? { status: "completed" }
        : { status: "uncertain", reason: "Проверяем результат." };
    } catch (error) {
      return {
        status: "uncertain",
        reason: "Ожидаем игру.",
        retryAfterMs: error.retryAfterMs,
      };
    }
  }
  return {
    validate(args) {
      const q = args?.quote;
      if (
        !Number.isSafeInteger(args?.bossId) ||
        args.bossId <= 0 ||
        typeof args.battleId !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(args.battleId) ||
        !["heal_10", "heal_full"].includes(q?.type) ||
        !["gold", "dollar", "pills"].includes(q.currency) ||
        !Number.isSafeInteger(q.quantity) ||
        q.quantity < 1 ||
        q.quantity > 100 ||
        !Number.isSafeInteger(q.unitPrice) ||
        q.unitPrice < 0 ||
        !Number.isSafeInteger(q.total) ||
        q.total !== q.quantity * q.unitPrice
      )
        throw new Error("invalid_medicine_purchase");
      return {
        bossId: args.bossId,
        battleId: args.battleId,
        quote: {
          type: q.type,
          currency: q.currency,
          quantity: q.quantity,
          unitPrice: q.unitPrice,
          total: q.total,
        },
      };
    },
    dedupeKey: (args) => JSON.stringify(args),
    async execute(job, { canDispatch }) {
      if (status().pending) return reconcile(job);
      let current = entry.controller.getSnapshot();
      if (
        current.boss?.id !== job.args.bossId ||
        current.battle?.id !== job.args.battleId ||
        current.battle?.status !== "active"
      )
        return { status: "failed", reason: "battle_finished" };
      try {
        await entry.controller.loadMedicines();
        current = entry.controller.getSnapshot();
        if (current.needsRefresh || current.error)
          return { status: "retry", reason: "Ожидаем игру." };
        if (
          current.battle?.id !== job.args.battleId ||
          current.battle?.status !== "active"
        )
          return { status: "failed", reason: "battle_finished" };
        const q = job.args.quote;
        const fresh = medicinePurchaseQuote(
          current.medicines,
          q.type,
          q.currency,
          q.quantity,
        );
        if (!fresh || fresh.unitPrice !== q.unitPrice)
          return { status: "failed", reason: "inventory_price_changed" };
        if (!canDispatch()) return { status: "retry" };
        entry.queueBattleDispatch = {
          id: job.id,
          canDispatch,
          operationId: null,
        };
        let result;
        try {
          result = await entry.assistant.buy(q, false, {
            queueId: job.id,
            beforeReserve: ({ operationId }) => {
              if (!canDispatch()) return false;
              entry.queueBattleDispatch.operationId = operationId;
              return true;
            },
          });
        } finally {
          entry.queueBattleDispatch = null;
        }
        if (confirmed(job)) return { status: "completed" };
        if (status().pending?.queueId === job.id)
          return { status: "uncertain", reason: "Проверяем результат." };
        if (result?.reason === "price_changed")
          return { status: "failed", reason: "inventory_price_changed" };
        if (result?.reason === "insufficient_balance")
          return { status: "failed", reason: "inventory_balance_insufficient" };
        if (result?.kind === "stop")
          return { status: "failed", reason: "healing_budget" };
        return { status: "retry", reason: "Ожидаем игру." };
      } catch (error) {
        return status().pending?.queueId === job.id
          ? { status: "uncertain", reason: "Проверяем результат." }
          : {
              status: "retry",
              reason: "Ожидаем игру.",
              retryAfterMs: error.retryAfterMs,
            };
      }
    },
    reconcile,
  };
}
