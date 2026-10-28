// The work actor persists the pre-submit count and a confirmation receipt.
// No generic HTTP replay is used for the consuming mutation.
export function queuedWorkBoosterAdapter({ entry }) {
  const state = () => entry.workFarm.getSnapshot();
  const confirmed = (job) => (state().manualReceipts ?? []).includes(job.id);
  async function reconcile(job) {
    entry.queueActiveBooster = true;
    try {
      if (confirmed(job)) return { status: "completed" };
      const pending = state().manualPending;
      if (!pending) return { status: "retry", reason: "Ожидаем игру." };
      try {
        await entry.workFarm.refresh(pending.workId, { queued: true });
      } catch (error) {
        return {
          status: "uncertain",
          reason: [401, 403].includes(error.status)
            ? "game_session_required"
            : "Ожидаем игру.",
          retryAfterMs: error.retryAfterMs,
        };
      }
      if (confirmed(job)) return { status: "completed" };
      if (state().manualPending)
        return { status: "uncertain", reason: "Проверяем результат." };
      // A different older operation was confirmed; this one was never sent.
      return { status: "retry", reason: "Ожидаем игру." };
    } finally {
      entry.queueActiveBooster = false;
    }
  }
  return {
    dedupeKey: (args) => `${args.workId}:${args.type}`,
    validate(args) {
      if (
        !Number.isSafeInteger(args?.workId) ||
        args.workId <= 0 ||
        !["small", "full"].includes(args.type)
      )
        throw new Error("invalid_work_booster");
      return { workId: args.workId, type: args.type };
    },
    async execute(job, { canDispatch }) {
      const wasRunning = entry.workFarm.running();
      if (wasRunning && !entry.workFarm.suspendForManual())
        return { status: "retry" };
      try {
        return await executeSuspended(job, canDispatch);
      } finally {
        if (wasRunning) entry.workFarm.resume();
      }
    },
    async reconcile(job) {
      const wasRunning = entry.workFarm.running();
      if (wasRunning && !entry.workFarm.suspendForManual())
        return { status: "uncertain", reason: "Ожидаем другие действия." };
      try {
        return await reconcile(job);
      } finally {
        if (wasRunning) entry.workFarm.resume();
      }
    },
  };

  async function executeSuspended(job, canDispatch) {
    if (state().manualPending) {
      const result = await reconcile(job);
      if (result.status !== "retry" || state().manualPending) return result;
    }
    entry.queueActiveBooster = true;
    try {
      await entry.workFarm.useBooster(job.args.workId, job.args.type, {
        queued: true,
        commandId: job.id,
        canDispatch,
      });
      if (confirmed(job)) return { status: "completed" };
      return { status: "uncertain", reason: "Проверяем результат." };
    } catch (error) {
      if (state().manualPending?.commandId === job.id)
        return {
          status: "uncertain",
          reason: [401, 403].includes(error.status)
            ? "game_session_required"
            : "Проверяем результат.",
          retryAfterMs: error.retryAfterMs,
        };
      if ([401, 403].includes(error.status))
        return { status: "failed", reason: "game_session_required" };
      if (
        !canDispatch() ||
        error?.notDispatched ||
        /Дождитесь завершения/.test(error.message)
      )
        return {
          status: "retry",
          reason: error.retryAfterMs ? "Ожидаем игру." : null,
          retryAfterMs: error.retryAfterMs,
        };
      if (
        /Нет доступного|отсутствует в справочнике|Выберите дефибриллятор/.test(
          error.message,
        )
      )
        return { status: "failed", reason: "work_booster_unavailable" };
      return {
        status: "retry",
        reason: "Ожидаем игру.",
        retryAfterMs: error.retryAfterMs,
      };
    } finally {
      entry.queueActiveBooster = false;
    }
  }
}
