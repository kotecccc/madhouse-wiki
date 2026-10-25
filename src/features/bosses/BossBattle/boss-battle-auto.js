const intBetween = (random, min, max) =>
  min +
  Math.floor(
    Math.max(0, Math.min(0.9999999999999999, random())) * (max - min + 1),
  );

export function canStartAutoAttack(state, now = Date.now()) {
  const battle = state?.battle;
  const expiryValid = battle?.expiresAt == null || battle.expiresAt > now;
  return Boolean(
    battle?.id &&
    battle.status === "active" &&
    battle.cooldownKnown === true &&
    Number.isFinite(battle.readyAt) &&
    expiryValid &&
    battle.playerHealth > 0 &&
    battle.playerMaxHealth > 0 &&
    battle.bossHealth > 0 &&
    battle.bossMaxHealth > 0 &&
    !state.needsRefresh &&
    !state.error &&
    !state.medicineOpen &&
    !state.purchase &&
    !state.purchaseUncertain,
  );
}

// UI eligibility only; series execution and deadline checks stay on the server.
export function canStartAutoSeries(state, goal, now = Date.now()) {
  if (
    !state?.boss ||
    state.pending ||
    state.error ||
    state.needsRefresh ||
    state.medicineOpen ||
    state.purchase ||
    state.purchaseUncertain ||
    (goal && goal.status !== "active")
  )
    return false;
  if (state.battle?.status === "active")
    return (
      state.battle.detailsLoaded !== false && canStartAutoAttack(state, now)
    );
  if (!goal?.canStart) return false;
  if (!state.battle) return state.canStart === true;
  return goal.canContinue === true;
}

export function createBossBattleAutoAttack({
  controller,
  now = Date.now,
  random = Math.random,
  schedule = setTimeout,
  cancel = clearTimeout,
}) {
  let enabled = false;
  let nextAttackAt = null;
  let pause = false;
  let timer = null;
  let runId = 0;
  let ownAttack = false;
  let strikes = 0;
  let pauseAfter = intBetween(random, 5, 10);
  let listeners = new Set();
  let disposed = false;
  let state = controller.getSnapshot();
  let targetBattleId = null;
  let cachedSnapshot = { enabled, nextAttackAt, pause };

  const snapshot = () => cachedSnapshot;
  function publish() {
    cachedSnapshot = { enabled, nextAttackAt, pause };
    for (const listener of listeners) listener(cachedSnapshot);
  }
  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
    nextAttackAt = null;
    pause = false;
  }
  function halt() {
    runId++;
    enabled = false;
    clearTimer();
    publish();
  }
  function delayNext(id, base, isPause = false) {
    if (!enabled || disposed || id !== runId) return;
    clearTimer();
    const delay = base + (isPause ? intBetween(random, 5, 10) * 1000 : 0);
    nextAttackAt = now() + delay;
    pause = isPause;
    timer = schedule(
      () => {
        if (!enabled || disposed || id !== runId) return;
        timer = null;
        nextAttackAt = null;
        pause = false;
        publish();
        state = controller.getSnapshot();
        if (
          state.battle?.id !== targetBattleId ||
          !canStartAutoAttack(state, now())
        ) {
          halt();
          return;
        }
        if (state.battle.readyAt > now()) {
          delayNext(id, state.battle.readyAt - now());
          return;
        }
        void perform(id);
      },
      Math.max(0, delay),
    );
    publish();
  }
  async function perform(id) {
    if (
      !enabled ||
      disposed ||
      id !== runId ||
      state.battle?.id !== targetBattleId ||
      !canStartAutoAttack(state, now())
    ) {
      if (enabled && id === runId) halt();
      return;
    }
    const battleId = state.battle.id;
    const before = state.battle;
    ownAttack = true;
    let failed = false;
    try {
      await controller.attack();
    } catch {
      failed = true;
      // The controller owns errors and refresh requirements; never retry here.
    } finally {
      ownAttack = false;
    }
    if (!enabled || disposed || id !== runId) return;
    state = controller.getSnapshot();
    if (
      failed ||
      !canStartAutoAttack(state, now()) ||
      state.battle.id !== battleId ||
      state.pending ||
      state.needsRefresh ||
      (state.battle.playerHealth === before.playerHealth &&
        state.battle.bossHealth === before.bossHealth &&
        state.battle.readyAt === before.readyAt &&
        state.battle.status === before.status &&
        state.battle.events === before.events)
    ) {
      halt();
      return;
    }
    strikes++;
    let yawning = strikes >= pauseAfter;
    if (yawning) {
      strikes = 0;
      pauseAfter = intBetween(random, 5, 10);
    }
    const cooldown = Math.max(0, state.battle.readyAt - now());
    delayNext(id, cooldown + intBetween(random, 2, 4) * 1000, yawning);
  }
  function onControllerChange() {
    state = controller.getSnapshot();
    if (!enabled) return;
    const intermediateOwnAttack = ownAttack && state.pending === "attack";
    if (
      state.battle?.id !== targetBattleId ||
      state.battle?.status !== "active" ||
      !state.battle ||
      state.battle.playerHealth <= 0 ||
      state.battle.bossHealth <= 0 ||
      state.medicineOpen ||
      state.purchase ||
      state.purchaseUncertain ||
      state.error ||
      (state.needsRefresh && !intermediateOwnAttack) ||
      (state.pending && !intermediateOwnAttack) ||
      !canStartAutoAttack(
        {
          ...state,
          needsRefresh: intermediateOwnAttack ? false : state.needsRefresh,
        },
        now(),
      )
    ) {
      halt();
    }
  }
  const unsubscribe = controller.subscribe(onControllerChange);

  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    exportState() {
      return {
        enabled,
        nextAttackAt,
        pause,
        strikes,
        pauseAfter,
        targetBattleId,
      };
    },
    start({ resumeAt = null, checkpoint = null } = {}) {
      if (
        disposed ||
        enabled ||
        !canStartAutoAttack(state, now()) ||
        state.pending
      )
        return false;
      enabled = true;
      const id = ++runId;
      targetBattleId = state.battle.id;
      strikes =
        checkpoint?.targetBattleId === targetBattleId &&
        Number.isSafeInteger(checkpoint.strikes)
          ? Math.max(0, checkpoint.strikes)
          : 0;
      pauseAfter =
        checkpoint?.targetBattleId === targetBattleId &&
        Number.isSafeInteger(checkpoint.pauseAfter)
          ? Math.max(5, Math.min(10, checkpoint.pauseAfter))
          : intBetween(random, 5, 10);
      const cooldown = Math.max(
        0,
        state.battle.readyAt - now(),
        Number.isFinite(resumeAt) ? resumeAt - now() : 0,
      );
      // The first strike has no artificial lead-in. Only a real server
      // cooldown can defer it; subsequent delays are scheduled after replies.
      if (cooldown > 0) delayNext(id, cooldown);
      else {
        publish();
        void perform(id);
      }
      return true;
    },
    stop: halt,
    dispose() {
      if (disposed) return;
      halt();
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  };
}
