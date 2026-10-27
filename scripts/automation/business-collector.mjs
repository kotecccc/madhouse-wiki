import { randomUUID } from "node:crypto";
import { businessPlan, refreshBusiness } from "./business-assistant.mjs";
import { resolveBossGoal } from "../../src/features/bosses/BossBattle/boss-goal-options.js";

const terminal = new Set(["won", "lost", "expired", "surrendered"]);
const retryable = new Set(["unknown", "battle", "game_session_unavailable"]);
const retryDelay = (failures) =>
  Math.min(300000, 15000 * 2 ** Math.min(failures, 4));
const reasons = {
  stopped: "Сбор остановлен пользователем.",
  completed: "Все материалы для выбранного уровня собраны.",
  upgraded: "Бизнес улучшен до выбранного уровня.",
  limit: "Достигнут общий лимит боёв.",
  deadline: "Истекло время сбора.",
  unknown:
    "Не удалось подтвердить запасы, уровень или источники материалов. Сбор остановлен.",
  battle:
    "Бой требует проверки. Сбор остановлен без повторения игрового действия.",
  changed: "Расчёт изменился. Проверьте материалы и запустите сбор заново.",
  funds: "Недостаточно средств для следующего улучшения бизнеса.",
  business_upgrade_availability_unknown:
    "Игра не подтвердила доступность следующего улучшения.",
  business_upgrade_quote_unknown:
    "Игра не сообщила проверяемую стоимость следующего улучшения.",
  business_upgrade_requirements_unknown:
    "Игра не сообщила проверяемые требования следующего улучшения.",
  business_upgrade_balance_unknown: "Не удалось подтвердить доступный баланс.",
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
  upgrade,
  priorityActive = () => false,
  canResume = () => true,
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
  const canSuspend = () => {
    if (working || helper.run?.pendingUpgrade) return false;
    if (!running()) return true;
    const state = controller.getSnapshot();
    return !(
      working ||
      helper.run.pendingUpgrade ||
      state.pending ||
      state.pendingInvitation ||
      state.needsRefresh ||
      state.error ||
      state.purchase ||
      state.purchaseUncertain ||
      state.battle?.status === "active" ||
      goal.getSnapshot()?.rewardUncertain
    );
  };
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
      helper.run.pendingUpgrade ||
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
    if (priorityActive() && !helper.run.pendingUpgrade) {
      queue(1000);
      return;
    }
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
    run.reason = run.pendingUpgrade
      ? "Результат улучшения ещё не подтверждён. Повторяем только проверку, без нового списания."
      : "Игровые данные временно недоступны. Цель сохранена; повторим проверку.";
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
      !disposed &&
      running() &&
      generation === id &&
      withinTime() &&
      (!priorityActive() || Boolean(helper.run.pendingUpgrade));
    try {
      if (priorityActive() && !helper.run.pendingUpgrade) {
        queue(1000);
        return;
      }
      auto.stop();
      helper.run.phase = "verifying";
      changed();
      if (helper.run.pendingUpgrade) {
        const result = await upgrade(helper.run, valid);
        if (!valid()) return;
        if (result.status !== "confirmed") {
          scheduleRetry();
          return;
        }
        if (helper.run.stopRequested) {
          finish("stopped", "stopped");
          return;
        }
        if (!withinTime()) {
          finish("limited", "deadline");
          return;
        }
      }
      if (priorityActive()) {
        queue(1000);
        return;
      }
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
        if (!run.config.autoUpgrade) {
          finish("completed", "completed");
          return;
        }
        if (plan.achieved) {
          finish("completed", "upgraded");
          return;
        }
        run.phase = "upgrading";
        changed();
        const result = await upgrade(run, valid);
        if (!valid()) return;
        if (run.stopRequested && !run.pendingUpgrade) {
          finish("stopped", "stopped");
          return;
        }
        if (result.status === "complete") finish("completed", "upgraded");
        else if (result.status === "confirmed") {
          run.phase = "preparing";
          changed();
        } else if (result.status === "uncertain") scheduleRetry();
        else if (result.status === "funds_missing") finish("error", "funds");
        else if (result.status === "materials_missing") scheduleRetry();
        else if (result.status === "stopped") finish("stopped", "stopped");
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
      if (generation === id && running())
        scheduleRetry(helper.run.pendingUpgrade ? undefined : error);
    } finally {
      working = false;
      if (generation === id || (running() && helper.run?.stopRequested))
        evaluate();
    }
  }
  async function reconcilePausedUpgrade() {
    const run = helper.run;
    if (
      disposed ||
      working ||
      run?.status !== "paused" ||
      !run.pendingUpgrade ||
      now() < (run.nextPauseReconcileAt ?? 0)
    )
      return;
    working = true;
    run.pauseReconcileFailures = (run.pauseReconcileFailures ?? 0) + 1;
    run.nextPauseReconcileAt =
      now() + retryDelay(run.pauseReconcileFailures - 1);
    changed();
    try {
      // advanceBusinessUpgrade takes its read-only reconciliation branch when
      // pendingUpgrade exists. The false guard forbids a new upgrade POST.
      await upgrade(run, () => false);
    } catch {
      // Preserve the checkpoint and retry deadline after a failed read.
    } finally {
      working = false;
      if (running() && helper.run?.stopRequested && !helper.run.pendingUpgrade)
        finish("stopped", "stopped");
      else if (running() && armed) evaluate();
    }
  }
  function resumeRun(checkpoint, unsafe = false) {
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
      if (
        !auto.start({ checkpoint: checkpoint ?? helper.run.pausedCheckpoint })
      )
        scheduleRetry();
      else evaluate();
    } else queue();
  }
  function tick() {
    const run = helper.run;
    if (
      !working &&
      run?.status === "paused" &&
      run.resumeRequested &&
      canResume()
    ) {
      run.status = "running";
      run.resumeRequested = false;
      run.reason = null;
      generation++;
      changed();
      resumeRun(
        run.pausedCheckpoint,
        Boolean(run.pendingUpgrade || controller.getSnapshot().needsRefresh),
      );
      return;
    }
    if (run?.status === "paused" && run.pendingUpgrade)
      void reconcilePausedUpgrade();
    evaluate();
  }
  const unsubscribers = [controller, goal, auto].map((source) =>
    source.subscribe(evaluate),
  );
  return {
    running,
    idleForPriority: () => !working && !helper.run?.pendingUpgrade,
    canStartBattle,
    withinTime,
    tick,
    start(args, { queueId = null } = {}) {
      if (
        running() ||
        helper.run?.status === "paused" ||
        helper.run?.pendingUpgrade ||
        working
      )
        throw new Error("business_run_active");
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
        Boolean(config.autoUpgrade) !== Boolean(expected.autoUpgrade) ||
        JSON.stringify(Object.entries(config.bossChoices).sort()) !==
          JSON.stringify(Object.entries(expected.bossChoices || {}).sort())
      )
        throw new Error("business_stock_changed");
      if (config.maxAttempts == null && config.durationHours == null)
        throw new Error("business_run_limit_required");
      if (
        !plan.canCreateGoals ||
        (!plan.materials.some((item) => item.missingAmount > 0) &&
          (!config.autoUpgrade || plan.achieved)) ||
        (config.autoUpgrade && plan.currentLevelSource !== "game") ||
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
        first && (config.bossChoices?.[first.entityId] ?? first.bosses[0].id);
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
        ...(queueId ? { queueId } : {}),
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
    pause() {
      if (!running()) return false;
      const run = helper.run;
      armed = false;
      generation++;
      clear();
      run.pausedCheckpoint = auto.exportState?.() ?? null;
      run.status = "paused";
      run.resumeRequested = false;
      run.reason = "На паузе.";
      changed();
      auto.stop();
      return true;
    },
    resumePaused() {
      if (helper.run?.status !== "paused") return false;
      helper.run.resumeRequested = true;
      helper.run.reason = "Продолжаем сбор.";
      changed();
      return true;
    },
    stop() {
      if (helper.run?.status === "paused") {
        helper.run.status = "running";
        armed = true;
        generation++;
      }
      if (running() && helper.run.pendingUpgrade) {
        helper.run.stopRequested = true;
        helper.run.reason =
          "Ожидаем подтверждения улучшения, затем остановимся.";
        changed();
        auto.stop();
        queue();
        return;
      }
      finish("stopped", "stopped");
    },
    canSuspend,
    discardSuspended() {
      if (armed || working || helper.run?.pendingUpgrade) return false;
      if (running()) {
        generation++;
        clear();
        helper.run.status = "stopped";
        helper.run.reason = reasons.stopped;
        helper.run.phase = "stopped";
        changed();
      }
      return true;
    },
    suspend() {
      if (!running()) return true;
      if (!canSuspend()) return false;
      // Disarm before stopping the series: its synchronous notifications must
      // not schedule another business step or alter the saved run and goal.
      armed = false;
      generation++;
      clear();
      auto.stop();
      return true;
    },
    resume: resumeRun,
    dispose() {
      disposed = true;
      generation++;
      clear();
      for (const unsub of unsubscribers) unsub();
    },
  };
}
