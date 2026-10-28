import { planFloorProgress } from "./floor-plan.mjs";
import {
  businessPlan,
  refreshBusiness,
  saveBusiness,
} from "./business-assistant.mjs";

export function createFloorActions({
  entry,
  get,
  getCatalogue,
  getBoss,
  refreshAutoDamageLimit,
  configureAutoGoal,
  now,
}) {
  const hasOtherWork = () => {
    const state = entry.controller.getSnapshot();
    return (
      entry.workFarm.running() ||
      entry.collector.running() ||
      entry.auto.getSnapshot().enabled ||
      entry.raidWorker.getSnapshot().enabled ||
      (entry.raidSubscription.getSnapshot().enabled &&
        entry.raidSubscription.getSnapshot().mode !== "buddy") ||
      entry.raidSubscription.getSnapshot().checkpoint ||
      entry.goal.getSnapshot()?.status === "active" ||
      state.battle?.status === "active" ||
      state.pending ||
      state.pendingInvitation ||
      state.needsRefresh ||
      state.purchase ||
      state.purchaseUncertain ||
      entry.workFarm.getSnapshot().manualPending ||
      entry.workFarm.getSnapshot().run?.pending ||
      entry.businessHelper.run?.pendingUpgrade ||
      entry.characterUpgrade?.pending ||
      entry.characterBatch?.running() ||
      entry.equipment?.pending
    );
  };
  return {
    hasOtherWork,
    async plan({ bossId = null } = {}) {
      const catalogue = getCatalogue();
      const floors = await get("/api/floors");
      const current = [...catalogue.floors]
        .reverse()
        .find((floor) =>
          floors.some(
            (item) => item.code === floor.code && item.isAvailable === true,
          ),
        );
      if (!current)
        return { status: "waiting", reason: "Доступный этаж не подтверждён." };
      const info = await get(
        `/api/floors/${encodeURIComponent(current.code)}/info`,
      );
      return planFloorProgress({
        floors,
        info,
        catalogue,
        targetBossId: bossId,
      });
    },
    async launch(target, allowed) {
      if (!allowed() || hasOtherWork()) throw new Error("floor_resources_busy");
      if (target.kind === "work") {
        entry.workFarm.start({
          workId: target.apiId,
          targetCycles: target.required,
          expectedCompletedCycles: target.current,
          mode: "wait",
          maxActions: 30000,
          maxBoosters: 0,
          maxDollar: 0,
          allowPurchase: false,
          durationHours: null,
        });
        return;
      }
      if (target.kind === "boss") {
        const boss = await getBoss(target.apiId);
        if (!allowed() || !boss || hasOtherWork())
          throw new Error("floor_boss_unavailable");
        await entry.controller.open(boss, { refresh: true });
        if (!allowed()) return;
        const state = entry.controller.getSnapshot();
        if (
          state.pending ||
          state.battle?.status === "active" ||
          state.needsRefresh ||
          state.error
        )
          throw new Error("floor_battle_unavailable");
        configureAutoGoal(
          entry,
          {
            bossId: target.apiId,
            kind: "battles",
            targetCount: target.required - target.current,
            countWins: true,
          },
          state,
        );
        if (!(await refreshAutoDamageLimit(entry)) || !allowed())
          throw new Error("floor_battle_unavailable");
        if (
          !entry.assistant.begin(
            `${state.boss.id}:${entry.goal.getSnapshot()?.startedAt ?? "single"}`,
          ) ||
          !entry.raidWorker.start(target.apiId)
        )
          throw new Error("floor_battle_unavailable");
        return;
      }
      if (target.kind === "business") {
        const helper = entry.businessHelper,
          catalogue = getCatalogue();
        if (
          !(await refreshBusiness(helper, catalogue, target.entityId, {
            get,
            now,
          })) ||
          !allowed()
        )
          throw new Error("floor_business_unavailable");
        saveBusiness(helper, catalogue, {
          businessId: target.entityId,
          targetLevel: target.required,
          currentLevelOverride: null,
          maxAttempts: 30000,
          durationHours: null,
          autoUpgrade: true,
          bossChoices: {},
        });
        const plan = businessPlan(helper, catalogue, target.entityId);
        if (
          plan.currentLevelSource !== "game" ||
          plan.currentLevel !== target.current ||
          !plan.canCreateGoals
        )
          throw new Error("floor_business_unavailable");
        entry.collector.start({
          businessId: target.entityId,
          expectedPlan: plan.config,
          expectedMissing: plan.materials
            .filter((item) => item.missingAmount > 0)
            .map((item) => ({
              itemId: item.entityId,
              amount: item.missingAmount,
            })),
        });
        return;
      }
      throw new Error("floor_target_unknown");
    },
    async observe(target) {
      if (target.kind === "work") {
        const run = entry.workFarm.getSnapshot().run;
        if (
          run?.workId !== target.apiId ||
          run.targetCycles !== target.required
        )
          return "unknown";
        if (
          run.status === "limited" &&
          !run.pending &&
          run.completedCycles > target.current
        )
          return "partial";
        return run.status === "running"
          ? "running"
          : run.status === "completed"
            ? "completed"
            : "unknown";
      }
      if (target.kind === "business") {
        const run = entry.businessHelper.run;
        if (
          run?.businessId !== target.entityId ||
          run.targetLevel !== target.required
        )
          return "unknown";
        return run.status === "running"
          ? "running"
          : run.status === "completed"
            ? "completed"
            : "unknown";
      }
      if (target.kind === "boss") {
        const goal = entry.goal.getSnapshot();
        if (goal?.boss?.id !== target.apiId) return "unknown";
        if (
          goal.status === "completed" &&
          (entry.raidWorker.getSnapshot().enabled ||
            entry.auto.getSnapshot().enabled)
        )
          return "running";
        if (
          goal.status === "active" &&
          (entry.raidWorker.getSnapshot().enabled ||
            entry.auto.getSnapshot().enabled)
        )
          return "running";
        return goal.status === "completed" ? "completed" : "unknown";
      }
      return "unknown";
    },
    stopOwned(target) {
      if (entry.raidSubscription.getSnapshot().checkpoint?.floorOwned) {
        if (
          target?.kind === "work" &&
          entry.workFarm.getSnapshot().run?.workId === target.apiId
        )
          entry.workFarm.stop();
        if (
          target?.kind === "business" &&
          entry.businessHelper.run?.businessId === target.entityId &&
          !entry.collector.discardSuspended()
        )
          throw new Error("floor_suspended_stop_unavailable");
        if (
          target?.kind === "boss" &&
          entry.raidWorker.getSnapshot().bossId === target.apiId &&
          !entry.raidWorker.discardSuspended()
        )
          throw new Error("floor_suspended_stop_unavailable");
        return;
      }
      if (
        target?.kind === "work" &&
        entry.workFarm.getSnapshot().run?.workId === target.apiId
      )
        entry.workFarm.stop();
      if (
        target?.kind === "business" &&
        entry.businessHelper.run?.businessId === target.entityId
      )
        entry.collector.stop();
      if (
        target?.kind === "boss" &&
        entry.goal.getSnapshot()?.boss?.id === target.apiId
      ) {
        entry.raidWorker.finishAfterCurrent();
      }
    },
  };
}
