import { businessPlan } from "./business-assistant.mjs";

// The collector owns the long-running checkpoint; this adapter only starts it.
export function queuedBusinessRunAdapter({ entry, getCatalogue }) {
  const started = (job) =>
    entry.businessHelper.run?.queueId === job.id ||
    (entry.businessHelper.startReceipts ?? []).includes(job.id);
  return {
    validate(args) {
      if (
        typeof args?.businessId !== "string" ||
        args.businessId.length > 100 ||
        !args.expectedPlan ||
        !Array.isArray(args.expectedMissing) ||
        args.expectedMissing.length > 100
      )
        throw new Error("invalid_business_run");
      const plan = businessPlan(
        entry.businessHelper,
        getCatalogue(),
        args.businessId,
      );
      const config = plan.config;
      const expected = args.expectedPlan;
      if (
        [
          "targetLevel",
          "currentLevelOverride",
          "maxAttempts",
          "durationHours",
        ].some((key) => config[key] !== expected[key]) ||
        Boolean(config.autoUpgrade) !== Boolean(expected.autoUpgrade) ||
        JSON.stringify(Object.entries(config.bossChoices).sort()) !==
          JSON.stringify(Object.entries(expected.bossChoices || {}).sort())
      )
        throw new Error("business_stock_changed");
      const missing = plan.materials
        .filter((item) => item.missingAmount > 0)
        .map((item) => ({ itemId: item.entityId, amount: item.missingAmount }));
      if (JSON.stringify(missing) !== JSON.stringify(args.expectedMissing))
        throw new Error("business_stock_changed");
      return {
        businessId: args.businessId,
        expectedPlan: structuredClone(config),
        expectedMissing: missing,
        replaceExisting: false,
      };
    },
    dedupeKey: (args) => args.businessId,
    async execute(job, { canDispatch }) {
      if (started(job)) return { status: "completed" };
      if (!canDispatch()) return { status: "retry" };
      try {
        entry.collector.start(job.args, { queueId: job.id });
        return started(job)
          ? { status: "completed" }
          : { status: "uncertain", reason: "Проверяем результат." };
      } catch (error) {
        if (
          [
            "business_run_active",
            "business_action_pending",
            "business_active_battle",
            "business_goal_exists",
          ].includes(error.message)
        )
          return { status: "retry", reason: "Ожидаем другие действия." };
        return { status: "failed", reason: error.message };
      }
    },
    async reconcile(job) {
      // The run and its queue ID are committed together before any game action.
      if (started(job)) return { status: "completed" };
      if (entry.businessHelper.run)
        return { status: "uncertain", reason: "Проверяем результат." };
      return { status: "retry" };
    },
  };
}
