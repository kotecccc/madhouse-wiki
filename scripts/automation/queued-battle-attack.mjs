import { canAttackBattle } from "../../src/features/bosses/BossBattle/boss-battle-controller.js";
import {
  battleRetryAfter,
  terminalBattlePreflight,
} from "./battle-preflight-error.mjs";

// A queued strike is tied to one battle. Damage totals do not identify the
// operation that caused them, so a lost response remains unresolved.
export function queuedBattleAttackAdapter({ entry, save, now = Date.now }) {
  const state = () => entry.controller.getSnapshot();
  const confirmed = (job) =>
    (entry.manualBattle.receipts ?? []).includes(job.id);
  function finish(job, status = "completed") {
    entry.manualBattle.pending = null;
    if (status === "completed" && !confirmed(job))
      entry.manualBattle.receipts = [
        ...entry.manualBattle.receipts.slice(-127),
        job.id,
      ];
    save(entry);
    if (entry.storageFailed) throw new Error("automation_storage_unavailable");
    return status === "completed"
      ? { status }
      : { status, reason: "battle_finished" };
  }
  async function reconcile(job) {
    if (confirmed(job)) return { status: "completed" };
    const pending = entry.manualBattle.pending;
    if (!pending) return { status: "retry", reason: "Ожидаем игру." };
    if (pending.id !== job.id)
      return { status: "retry", reason: "Проверяем предыдущее действие." };
    try {
      if (
        state().boss?.id !== job.args.bossId ||
        state().battle?.id !== job.args.battleId
      )
        return { status: "uncertain", reason: "Проверяем результат." };
      await entry.controller.refresh();
      const current = state();
      if (
        !current.needsRefresh &&
        !current.error &&
        current.battle?.id === pending.battleId &&
        Number.isFinite(pending.beforeDamage) &&
        Number.isFinite(current.battle.totalDamage) &&
        current.battle.totalDamage > pending.beforeDamage
      ) {
        // Another client can produce the increase, even on a direct route.
        return {
          status: "uncertain",
          reason: "Результат удара нельзя однозначно подтвердить.",
        };
      }
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
      if (
        !Number.isSafeInteger(args?.bossId) ||
        args.bossId <= 0 ||
        typeof args?.battleId !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(args.battleId)
      )
        throw new Error("invalid_battle");
      return { bossId: args.bossId, battleId: args.battleId };
    },
    dedupeKey: (args) => args.battleId,
    async execute(job, { canDispatch }) {
      if (entry.manualBattle.pending) return reconcile(job);
      try {
        let current = state();
        if (
          current.boss?.id !== job.args.bossId ||
          current.battle?.id !== job.args.battleId
        )
          return { status: "failed", reason: "battle_finished" };
        await entry.controller.refresh();
        current = state();
        if (current.needsRefresh || current.error)
          return (
            terminalBattlePreflight(current.errorStatus) ?? {
              status: "retry",
              reason: "Ожидаем игру.",
              ...battleRetryAfter(current),
            }
          );
        if (
          current.battle?.id !== job.args.battleId ||
          current.battle?.status !== "active"
        )
          return { status: "failed", reason: "battle_finished" };
        if (!canDispatch() || !canAttackBattle(current, now()))
          return { status: "retry", reason: "Ожидаем другие действия." };
        entry.queueBattleDispatch = {
          id: job.id,
          canDispatch,
          operationId: null,
        };
        const beforeSend = ({ operationId }) => {
          if (!canDispatch()) return false;
          entry.manualBattle.pending = {
            id: job.id,
            kind: "attack",
            bossId: job.args.bossId,
            battleId: job.args.battleId,
            beforeDamage: current.battle.totalDamage ?? null,
            operationId,
          };
          entry.queueBattleDispatch.operationId = operationId;
          save(entry);
          if (entry.storageFailed)
            throw new Error("automation_storage_unavailable");
          return true;
        };
        let result;
        try {
          result = await entry.controller.attack({ beforeSend });
        } finally {
          entry.queueBattleDispatch = null;
        }
        if (
          entry.manualBattle.pending?.id === job.id &&
          result?.confirmed === true
        )
          return finish(job);
        if (entry.manualBattle.pending?.id === job.id && result?.battleFinished)
          return finish(job, "failed");
        return entry.manualBattle.pending?.id === job.id
          ? {
              status: "uncertain",
              reason: "Проверяем результат.",
              ...battleRetryAfter(state()),
            }
          : { status: "retry", reason: "Ожидаем игру." };
      } catch (error) {
        return entry.manualBattle.pending?.id === job.id
          ? {
              status: "uncertain",
              reason: "Проверяем результат.",
              ...battleRetryAfter({ errorRetryAfterMs: error?.retryAfterMs }),
            }
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
