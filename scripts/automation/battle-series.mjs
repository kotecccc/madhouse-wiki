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
}) {
  let enabled = false,
    disposed = false,
    generation = 0,
    stepping = false;
  let phase = "stopped",
    nextBattleAt = null,
    timer = null,
    bossId = null;
  let checkpoint = null;
  const listeners = new Set();
  let cached = { enabled: false, nextAttackAt: null, pause: false, phase };
  const strike = createBossBattleAutoAttack({
    controller: {
      ...controller,
      attack: () => controller.attack({ automatic: true }),
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
    };
    for (const listener of [...listeners]) listener(cached);
  }
  function clearTimer() {
    if (timer != null) cancel(timer);
    timer = null;
    nextBattleAt = null;
  }
  function stop() {
    generation++;
    enabled = false;
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
      !state.purchaseUncertain &&
      !state.medicineOpen
    );
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
      stop();
      return;
    }
    stepping = true;
    phase = "starting";
    publish();
    try {
      if (!before.battle) await controller.start();
      else await controller.startNextBattle({ allowed: () => eligible(id) });
    } catch {
      if (id === generation && enabled) stop();
    } finally {
      stepping = false;
    }
    if (!enabled || disposed || id !== generation) return;
    const state = controller.getSnapshot();
    // A refused start, lost POST reply, incomplete state or unknown cooldown is
    // a stop, never a loop that submits another start.
    if (
      !healthy(state) ||
      state.pending ||
      !canStartAutoAttack(state, now()) ||
      state.battle?.id === before.battle?.id
    ) {
      stop();
      return;
    }
    phase = "attacking";
    publish();
    if (!strike.start()) stop();
  }
  function evaluate() {
    if (!enabled || disposed || stepping) return;
    const state = controller.getSnapshot();
    const currentGoal = goal.getSnapshot();
    if (
      state.boss?.id !== bossId ||
      (currentGoal && currentGoal.status !== "active")
    ) {
      stop();
      return;
    }
    if (state.pending) {
      // The strike engine may temporarily publish needsRefresh during its POST.
      if (state.pending !== "attack") stop();
      return;
    }
    if (!healthy(state)) {
      stop();
      return;
    }
    if (state.battle?.status === "active") {
      if (strike.getSnapshot().enabled) return;
      // Auto was halted inside an active fight (for example unknown cooldown).
      // Only start() or our successful advance may enable a fresh strike engine.
      if (phase === "attacking") {
        stop();
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
        stop();
      checkpoint = null;
      return;
    }
    if (
      !currentGoal ||
      !goal.canStart() ||
      (state.battle && !TERMINAL.has(state.battle.status)) ||
      (["business_items", "drops"].includes(currentGoal.kind) &&
        currentGoal.rewardUncertain)
    ) {
      stop();
      return;
    }
    if (!state.battle && !state.canStart) {
      stop();
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
      };
    },
    start({ checkpoint: restored = null, resumeAt = null } = {}) {
      if (enabled || disposed) return false;
      const state = controller.getSnapshot(),
        currentGoal = goal.getSnapshot();
      if (
        !state.boss ||
        state.pending ||
        !healthy(state) ||
        (currentGoal && currentGoal.status !== "active") ||
        (!currentGoal && !canStartAutoAttack(state, now()))
      )
        return false;
      if (
        state.battle?.status === "active" &&
        !canStartAutoAttack(state, now())
      )
        return false;
      if (state.battle?.status !== "active" && !goal.canStart()) return false;
      enabled = true;
      generation++;
      bossId = state.boss.id;
      phase = "ready";
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
