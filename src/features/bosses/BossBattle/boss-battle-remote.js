const EMPTY_BATTLE = Object.freeze({
  boss: null,
  battle: null,
  visible: false,
  pending: null,
  error: null,
  errorStatus: null,
  notice: null,
  needsRefresh: false,
  medicineOpen: false,
  purchase: null,
  purchaseUncertain: false,
});
const EMPTY_AUTO = Object.freeze({
  enabled: false,
  nextAttackAt: null,
  pause: false,
});
const EMPTY_PVP = Object.freeze({ battle: null, pending: false, error: null });
const EMPTY_BUSINESS = Object.freeze({
  plans: [],
  loaded: false,
  pending: false,
  notice: null,
  error: null,
});
const EMPTY_WORK_FARM = Object.freeze({
  view: null,
  run: null,
  notice: null,
  loaded: false,
  pending: false,
  error: null,
});
const POLL_INTERVAL = 2000;
const IDLE_POLL_INTERVAL = 180000;
const ERROR_RETRY_INTERVAL = 5000;

function numericId(boss) {
  const id = Number(boss?.numericId ?? boss?.apiId ?? boss?.id);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function commandId(makeId) {
  try {
    return makeId();
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
}

/** A server-backed, useSyncExternalStore-compatible facade for battle UI. */
export function createRemoteBattleSession({
  request,
  schedule = setTimeout,
  cancel = clearTimeout,
  makeId = () => crypto.randomUUID(),
  visibility = typeof document === "undefined" ? null : document,
} = {}) {
  if (typeof request !== "function") throw new TypeError("request is required");

  const listeners = new Set();
  const autoListeners = new Set();
  const goalListeners = new Set();
  const pvpListeners = new Set();
  const preferencesListeners = new Set();
  const businessListeners = new Set();
  const workFarmListeners = new Set();
  let connected = false;
  let transportError = null;
  let workCommandError = null;
  let businessCommandError = null;
  let epoch = 0;
  let timer = null;
  let pendingCommands = 0;
  let stateRead = null;
  let visible = false;
  let pvpVisible = false;
  let localBoss = null;
  // Public requirement context belongs to the dialog; execution goals remain server-owned.
  let openingBossId = null;
  let openingRequirements = [];
  let server = null;
  let snapshot = EMPTY_BATTLE;
  let autoSnapshot = EMPTY_AUTO;
  let goalSnapshot = null;
  let pvpSnapshot = EMPTY_PVP;
  let businessSnapshot = EMPTY_BUSINESS;
  let workFarmSnapshot = EMPTY_WORK_FARM;
  let preferencesSnapshot = Object.freeze({ favoriteBossIds: [] });

  const notify = (set, value) => {
    for (const listener of [...set]) listener(value);
  };
  function publish() {
    const battleState = server?.battle ?? {};
    snapshot = Object.freeze({
      ...EMPTY_BATTLE,
      ...battleState,
      boss: battleState.boss ?? localBoss ?? null,
      visible,
      openingRequirements:
        numericId(battleState.boss ?? localBoss) === openingBossId
          ? openingRequirements
          : [],
      pending:
        pendingCommands > 0
          ? (battleState.pending ?? "command")
          : (battleState.pending ?? null),
    });
    autoSnapshot = server?.auto ?? EMPTY_AUTO;
    goalSnapshot = server?.goal ?? null;
    pvpSnapshot = Object.freeze({
      ...(server?.pvp ?? EMPTY_PVP),
      visible: pvpVisible,
    });
    preferencesSnapshot =
      server?.preferences ?? Object.freeze({ favoriteBossIds: [] });
    notify(listeners, snapshot);
    notify(autoListeners, autoSnapshot);
    notify(goalListeners, goalSnapshot);
    notify(pvpListeners, pvpSnapshot);
    businessSnapshot = Object.freeze({
      ...(server?.businessAssistant ?? EMPTY_BUSINESS),
      loaded: Boolean(server?.businessAssistant),
      pending: pendingCommands > 0,
      error: transportError || businessCommandError,
    });
    notify(preferencesListeners, preferencesSnapshot);
    notify(businessListeners, businessSnapshot);
    workFarmSnapshot = Object.freeze({
      ...EMPTY_WORK_FARM,
      ...(server?.workFarm ?? {}),
      loaded: Boolean(server),
      pending: pendingCommands > 0,
      error: transportError || workCommandError,
    });
    notify(workFarmListeners, workFarmSnapshot);
  }

  function setServerState(value) {
    transportError = null;
    workCommandError = null;
    businessCommandError = null;
    const incomingVersion = value?.version;
    const currentVersion = server?.version;
    if (
      value &&
      typeof value === "object" &&
      !(
        Number.isFinite(incomingVersion) &&
        Number.isFinite(currentVersion) &&
        incomingVersion < currentVersion
      )
    )
      server = value;
    publish();
  }

  function clearTimer() {
    if (timer !== null) cancel(timer);
    timer = null;
  }

  function activelyWatching() {
    return (
      visible ||
      pvpVisible ||
      server?.auto?.enabled ||
      server?.goal?.status === "running" ||
      server?.goal?.status === "active" ||
      server?.businessAssistant?.run?.status === "running" ||
      server?.workFarm?.run?.status === "running"
    );
  }
  const pollInterval = () =>
    transportError || workCommandError || businessCommandError
      ? ERROR_RETRY_INTERVAL
      : activelyWatching()
        ? POLL_INTERVAL
        : IDLE_POLL_INTERVAL;
  function onVisibilityChange() {
    clearTimer();
    if (connected && visibility?.visibilityState !== "hidden") schedulePoll(0);
  }

  function schedulePoll(delay = pollInterval(), run = epoch) {
    clearTimer();
    if (!connected || run !== epoch || visibility?.visibilityState === "hidden")
      return;
    timer = schedule(() => {
      timer = null;
      void poll(run);
    }, delay);
  }

  async function readState(run) {
    if (stateRead?.run === run) return stateRead.promise;
    const entry = { run, promise: null };
    entry.promise = (async () => {
      const result = await request("GET", "/api/automation/state");
      if (!connected || run !== epoch) return false;
      setServerState(result);
      return true;
    })();
    stateRead = entry;
    try {
      return await entry.promise;
    } finally {
      if (stateRead === entry) stateRead = null;
    }
  }

  async function poll(run) {
    if (!connected || run !== epoch || visibility?.visibilityState === "hidden")
      return;
    if (pendingCommands > 0) {
      schedulePoll(undefined, run);
      return;
    }
    try {
      await readState(run);
      schedulePoll(undefined, run);
    } catch (error) {
      if (!connected || run !== epoch) return;
      transportError =
        error?.message || "Не удалось получить состояние сервера.";
      const prior = server ?? {};
      server = {
        ...prior,
        battle: {
          ...(prior.battle ?? {}),
          error: error?.message || "Не удалось обновить состояние боя",
          errorStatus: error?.status ?? null,
          needsRefresh: true,
        },
      };
      publish();
      schedulePoll(ERROR_RETRY_INTERVAL, run);
    }
  }

  async function connect() {
    if (connected) return;
    connected = true;
    visibility?.addEventListener("visibilitychange", onVisibilityChange);
    const run = ++epoch;
    try {
      await readState(run);
      schedulePoll(undefined, run);
    } catch (error) {
      if (!connected || run !== epoch) return;
      transportError = error?.message || "Не удалось подключиться к серверу.";
      server = {
        ...(server ?? {}),
        battle: {
          ...(server?.battle ?? {}),
          error: error?.message || "Не удалось подключиться к состоянию боя",
          errorStatus: error?.status ?? null,
          needsRefresh: true,
        },
      };
      publish();
      schedulePoll(ERROR_RETRY_INTERVAL, run);
    }
  }

  function disconnect() {
    connected = false;
    visibility?.removeEventListener("visibilitychange", onVisibilityChange);
    transportError = null;
    workCommandError = null;
    businessCommandError = null;
    epoch++;
    clearTimer();
    pendingCommands = 0;
    visible = false;
    pvpVisible = false;
    localBoss = null;
    openingBossId = null;
    openingRequirements = [];
    server = null;
    publish();
  }

  async function send(command, args = {}) {
    const urgent =
      command === "auto.stop" ||
      command === "goal.stop" ||
      command === "business.run.stop" ||
      command === "work.stop";
    if (!connected || (!urgent && pendingCommands > 0)) return false;
    pendingCommands++;
    publish();
    const run = epoch;
    const id = commandId(makeId);
    try {
      const value = await request("POST", "/api/automation/commands", {
        id,
        expectedVersion: server?.version ?? null,
        command,
        args,
      });
      if (!connected || run !== epoch) return false;
      setServerState(value);
      return true;
    } catch (error) {
      if (!connected || run !== epoch) return false;
      if (error?.status === 409 && error.snapshot)
        setServerState(error.snapshot);
      else {
        const commandError = error?.message || "Не удалось выполнить команду.";
        if (command.startsWith("work.")) workCommandError = commandError;
        else if (command.startsWith("business."))
          businessCommandError = commandError;
        const prior = server ?? {};
        server = {
          ...prior,
          battle: {
            ...(prior.battle ?? {}),
            error: error?.message || "Не удалось выполнить действие боя",
            errorStatus: error?.status ?? null,
            needsRefresh: true,
          },
        };
        publish();
      }
      return false;
    } finally {
      if (connected && run === epoch) {
        pendingCommands = Math.max(0, pendingCommands - 1);
        publish();
        schedulePoll();
      }
    }
  }

  function localOpen(boss) {
    localBoss = boss ?? localBoss;
    visible = true;
    publish();
    schedulePoll();
  }
  async function open(
    boss,
    { refresh = true, openingRequirements: requirements } = {},
  ) {
    const currentBoss = localBoss ?? snapshot.boss;
    const sameBoss =
      String(numericId(currentBoss) ?? currentBoss?.id) ===
      String(numericId(boss) ?? boss?.id);
    if (requirements !== undefined || !sameBoss) {
      openingBossId = numericId(boss);
      openingRequirements = Array.isArray(requirements)
        ? requirements.map(({ destination, label, note, verification }) => ({
            destination,
            label,
            note,
            verification,
          }))
        : [];
    }
    localOpen(boss);
    if (!refresh && sameBoss) return true;
    const bossId = numericId(boss);
    return bossId === null ? false : send("open", { bossId });
  }
  function close() {
    visible = false;
    publish();
    schedulePoll();
  }
  function reset() {
    disconnect();
  }

  const battle = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    connect,
    disconnect,
    open,
    close,
    reset,
    start: () => send("start"),
    startNextBattle: () => send("next"),
    attack: () => send("attack"),
    refresh: () => send("refresh"),
    hydrateDetails: () => send("hydrate"),
    openMedicines: () => send("medicines.open"),
    closeMedicines: () => send("medicines.close"),
    useMedicine: (type) => send("medicine.use", { type }),
    preparePurchase: (type, currency, quantity) =>
      send("purchase.prepare", { type, currency, quantity }),
    cancelPurchase: () => send("purchase.cancel"),
    buyMedicine: () => send("purchase.buy"),
    acknowledgePurchase: () => send("purchase.ack"),
  };

  const auto = {
    subscribe(listener) {
      autoListeners.add(listener);
      return () => autoListeners.delete(listener);
    },
    getSnapshot: () => autoSnapshot,
    start: () => send("auto.start"),
    stop: () => send("auto.stop"),
  };
  const goal = {
    subscribe(listener) {
      goalListeners.add(listener);
      return () => goalListeners.delete(listener);
    },
    getSnapshot: () => goalSnapshot,
    canStart() {
      return !goalSnapshot || Boolean(goalSnapshot.canStart);
    },
    configure: (args) => send("goal.configure", args),
    stop: () => send("goal.stop"),
    reset: () => send("goal.reset"),
  };
  const pvp = {
    subscribe(listener) {
      pvpListeners.add(listener);
      return () => pvpListeners.delete(listener);
    },
    getSnapshot: () => pvpSnapshot,
    open: () => {
      pvpVisible = true;
      publish();
      return send("pvp.refresh");
    },
    close: () => {
      pvpVisible = false;
      publish();
      schedulePoll();
    },
    refresh: () => send("pvp.refresh"),
  };

  const preferences = {
    subscribe(listener) {
      preferencesListeners.add(listener);
      return () => preferencesListeners.delete(listener);
    },
    getSnapshot: () => preferencesSnapshot,
    setFavoriteBossIds: (bossIds) => send("favorites.set", { bossIds }),
  };

  const businessAssistant = {
    subscribe(listener) {
      businessListeners.add(listener);
      return () => businessListeners.delete(listener);
    },
    getSnapshot: () => businessSnapshot,
    select: (businessId) => send("business.select", { businessId }),
    save: (args) => send("business.save", args),
    refresh: (businessId) => send("business.refresh", { businessId }),
    createGoal: (args) => send("business.goal", args),
    startRun: (args) => send("business.run.start", args),
    stopRun: () => send("business.run.stop"),
  };
  const workFarm = {
    subscribe(listener) {
      workFarmListeners.add(listener);
      return () => workFarmListeners.delete(listener);
    },
    getSnapshot: () => workFarmSnapshot,
    refresh: (workId, options = {}) =>
      send("work.refresh", { workId, ...options }),
    plan: (args) => send("work.plan", args),
    start: (args) => send("work.start", args),
    stop: () => send("work.stop"),
  };
  return Object.freeze({
    businessAssistant,
    workFarm,
    bossBattle: battle,
    bossBattleAuto: auto,
    bossBattleGoal: goal,
    pvpBattle: pvp,
    preferences,
    connect,
    disconnect,
    reset,
  });
}
