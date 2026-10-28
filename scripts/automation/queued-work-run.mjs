const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const positive = (value) => nonnegative(value) && value > 0;

export function queuedWorkRunAdapter({ entry }) {
  const started = (job) =>
    entry.workFarm.getSnapshot().startReceipts?.includes(job.id) ||
    entry.workFarm.getSnapshot().run?.queueId === job.id;
  return {
    validate(args) {
      if (
        !positive(args?.workId) ||
        !positive(args.targetCycles) ||
        !nonnegative(args.expectedCompletedCycles) ||
        args.targetCycles <= args.expectedCompletedCycles ||
        args.targetCycles - args.expectedCompletedCycles > 1000 ||
        !positive(args.maxActions) ||
        args.maxActions > 30000 ||
        (args.durationHours != null &&
          ![1, 2, 4].includes(args.durationHours)) ||
        !["wait", "boosters", "energy"].includes(args.mode) ||
        !nonnegative(args.maxBoosters) ||
        args.maxBoosters > 1000 ||
        !nonnegative(args.maxDollar) ||
        typeof args.allowPurchase !== "boolean" ||
        (args.collectStash != null && typeof args.collectStash !== "boolean") ||
        (args.energyBudget != null && !nonnegative(args.energyBudget))
      )
        throw new Error("invalid_work_run");
      return {
        workId: args.workId,
        targetCycles: args.targetCycles,
        expectedCompletedCycles: args.expectedCompletedCycles,
        mode: args.mode,
        maxActions: args.maxActions,
        durationHours: args.durationHours ?? null,
        maxBoosters: args.mode === "energy" ? 0 : args.maxBoosters,
        maxDollar: args.mode === "energy" ? 0 : args.maxDollar,
        allowPurchase: args.mode === "energy" ? false : args.allowPurchase,
        ...(args.collectStash ? { collectStash: true } : {}),
        ...(args.mode === "energy" && args.energyBudget != null
          ? { energyBudget: args.energyBudget }
          : {}),
      };
    },
    dedupeKey: (args) => JSON.stringify(args),
    async execute(job, { canDispatch }) {
      if (started(job)) return { status: "completed" };
      if (!canDispatch())
        return { status: "retry", reason: "Ожидаем другие действия." };
      try {
        entry.workFarm.start(job.args, { queueId: job.id });
        if (entry.storageFailed) return { status: "uncertain" };
        return { status: "completed" };
      } catch {
        if (entry.storageFailed) return { status: "uncertain" };
        return { status: "failed", reason: "invalid_work_run" };
      }
    },
    async reconcile(job) {
      return started(job) ? { status: "completed" } : { status: "retry" };
    },
  };
}
