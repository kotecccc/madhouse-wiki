import {
  createBossBattleAutoAttack,
  canStartAutoAttack,
} from "../../src/features/bosses/BossBattle/boss-battle-auto.js";

const TERMINAL = new Set(["won", "lost", "expired", "surrendered"]);
const BETWEEN_BATTLES_MS = 1000;

// Server-only supervisor. It owns intent across fights; the strike engine owns
// one battle's cooldown. No client, interval polling or mutation retry drives it.
export function createBattleSeries({
  controller,
  goal,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  random = Math.random,
  priorityActive = () => false,
  savedStartReceipts = [],
}) {
  let enabled = false,
    disposed = false,
    generation = 0,
    stepping = false;
  let phase = "stopped",
    nextBattleAt = null,
    timer = null,
    bossId = null,
    nextRecoveryAt = null;
  let checkpoint = null;
  let singleBattle = false;
  let singleBattleId = null;
  let stopAfterBattle = false;
  let queueId = null;
  let startReceipts = Array.isArray(savedStartReceipts)
    ? savedStartReceipts.slice(-128)
    : [];
  const listeners = new Set();
  let cached = {
    enabled: false,
    nextAttackAt: null,
    pause: false,
    phase,
    startReceipts,
  };
  const strike = createBossBattleAutoAttack({
    controller: {
      ...controller,
      attack: (options) => controller.attack({ ...options, automatic: true }),
    },
    now,
    schedule,
    cancel,
    random,
  });
  function publish() {
    const current = strike.getSnapshot();
    cached = {
      enabled,
      nextAttackAt: current.nextAttackAt,
      pause: current.pause,
      phase,
      stopAfterBattle,
      notice: current.notice ?? null,
      nextRecoveryAt,
      queueId,
      startReceipts,
    };
    for (const listener of [...listeners]) listener(cached);
  }
  function clearTimer() {
    if (timer != null) cancel(timer);
    timer = null;
    nextBattleAt = null;
    nextRecoveryAt = null;
  }
  function stop() {
    controller.stopAutomation?.();
    generation++;
    enabled = false;
    stopAfterBattle = false;
    phase = "stopped";
    clearTimer();
    strike.stop();
    publish();
  }
  function eligible(id) {
    const currentGoal = goal.getSnapshot();
    return (
      enabled &&
      !disposed &&
      generation === id &&
      !controller.getSnapshot().invitationOnly &&
      controller.getSnapshot().boss?.id === bossId &&
      currentGoal?.status === "active" &&
      goal.canStart()
    );
  }
  function healthy(state) {
    return (
      !state.error &&
      !state.needsRefresh &&
      !state.purchase &&
      !state.purchaseUncertain
    );
  }
  function waitForRecovery() {
    if (!controller.recoverAutomation) {
      stop();
      return;
    }
    if (!enabled || disposed || timer != null) return;
    phase = "waiting";
    nextBattleAt = null;
    nextRecoveryAt = Math.max(
      now(),
      checkpoint?.nextRecoveryAt ?? now() + 30000,
    );
    checkpoint = null;
    const id = generation;
    timer = schedule(
      async () => {
        timer = null;
        nextRecoveryAt = null;
        if (!enabled || disposed || id !== generation) return;
        stepping = true;
        let recovered = false;
        try {
          recovered = await controller.recoverAutomation();
        } catch {
          /* A failed reader keeps the saved intent; no mutation is replayed. */
        } finally {
          stepping = false;
        }
        if (!enabled || disposed || id !== generation) return;
        if (recovered) {
          phase = "ready";
          evaluate();
        } else waitForRecovery();
      },
      Math.max(0, nextRecoveryAt - now()),
    );
    const previous = stepping;
    stepping = true;
    strike.stop();
    stepping = previous;
    publish();
  }
  async function advance(id) {
    timer = null;
    nextBattleAt = null;
    if (!eligible(id)) {
      if (enabled && id === generation) stop();
      return;
    }
    const before = controller.getSnapshot();
    if (before.pending || !healthy(before)) {
      waitForRecovery();
      return;
    }
    if (priorityActive()) {
      phase = "yielding";
      nextBattleAt = now() + 1000;
      timer = schedule(() => {
        void advance(id);
      }, 1000);
      publish();
      return;
    }
    stepping = true;
    phase = "starting";
    publish();
    try {
      const allowed = () => eligible(id) && !priorityActive();
      if (!before.battle) await controller.start({ allowed });
      else await controller.startNextBattle({ allowed });
    } catch {
      if (id === generation && enabled) waitForRecovery();
    } finally {
      stepping = false;
    }
    if (!enabled || disposed || id !== generation) return;
    const state = controller.getSnapshot();
    if (
      priorityActive() &&
      healthy(state) &&
      !state.pending &&
      state.battle?.id === before.battle?.id
    ) {
      phase = "ready";
      evaluate();
      return;
    }
    // A refused start, lost POST reply, incomplete state or unknown cooldown is
    // a stop, never a loop that submits another start.
    if (
      !healthy(state) ||
      state.pending ||
      !canStartAutoAttack(state, now()) ||
      state.battle?.id === before.battle?.id
    ) {
      waitForRecovery();
      return;
    }
    if (singleBattle) singleBattleId = state.battle.id;
    phase = "attacking";
    publish();
    if (!strike.start()) waitForRecovery();
  }
  function evaluate() {
    if (!enabled || disposed || stepping) return;
    const state = controller.getSnapshot();
    const currentGoal = goal.getSnapshot();
    if (
      state.boss?.id !== bossId ||
      (state.invitationOnly && state.battle?.status !== "active") ||
      (currentGoal && currentGoal.status !== "active")
    ) {
      stop();
      return;
    }
    if (state.pending) {
      // The strike engine may temporarily publish needsRefresh during its POST.
      if (
        !["attack", "refresh", "heal", "buy", "stock", "invite"].includes(
          state.pending,
        )
      )
        stop();
      return;
    }
    if (phase === "waiting" && timer != null) return;
    if (!healthy(state)) {
      waitForRecovery();
      return;
    }
    if (state.battle?.status === "active") {
      if (singleBattle) singleBattleId ??= state.battle.id;
      if (strike.getSnapshot().enabled) return;
      // Auto was halted inside an active fight (for example unknown cooldown).
      // Only start() or our successful advance may enable a fresh strike engine.
      if (phase === "attacking") {
        waitForRecovery();
        return;
      }
      phase = "attacking";
      publish();
      if (
        !strike.start({
          resumeAt: checkpoint?.nextAttackAt,
          checkpoint: checkpoint?.strike || checkpoint,
        })
      )
        waitForRecovery();
      checkpoint = null;
      return;
    }
    if (
      singleBattle &&
      (phase === "attacking" ||
        (singleBattleId && state.battle?.id === singleBattleId))
    ) {
      const finishGoal = stopAfterBattle;
      stop();
      if (finishGoal) goal.stop();
      return;
    }
    if (
      currentGoal?.rewardUncertain ||
      (state.battle && !TERMINAL.has(state.battle.status))
    ) {
      waitForRecovery();
      return;
    }
    if (!currentGoal || !goal.canStart()) {
      stop();
      return;
    }
    if (!state.battle && !state.canStart) {
      waitForRecovery();
      return;
    }
    if (timer != null) return;
    phase = "between_battles";
    nextBattleAt = Number.isFinite(checkpoint?.nextBattleAt)
      ? Math.max(now(), checkpoint.nextBattleAt)
      : now() + (state.battle ? BETWEEN_BATTLES_MS : 0);
    checkpoint = null;
    const id = generation;
    timer = schedule(
      () => {
        void advance(id);
      },
      Math.max(0, nextBattleAt - now()),
    );
    publish();
  }
  const unsubscribeController = controller.subscribe(evaluate);
  const unsubscribeGoal = goal.subscribe(evaluate);
  const unsubscribeStrike = strike.subscribe(() => {
    publish();
    // Controller notifications can arrive before the terminal POST's finalizer.
    // evaluate() waits for pending=null before scheduling a new fight.
    evaluate();
  });
  return {
    getSnapshot: () => cached,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exportState() {
      return {
        ...cached,
        phase,
        nextBattleAt,
        bossId,
        strike: strike.exportState(),
        singleBattle,
        singleBattleId,
      };
    },
    finishCurrent({ stopAfterBattle: shouldStop = false } = {}) {
      const battle = controller.getSnapshot().battle;
      if (!enabled || battle?.status !== "active" || !battle.id) return false;
      if (
        singleBattle &&
        singleBattleId === battle.id &&
        (!shouldStop || stopAfterBattle)
      )
        return true;
      singleBattle = true;
      singleBattleId = battle.id;
      if (shouldStop) stopAfterBattle = true;
      publish();
      return true;
    },
    resumeSeries() {
      if (!enabled) return false;
      singleBattle = false;
      singleBattleId = null;
      stopAfterBattle = false;
      publish();
      return true;
    },
    start({
      checkpoint: restored = null,
      resumeAt = null,
      singleBattle: single = false,
      queueId: queuedId = null,
    } = {}) {
      if (enabled || disposed) return false;
      const state = controller.getSnapshot(),
        currentGoal = goal.getSnapshot();
      if (
        !state.boss ||
        (state.invitationOnly && state.battle?.status !== "active") ||
        state.pending ||
        (!healthy(state) && !controller.recoverAutomation) ||
        (currentGoal && currentGoal.status !== "active") ||
        (!currentGoal &&
          !canStartAutoAttack(state, now()) &&
          !controller.recoverAutomation)
      )
        return false;
      if (
        state.battle?.status === "active" &&
        !canStartAutoAttack(state, now()) &&
        !controller.recoverAutomation
      )
        return false;
      if (state.battle?.status !== "active" && !goal.canStart()) return false;
      if (controller.beginAutomation?.() === false) return false;
      singleBattle = restored?.singleBattle ?? single;
      stopAfterBattle = Boolean(restored?.stopAfterBattle);
      queueId = restored?.queueId ?? queuedId;
      if (queueId && !startReceipts.includes(queueId))
        startReceipts = [...startReceipts.slice(-127), queueId];
      singleBattleId = singleBattle
        ? (restored?.singleBattleId ??
          (state.battle?.status === "active" ? state.battle.id : null))
        : null;
      enabled = true;
      generation++;
      bossId = state.boss.id;
      phase =
        singleBattle &&
        restored?.phase === "attacking" &&
        TERMINAL.has(state.battle?.status)
          ? "attacking"
          : "ready";
      checkpoint = restored
        ? { ...restored, nextAttackAt: resumeAt ?? restored.nextAttackAt }
        : null;
      publish();
      evaluate();
      return enabled;
    },
    stop,
    dispose() {
      if (disposed) return;
      enabled = false;
      disposed = true;
      generation++;
      clearTimer();
      unsubscribeController();
      unsubscribeGoal();
      unsubscribeStrike();
      strike.dispose();
      listeners.clear();
    },
  };
}
