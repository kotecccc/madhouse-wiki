import { randomUUID } from "node:crypto";
import { businessPlan, refreshBusiness } from "./business-assistant.mjs";
import { resolveBossGoal } from "../../src/features/bosses/BossBattle/boss-goal-options.js";

const terminal = new Set(["won", "lost", "expired", "surrendered"]);
const retryable = new Set(["unknown", "battle"]);
const retryDelay = (failures) =>
  Math.min(300000, 15000 * 2 ** Math.min(failures, 4));
const reasons = {
  stopped: "Сбор остановлен пользователем.",
  completed: "Все материалы для выбранного уровня собраны.",
  limit: "Достигнут общий лимит боёв.",
  deadline: "Истекло время сбора.",
  unknown:
    "Не удалось подтвердить запасы, уровень или источники материалов. Сбор остановлен.",
  battle:
    "Бой требует проверки. Сбор остановлен без повторения игрового действия.",
  changed: "Расчёт изменился. Проверьте материалы и запустите сбор заново.",
};

// Server-only orchestration above the existing single-boss series. The private
// helper record owns the frozen route, global budget and restart checkpoint.
export function createBusinessCollector({
  helper,
  controller,
  goal,
  auto,
  getCatalogue,
  getBoss,
  get,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  onChange,
}) {
  let timer = null,
    generation = 0,
    working = false,
    disposed = false,
    armed = false;
  const running = () => helper.run?.status === "running";
  const changed = () => onChange?.();
  function clear() {
    if (timer != null) cancel(timer);
    timer = null;
  }
  function finish(status, code) {
    if (!running()) return;
    generation++;
    clear();
    helper.run.status = status;
    helper.run.reason = reasons[code] || reasons.battle;
    helper.run.phase = "stopped";
    // Commit the stop intent before callbacks from the inner engines.
    changed();
    auto.stop();
    if (helper.run.ownsGoal) goal.stop();
  }
  function observeBattle() {
    const run = helper.run,
      state = controller.getSnapshot(),
      battle = state.battle;
    if (
      !running() ||
      !battle?.id ||
      state.boss?.id !== run.bossId ||
      battle.id === run.excludedBattleId ||
      (run.phase !== "farming" && battle.status !== "active")
    )
      return;
    let dirty = false;
    if (!run.attemptIds.includes(battle.id)) {
      run.attemptIds.push(battle.id);
      dirty = true;
    }
    if (
      terminal.has(battle.status) &&
      !state.needsRefresh &&
      !run.completedIds.includes(battle.id)
    ) {
      run.completedIds.push(battle.id);
      dirty = true;
    }
    run.battlesStarted = run.attemptIds.length;
    run.battlesCompleted = run.completedIds.length;
    if (dirty) changed();
  }
  function withinTime() {
    return (
      !running() ||
      helper.run.deadlineAt == null ||
      now() < helper.run.deadlineAt
    );
  }
  function canStartBattle() {
    observeBattle();
    return (
      !running() ||
      (withinTime() &&
        (helper.run.maxBattles == null ||
          helper.run.battlesStarted < helper.run.maxBattles))
    );
  }
  function queue(delay = 0) {
    if (timer != null || working || !armed || !running() || disposed) return;
    const id = generation;
    timer = schedule(
      () => {
        timer = null;
        void step(id);
      },
      Math.max(delay, (helper.run.nextRetryAt ?? 0) - now(), 0),
    );
  }
  function evaluate() {
    if (!armed || !running() || disposed) return;
    observeBattle();
    if (!withinTime()) {
      finish("limited", "deadline");
      return;
    }
    if (working) return;
    if ((helper.run.nextRetryAt ?? 0) > now()) {
      queue(helper.run.nextRetryAt - now());
      return;
    }
    const state = controller.getSnapshot(),
      current = goal.getSnapshot();
    if (state.pending) return;
    if (helper.run.phase !== "farming") {
      queue();
      return;
    }
    if (state.error || state.needsRefresh || current?.rewardUncertain) {
      scheduleRetry();
      return;
    }
    if (current?.status === "completed") {
      queue();
      return;
    }
    if (!canStartBattle() && state.battle?.status !== "active") {
      finish("limited", "limit");
      return;
    }
    if (!auto.getSnapshot().enabled) scheduleRetry();
  }
  function scheduleRetry(error) {
    if (!running()) return;
    if (
      error &&
      !retryable.has(error.message) &&
      !(error instanceof TypeError)
    ) {
      finish("error", error.message);
      return;
    }
    const run = helper.run;
    run.failures = (run.failures ?? 0) + 1;
    run.phase = "retrying";
    run.reason =
      "Игровые данные временно недоступны. Цель сохранена; повторим проверку.";
    run.nextRetryAt = now() + retryDelay(run.failures);
    changed();
    queue(run.nextRetryAt - now());
  }
  function checkedPlan() {
    const run = helper.run;
    const plan = businessPlan(
      helper,
      getCatalogue(),
      run.businessId,
      run.config,
    );
    const actual = helper.resources.details[run.businessId]?.level;
    if (
      !plan.canCreateGoals ||
      (plan.currentLevelSource === "manual" &&
        actual != null &&
        actual !== plan.currentLevel) ||
      plan.materials.some(
        (item) =>
          item.missingAmount == null ||
          (item.missingAmount > 0 && !item.bosses.length),
      )
    )
      throw new Error("unknown");
    return plan;
  }
  async function step(id) {
    if (working || !running() || generation !== id || disposed) return;
    working = true;
    const valid = () =>
      !disposed && running() && generation === id && withinTime();
    try {
      auto.stop();
      helper.run.phase = "verifying";
      changed();
      const complete = await refreshBusiness(
        helper,
        getCatalogue(),
        helper.run.businessId,
        { get, now },
      );
      if (!valid()) return;
      if (!complete) throw new Error("unknown");
      const controllerState = controller.getSnapshot();
      if (controllerState.error || controllerState.needsRefresh) {
        await controller.refresh({ discover: true });
        if (!valid()) return;
      }
      const plan = checkedPlan(),
        run = helper.run;
      if (
        run.checkExpected &&
        JSON.stringify(
          plan.materials
            .filter((item) => item.missingAmount > 0)
            .map((item) => ({
              itemId: item.entityId,
              amount: item.missingAmount,
            })),
        ) !== JSON.stringify(run.expectedMissing)
      )
        throw new Error("changed");
      run.checkExpected = false;
      run.failures = 0;
      run.nextRetryAt = null;
      run.reason = null;
      run.materials = plan.materials.map((item) => ({
        itemId: item.entityId,
        name: item.name,
        targetAmount: item.requiredAmount,
        collectedAmount: item.ownedAmount,
        missingAmount: item.missingAmount,
      }));
      changed();
      const material = plan.materials.find((item) => item.missingAmount > 0);
      if (!material) {
        finish("completed", "completed");
        return;
      }
      if (
        !canStartBattle() &&
        controller.getSnapshot().battle?.status !== "active"
      ) {
        finish("limited", "limit");
        return;
      }
      const bossId =
        run.config.bossChoices?.[material.entityId] ?? material.bosses[0]?.id;
      if (!material.bosses.some((boss) => boss.id === bossId))
        throw new Error("unknown");
      const before = controller.getSnapshot();
      if (
        before.pending ||
        before.needsRefresh ||
        before.purchaseUncertain ||
        (before.battle?.status === "active" && before.boss?.id !== bossId)
      )
        throw new Error("battle");
      run.phase = "opening";
      run.currentItemId = material.entityId;
      run.currentItemName = material.name;
      run.bossId = bossId;
      run.bossName = material.bosses.find((boss) => boss.id === bossId).name;
      changed();
      const boss = await getBoss(bossId);
      if (!valid()) return;
      if (!boss) throw new Error("unknown");
      await controller.open(boss);
      if (!valid()) return;
      const state = controller.getSnapshot();
      if (
        state.pending ||
        state.needsRefresh ||
        state.error ||
        state.boss?.id !== bossId
      )
        throw new Error("battle");
      run.excludedBattleId = terminal.has(state.battle?.status)
        ? state.battle.id
        : null;
      observeBattle();
      run.ownsGoal = true;
      goal.configure(
        resolveBossGoal(
          {
            bossId,
            kind: "business_items",
            itemKey: `activity_item:${material.entityId}`,
            targetCount: material.missingAmount,
            maxAttempts: null,
          },
          state.boss,
        ),
      );
      if (!valid()) return;
      run.phase = "farming";
      changed();
      if (!auto.start()) throw new Error("battle");
    } catch (error) {
      if (generation === id && running()) scheduleRetry(error);
    } finally {
      working = false;
      if (generation === id) evaluate();
    }
  }
  const unsubscribers = [controller, goal, auto].map((source) =>
    source.subscribe(evaluate),
  );
  return {
    running,
    canStartBattle,
    withinTime,
    tick: evaluate,
    start(args) {
      if (running() || working) throw new Error("business_run_active");
      const plan = businessPlan(helper, getCatalogue(), args.businessId);
      const config = plan.config;
      const expected = args.expectedPlan;
      if (
        !expected ||
        [
          "targetLevel",
          "currentLevelOverride",
          "maxAttempts",
          "durationHours",
        ].some((key) => config[key] !== expected[key]) ||
        JSON.stringify(Object.entries(config.bossChoices).sort()) !==
          JSON.stringify(Object.entries(expected.bossChoices || {}).sort())
      )
        throw new Error("business_stock_changed");
      if (config.maxAttempts == null && config.durationHours == null)
        throw new Error("business_run_limit_required");
      if (
        !plan.canCreateGoals ||
        !plan.materials.some((item) => item.missingAmount > 0) ||
        plan.materials.some(
          (item) =>
            item.missingAmount > 0 &&
            (!item.bosses.length ||
              !item.bosses.some(
                (boss) =>
                  boss.id ===
                  (config.bossChoices[item.entityId] ?? item.bosses[0]?.id),
              )),
        )
      )
        throw new Error("business_missing_unknown");
      const first = plan.materials.find((item) => item.missingAmount > 0);
      const firstBoss =
        config.bossChoices?.[first.entityId] ?? first.bosses[0].id;
      const state = controller.getSnapshot();
      if (state.pending || state.needsRefresh || state.purchaseUncertain)
        throw new Error("business_action_pending");
      if (state.battle?.status === "active" && state.boss?.id !== firstBoss)
        throw new Error("business_active_battle");
      if (
        goal.getSnapshot()?.status === "active" &&
        args.replaceExisting !== true
      )
        throw new Error("business_goal_exists");
      auto.stop();
      goal.stop();
      generation++;
      helper.run = {
        id: randomUUID(),
        status: "running",
        phase: "preparing",
        businessId: plan.businessId,
        name: plan.name,
        targetLevel: plan.targetLevel,
        config: structuredClone(config),
        startedAt: now(),
        deadlineAt:
          config.durationHours == null
            ? null
            : now() + config.durationHours * 3600000,
        maxBattles: config.maxAttempts,
        battlesStarted: 0,
        battlesCompleted: 0,
        attemptIds: [],
        completedIds: [],
        materials: [],
        checkExpected: true,
        expectedMissing: args.expectedMissing,
        ownsGoal: false,
        reason: null,
      };
      armed = true;
      changed();
      queue();
    },
    stop() {
      finish("stopped", "stopped");
    },
    resume(checkpoint, unsafe = false) {
      if (!running()) return;
      armed = true;
      if (unsafe) {
        scheduleRetry();
        return;
      }
      if (!withinTime()) {
        finish("limited", "deadline");
        return;
      }
      if (
        helper.run.phase === "farming" &&
        goal.getSnapshot()?.status === "active"
      ) {
        if (!auto.start({ checkpoint })) scheduleRetry();
        else evaluate();
      } else queue();
    },
    dispose() {
      disposed = true;
      generation++;
      clear();
      for (const unsub of unsubscribers) unsub();
    },
  };
}
