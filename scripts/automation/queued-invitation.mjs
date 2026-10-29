import {
  battleRetryAfter,
  terminalBattlePreflight,
} from "./battle-preflight-error.mjs";

// Invitation identity and expiry come from the server's saved invitation list.
export function queuedInvitationAdapter({
  entry,
  accept,
  refresh,
  save,
  now = Date.now,
}) {
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
  function joined(job) {
    const current = state();
    return (
      !current.needsRefresh &&
      !current.error &&
      !current.pendingInvitation &&
      current.invitationOnly &&
      current.boss?.id === job.args.bossId &&
      current.battle?.id === job.args.battleId
    );
  }
  async function reconcile(job) {
    if (confirmed(job)) return { status: "completed" };
    const pending = entry.manualBattle.pending;
    if (!pending) return { status: "retry", reason: "Ожидаем игру." };
    if (pending.id !== job.id)
      return { status: "retry", reason: "Проверяем предыдущее действие." };
    try {
      await refresh();
      if (joined(job)) return finish(job);
      // Expiry only prevents a new acceptance. The battle may have been
      // joined and ended while the response was lost, so it cannot prove
      // that an already submitted acceptance failed.
      return { status: "uncertain", reason: "Проверяем результат." };
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
        typeof args?.invitationId !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(args.invitationId) ||
        typeof args.battleId !== "string" ||
        !/^[A-Za-z0-9_-]{1,120}$/.test(args.battleId) ||
        !Number.isSafeInteger(args.bossId) ||
        args.bossId <= 0 ||
        !Number.isFinite(args.expiresAt)
      )
        throw new Error("invalid_invitation");
      return {
        invitationId: args.invitationId,
        battleId: args.battleId,
        bossId: args.bossId,
        expiresAt: args.expiresAt,
        ...(Number.isSafeInteger(args.leaderPlayerId)
          ? { leaderPlayerId: args.leaderPlayerId }
          : {}),
        ...(Number.isSafeInteger(args.inviterPlayerId)
          ? { inviterPlayerId: args.inviterPlayerId }
          : {}),
      };
    },
    dedupeKey: (args) => args.invitationId,
    async execute(job, { canDispatch }) {
      if (entry.manualBattle.pending) return reconcile(job);
      if (job.args.expiresAt <= now())
        return { status: "failed", reason: "invitation_expired" };
      const permitted = () => canDispatch() && now() < job.args.expiresAt;
      entry.queueBattleDispatch = {
        id: job.id,
        canDispatch: permitted,
        operationId: null,
      };
      try {
        await accept(
          job.args.invitationId,
          permitted,
          job.args,
          ({ operationId }) => {
            if (!permitted()) return false;
            entry.manualBattle.pending = {
              id: job.id,
              kind: "invitation",
              bossId: job.args.bossId,
              battleId: job.args.battleId,
              invitationId: job.args.invitationId,
              expiresAt: job.args.expiresAt,
              operationId,
            };
            entry.queueBattleDispatch.operationId = operationId;
            save(entry);
            if (entry.storageFailed)
              throw new Error("automation_storage_unavailable");
            return true;
          },
        );
        if (joined(job) && (entry.manualBattle.pending || canDispatch()))
          return finish(job);
        return entry.manualBattle.pending?.id === job.id
          ? { status: "uncertain", reason: "Проверяем результат." }
          : { status: "retry", reason: "Ожидаем игру." };
      } catch (error) {
        if (entry.manualBattle.pending?.id === job.id)
          return {
            status: "uncertain",
            reason: "Проверяем результат.",
            ...battleRetryAfter(
              Number.isFinite(error.retryAfterMs)
                ? { errorRetryAfterMs: error.retryAfterMs }
                : state(),
            ),
          };
        if (
          ["invitation_unavailable", "invitation_identity_changed"].includes(
            error.message,
          )
        )
          return { status: "failed", reason: "invitation_expired" };
        const terminal = terminalBattlePreflight(error?.status);
        if (terminal) return terminal;
        return {
          status: "retry",
          reason: "Ожидаем игру.",
          ...battleRetryAfter(
            Number.isFinite(error.retryAfterMs)
              ? { errorRetryAfterMs: error.retryAfterMs }
              : state(),
          ),
        };
      } finally {
        entry.queueBattleDispatch = null;
      }
    },
    reconcile,
  };
}
