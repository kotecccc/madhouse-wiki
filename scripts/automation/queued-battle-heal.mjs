// The assistant owns the per-battle limits and reserves stock before sending.
export function queuedBattleHealAdapter({ entry }) {
  const status = () => entry.assistant.queuedState();
  const confirmed = (job) => status().receipts.includes(job.id);
  async function reconcile(job) {
    if (confirmed(job)) return { status: "completed" };
    const pending = status().pending;
    if (!pending) return { status: "retry", reason: "Ожидаем игру." };
    if (pending.queueId !== job.id)
      return { status: "retry", reason: "Проверяем предыдущее действие." };
    try {
      return (await entry.assistant.reconcileQueuedHeal(job.id))
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
      if (
        !Number.isSafeInteger(args?.bossId) ||
        args.bossId <= 0 ||
        typeof args?.battleId !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(args.battleId) ||
        !["heal_10", "heal_full"].includes(args.type)
      )
        throw new Error("invalid_battle_healing");
      return { bossId: args.bossId, battleId: args.battleId, type: args.type };
    },
    dedupeKey: (args) => `${args.battleId}:${args.type}`,
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
        if (current.battle.playerHealth >= current.battle.playerMaxHealth)
          return { status: "failed", reason: "healing_not_needed" };
        const item = current.medicines?.find(
          (medicine) => medicine.type === job.args.type,
        );
        if (!item || !Number.isSafeInteger(item.quantity))
          return { status: "retry", reason: "Ожидаем игру." };
        if (item.quantity <= 0)
          return { status: "failed", reason: "healing_unavailable" };
        if (!canDispatch()) return { status: "retry" };
        entry.queueBattleDispatch = {
          id: job.id,
          canDispatch,
          operationId: null,
        };
        let result;
        try {
          result = await entry.assistant.use(job.args.type, false, {
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
        if (result?.kind === "stop")
          return { status: "failed", reason: "healing_limit" };
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
