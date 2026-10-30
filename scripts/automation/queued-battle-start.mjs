import {
  battleRetryAfter,
  terminalBattlePreflight,
} from "./battle-preflight-error.mjs";

// The start checkpoint is written before POST; a lost result is read back,
// never submitted again until a previous request is proven unsent.
export function queuedBattleStartAdapter({ entry, getBoss, save }) {
  const state = () => entry.controller.getSnapshot();
  const confirmed = (job) =>
    (entry.manualBattle.receipts ?? []).includes(job.id);
  function finish(job) {
    entry.manualBattle.pending = null;
    if (!confirmed(job))
      entry.manualBattle.receipts = [
        ...entry.manualBattle.receipts.slice(-127),
        job.id,
      ];
    save(entry);
    if (entry.storageFailed) throw new Error("automation_storage_unavailable");
    return { status: "completed" };
  }
  async function loadBoss(job) {
    const current = state();
    if (current.boss?.id === job.args.bossId) return true;
    if (
      current.battle?.status === "active" ||
      current.pendingInvitation ||
      current.pending
    )
      return false;
    const boss = await getBoss(job.args.bossId);
    if (!boss) throw Object.assign(new Error("unknown_boss"), { status: 404 });
    await entry.controller.open(boss);
    return state().boss?.id === job.args.bossId;
  }
  async function reconcile(job) {
    if (confirmed(job)) return { status: "completed" };
    const pending = entry.manualBattle.pending;
    if (!pending) return { status: "retry", reason: "Ожидаем игру." };
    if (pending.id !== job.id)
      return { status: "retry", reason: "Проверяем предыдущее действие." };
    try {
      const previousBossId = state().boss?.id;
      const loaded = await loadBoss(job);
      const opening = state();
      if (
        previousBossId !== job.args.bossId &&
        (opening.needsRefresh || opening.error)
      )
        return {
          status: "uncertain",
          reason: "Ожидаем игру.",
          ...battleRetryAfter(opening),
        };
      if (!loaded)
        return { status: "uncertain", reason: "Проверяем результат." };
      await entry.controller.refresh({ discover: true });
      const current = state();
      if (
        !current.needsRefresh &&
        !current.error &&
        current.boss?.id === pending.bossId &&
        current.battle?.id &&
        current.battle.id !== pending.beforeBattleId
      )
        return finish(job);
      return {
        status: "uncertain",
        reason: current.error ? "Ожидаем игру." : "Проверяем результат.",
        ...battleRetryAfter(current),
      };
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
      if (!Number.isSafeInteger(args?.bossId) || args.bossId <= 0)
        throw new Error("invalid_boss");
      return { bossId: args.bossId };
    },
    dedupeKey: (args) => args.bossId,
    async execute(job, { canDispatch }) {
      if (entry.manualBattle.pending) return reconcile(job);
      try {
        const previousBossId = state().boss?.id;
        const loaded = await loadBoss(job);
        const opening = state();
        if (
          previousBossId !== job.args.bossId &&
          (opening.needsRefresh || opening.error)
        )
          return (
            terminalBattlePreflight(opening.errorStatus) ?? {
              status: "retry",
              reason: "Ожидаем игру.",
              ...battleRetryAfter(opening),
            }
          );
        if (!loaded)
          return { status: "retry", reason: "Ожидаем другие действия." };
        await entry.controller.refresh({ discover: true });
        let current = state();
        if (current.needsRefresh || current.error)
          return (
            terminalBattlePreflight(current.errorStatus) ?? {
              status: "retry",
              reason: "Ожидаем игру.",
              ...battleRetryAfter(current),
            }
          );
        if (
          current.battle?.status === "active" ||
          !current.canStart ||
          current.pendingInvitation ||
          current.purchaseUncertain ||
          current.purchase
        )
          return { status: "retry", reason: "Ожидаем другие действия." };
        if (!canDispatch()) return { status: "retry" };
        const beforeBattleId = current.battle?.id ?? null;
        entry.queueBattleDispatch = {
          id: job.id,
          kind: "manual_start",
          canDispatch,
          operationId: null,
        };
        const beforeSend = ({ operationId }) => {
          if (!canDispatch()) return false;
          entry.manualBattle.pending = {
            id: job.id,
            bossId: job.args.bossId,
            beforeBattleId,
            operationId,
          };
          entry.queueBattleDispatch.operationId = operationId;
          save(entry);
          if (entry.storageFailed)
            throw new Error("automation_storage_unavailable");
          return true;
        };
        try {
          if (beforeBattleId)
            await entry.controller.startNextBattle({
              allowed: canDispatch,
              beforeSend,
            });
          else await entry.controller.start({ beforeSend });
        } finally {
          entry.queueBattleDispatch = null;
        }
        current = state();
        if (
          entry.manualBattle.pending?.id === job.id &&
          !current.needsRefresh &&
          !current.error &&
          current.battle?.id &&
          current.battle.id !== beforeBattleId
        )
          return finish(job);
        return entry.manualBattle.pending?.id === job.id
          ? {
              status: "uncertain",
              reason: "Проверяем результат.",
              ...battleRetryAfter(current),
            }
          : { status: "retry", reason: "Ожидаем игру." };
      } catch (error) {
        return entry.manualBattle.pending?.id === job.id
          ? {
              status: "uncertain",
              reason: "Проверяем результат.",
              ...battleRetryAfter({ errorRetryAfterMs: error?.retryAfterMs }),
            }
          : error.status === 404
            ? { status: "failed", reason: "unknown_boss" }
            : {
                status: "retry",
                reason: "Ожидаем игру.",
                ...(Number.isFinite(error.retryAfterMs)
                  ? { retryAfterMs: error.retryAfterMs }
                  : {}),
              };
      }
    },
    reconcile,
  };
}
