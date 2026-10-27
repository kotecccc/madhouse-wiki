import { bossDropIdentity } from "./boss-battle-reference.js";

const TERMINAL = new Set(["won", "lost", "expired", "surrendered"]);
const KINDS = new Set(["battles", "business_items", "drops", "time"]);
const positive = (n) => Number.isSafeInteger(n) && n > 0;

export function createBossBattleGoal({ controller, now = Date.now }) {
  if (!controller?.subscribe || !controller?.getSnapshot)
    throw new TypeError("A boss battle controller is required");
  const listeners = new Set();
  const attempts = new Set();
  const results = new Map();
  const receipts = new Map(); // battleId -> identity -> largest observed amount
  const excluded = new Set();
  let settings = null,
    stopped = false,
    finishCurrentBattle = false,
    disposed = false,
    startedAt = null,
    deadlineAt = null,
    snapshot = null;

  function confirmed(state, battle) {
    return battle?.id && TERMINAL.has(battle.status) && !state?.needsRefresh;
  }
  function amounts() {
    const total = new Map();
    for (const perBattle of receipts.values())
      for (const [key, value] of perBattle) {
        const sum = (total.get(key) || 0) + value.amount;
        if (Number.isSafeInteger(sum)) total.set(key, sum);
      }
    return total;
  }
  function makeSnapshot(state) {
    if (!settings) return null;
    const battle = state?.battle;
    const wins = [...results.values()].filter((x) => x === "won").length;
    const losses = [...results.values()].filter((x) => x === "lost").length;
    const completedBattles = results.size;
    const total = amounts();
    const items = settings.items.map((item) => {
      const amount = total.get(item.key) || 0;
      return Object.freeze({ ...item, amount, received: amount > 0 });
    });
    let progress;
    const target =
      settings.kind === "time" && settings.durationHours != null
        ? settings.durationHours * 3600
        : settings.kind === "drops"
          ? settings.items.length
          : (settings.targetCount ?? null);
    if (settings.kind === "battles")
      progress = settings.countWins ? wins : completedBattles;
    else if (settings.kind === "business_items")
      progress = items[0]?.amount || 0;
    else if (settings.kind === "drops")
      progress = items.filter((x) => x.received).length;
    else
      progress =
        startedAt == null
          ? 0
          : Math.max(0, Math.floor((now() - startedAt) / 1000));
    const deadlineReached =
      !finishCurrentBattle && deadlineAt != null && now() >= deadlineAt;
    const complete =
      settings.kind === "time" ? deadlineReached : progress >= target;
    const expired = settings.kind !== "time" && deadlineReached && !complete;
    const exhausted =
      !complete &&
      settings.maxAttempts != null &&
      attempts.size >= settings.maxAttempts &&
      completedBattles >= settings.maxAttempts;
    const status = stopped
      ? "stopped"
      : complete
        ? "completed"
        : expired
          ? "expired"
          : exhausted
            ? "exhausted"
            : "active";
    const open = status === "active" && !deadlineReached;
    const sameBoss = state?.boss?.id === settings.bossId;
    const knownTerminal = sameBoss && battle?.id && TERMINAL.has(battle.status);
    return Object.freeze({
      kind: settings.kind,
      boss: Object.freeze({ id: settings.bossId, name: settings.bossName }),
      targetCount: settings.targetCount,
      maxAttempts: settings.maxAttempts,
      countWins: settings.countWins,
      attempts: attempts.size,
      completedBattles,
      wins,
      losses,
      status,
      canContinue: Boolean(
        open &&
        knownTerminal &&
        !state.needsRefresh &&
        state.pending == null &&
        !state.purchaseUncertain &&
        !state.purchase,
      ),
      canStart: Boolean(
        open &&
        (settings.maxAttempts == null || attempts.size < settings.maxAttempts),
      ),
      durationHours: settings.durationHours,
      startedAt,
      deadlineAt,
      items: Object.freeze(items),
      progress,
      target,
      remainingSeconds:
        deadlineAt == null
          ? null
          : Math.max(0, Math.ceil((deadlineAt - now()) / 1000)),
      rewardUncertain: [...results].some(
        ([id, result]) => result === "won" && receipts.get(id) == null,
      ),
      battle: battle
        ? Object.freeze({
            id: battle.id,
            status: battle.status,
            bossId: battle.bossId ?? state?.boss?.id ?? null,
          })
        : null,
      pending: state?.pending ?? null,
      ...(settings.legacyMigration ? { legacyMigration: true } : {}),
    });
  }
  function publish() {
    snapshot = makeSnapshot(controller.getSnapshot());
    for (const fn of [...listeners]) fn();
  }
  function clear() {
    settings = null;
    stopped = false;
    finishCurrentBattle = false;
    startedAt = deadlineAt = null;
    attempts.clear();
    results.clear();
    receipts.clear();
    excluded.clear();
  }
  function sync() {
    if (disposed) return;
    const state = controller.getSnapshot();
    if (settings && state?.boss?.id !== settings.bossId) clear();
    if (settings && !stopped && state?.boss?.id === settings.bossId) {
      const battle = state.battle;
      if (
        battle?.id &&
        !excluded.has(battle.id) &&
        (!battle.bossId || battle.bossId === settings.bossId)
      ) {
        const isExisting = attempts.has(battle.id);
        const cap = settings.maxAttempts;
        if (
          (battle.status === "active" || TERMINAL.has(battle.status)) &&
          (isExisting || snapshot?.status === "active") &&
          (isExisting || cap == null || attempts.size < cap)
        )
          attempts.add(battle.id);
        if (confirmed(state, battle) && attempts.has(battle.id)) {
          if (!results.has(battle.id)) results.set(battle.id, battle.status);
          if (battle.status === "won" && battle.rewardKnown === true) {
            const next = new Map(receipts.get(battle.id) || []);
            const observed = new Map();
            for (const drop of battle.grantedDrops || []) {
              const key = bossDropIdentity(drop);
              if (!key || !positive(drop.amount)) continue;
              const old = observed.get(key);
              const sum = (old?.amount || 0) + drop.amount;
              if (Number.isSafeInteger(sum))
                observed.set(key, { amount: sum, name: drop.name });
              else observed.delete(key);
            }
            for (const [key, value] of observed) {
              const old = next.get(key);
              if (!old || value.amount > old.amount) next.set(key, value);
            }
            receipts.set(battle.id, next);
          }
        }
      }
    }
    publish();
  }
  const unsubscribe = controller.subscribe(sync);
  function validate(config) {
    const {
      bossId,
      bossName,
      kind,
      targetCount,
      items = [],
      durationHours = null,
      maxAttempts = null,
      countWins = false,
    } = config || {};
    if (!((typeof bossId === "string" && bossId.trim()) || positive(bossId)))
      throw new TypeError("Invalid bossId");
    if (typeof bossName !== "string" || !bossName.trim())
      throw new TypeError("Invalid bossName");
    if (!KINDS.has(kind)) throw new TypeError("Invalid goal kind");
    if (kind !== "time" && kind !== "drops" && !positive(targetCount))
      throw new RangeError("targetCount must be a positive safe integer");
    if (![1, 2, 4, null].includes(durationHours))
      throw new RangeError("durationHours must be 1, 2, 4, or null");
    if (typeof countWins !== "boolean" || (countWins && kind !== "battles"))
      throw new TypeError("countWins is only supported for battle goals");
    if (maxAttempts != null && !positive(maxAttempts))
      throw new RangeError(
        "maxAttempts must be a positive safe integer or null",
      );
    if (kind === "battles" && maxAttempts != null && maxAttempts < targetCount)
      throw new RangeError("maxAttempts cannot be less than targetCount");
    const normalizedItems = items.map((item) => {
      if (
        !item ||
        typeof item.key !== "string" ||
        !item.key ||
        typeof item.name !== "string" ||
        !item.name
      )
        throw new TypeError("Invalid goal item");
      return { key: item.key, name: item.name };
    });
    if (
      new Set(normalizedItems.map((item) => item.key)).size !==
      normalizedItems.length
    )
      throw new TypeError("Goal item keys must be unique");
    if (
      (kind === "business_items" && normalizedItems.length !== 1) ||
      (kind === "drops" && !normalizedItems.length) ||
      (kind === "battles" && normalizedItems.length) ||
      (kind === "time" && normalizedItems.length)
    )
      throw new TypeError("Invalid items for goal kind");
    return {
      bossId: typeof bossId === "string" ? bossId.trim() : bossId,
      bossName: bossName.trim(),
      kind,
      targetCount: kind === "time" || kind === "drops" ? null : targetCount,
      items: normalizedItems,
      durationHours,
      countWins,
      maxAttempts:
        maxAttempts ?? (kind === "battles" && !countWins ? targetCount : null),
    };
  }
  return Object.freeze({
    subscribe(fn) {
      if (disposed) return () => {};
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    getSnapshot() {
      return snapshot;
    },
    tick() {
      if (disposed || !settings) return;
      const next = makeSnapshot(controller.getSnapshot());
      if (
        next.status !== snapshot?.status ||
        next.remainingSeconds !== snapshot?.remainingSeconds
      )
        publish();
    },
    exportState() {
      return settings
        ? {
            settings,
            stopped,
            finishCurrentBattle,
            startedAt,
            deadlineAt,
            attempts: [...attempts],
            results: [...results],
            receipts: [...receipts].map(([id, map]) => [id, [...map]]),
            excludedBattles: [...excluded],
          }
        : null;
    },
    restoreState(saved) {
      if (!saved?.settings) return;
      let config = saved.settings;
      const legacy = config.targetWins != null;
      if (legacy)
        config = {
          bossId: config.bossId,
          bossName: config.bossName,
          kind: "battles",
          targetCount: config.targetWins,
          maxAttempts: config.maxAttempts ?? config.targetWins,
          items: [],
          durationHours: null,
        };
      const valid = validate(config);
      clear();
      settings = { ...valid, ...(legacy ? { legacyMigration: true } : {}) };
      stopped = legacy || Boolean(saved.stopped);
      finishCurrentBattle = Boolean(saved.finishCurrentBattle);
      startedAt =
        stopped && saved.startedAt == null ? null : (saved.startedAt ?? now());
      deadlineAt =
        startedAt == null
          ? null
          : (saved.deadlineAt ??
            (settings.durationHours != null
              ? startedAt + settings.durationHours * 3600000
              : null));
      for (const id of saved.attempts || []) attempts.add(id);
      for (const [id, result] of saved.results || [])
        if (attempts.has(id) && TERMINAL.has(result)) results.set(id, result);
      for (const [id, rows] of saved.receipts || [])
        receipts.set(id, new Map(rows));
      for (const id of saved.excludedBattles || []) excluded.add(id);
      publish();
    },
    canStart() {
      return (
        !settings || Boolean(makeSnapshot(controller.getSnapshot())?.canStart)
      );
    },
    finishCurrentBattle() {
      if (!settings || stopped || finishCurrentBattle) return;
      finishCurrentBattle = true;
      publish();
    },
    configure(config) {
      const valid = validate(config);
      clear();
      settings = valid;
      stopped = false;
      startedAt = now();
      deadlineAt =
        valid.durationHours != null
          ? startedAt + valid.durationHours * 3600000
          : null;
      const state = controller.getSnapshot(),
        battle = state?.battle;
      if (
        state?.boss?.id === valid.bossId &&
        battle?.id &&
        (!battle.bossId || battle.bossId === valid.bossId)
      ) {
        if (battle.status === "active") attempts.add(battle.id);
        else if (TERMINAL.has(battle.status)) excluded.add(battle.id);
      }
      publish();
    },
    stop({ clearProgress = false } = {}) {
      if (settings && (!stopped || clearProgress)) {
        finishCurrentBattle = false;
        if (clearProgress) {
          startedAt = deadlineAt = null;
          attempts.clear();
          results.clear();
          receipts.clear();
          excluded.clear();
        }
        stopped = true;
        publish();
      }
    },
    reset() {
      clear();
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      listeners.clear();
    },
  });
}
