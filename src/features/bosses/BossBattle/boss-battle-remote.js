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
const EMPTY_RAID = Object.freeze({ enabled: false });
const EMPTY_AUTO = Object.freeze({
  enabled: false,
  nextAttackAt: null,
  pause: false,
});
const EMPTY_INVITATIONS = Object.freeze({
  items: [],
  loaded: false,
  pending: false,
  notice: null,
  error: null,
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
  launchBattle,
} = {}) {
  if (typeof request !== "function") throw new TypeError("request is required");

  const listeners = new Set();
  const autoListeners = new Set();
  const goalListeners = new Set();
  const pvpListeners = new Set();
  const preferencesListeners = new Set();
  const businessListeners = new Set();
  const characterListeners = new Set();
  const workFarmListeners = new Set();
  const floorListeners = new Set();
  const invitationListeners = new Set();
  const subscriptionListeners = new Set();
  let connected = false;
  let launchPending = Boolean(launchBattle);
  let transportError = null;
  let workCommandError = null;
  let businessCommandError = null;
  let floorCommandError = null;
  let characterCommandError = null;
  let invitationCommandError = null;
  let friendCommandError = null;
  let epoch = 0;
  let timer = null;
  let pendingCommands = 0;
  let stateRead = null;
  let visible = false;
  let pvpVisible = false;
  let raidsVisible = false;
  let localBoss = null;
  // Public requirement context belongs to the dialog; execution goals remain server-owned.
  let openingBossId = null;
  let openingRequirements = [];
  let server = null;
  let serverReady = false;
  let snapshot = EMPTY_BATTLE;
  let autoSnapshot = EMPTY_AUTO;
  let goalSnapshot = null;
  let pvpSnapshot = EMPTY_PVP;
  let businessSnapshot = EMPTY_BUSINESS;
  let characterSnapshot = Object.freeze({
    profile: null,
    pending: false,
    loaded: false,
  });
  let workFarmSnapshot = EMPTY_WORK_FARM;
  let floorSnapshot = Object.freeze({
    status: "stopped",
    loaded: false,
    pending: false,
  });
  let invitationSnapshot = EMPTY_INVITATIONS;
  let subscriptionSnapshot = Object.freeze({
    detectedRaids: [],
    subscription: null,
    loaded: false,
    friend: { statuses: {} },
    pending: false,
  });
  let preferencesSnapshot = Object.freeze({ favoriteBossIds: [] });

  const notify = (set, value) => {
    for (const listener of [...set]) listener(value);
  };
  function publish() {
    const savedBattle = server?.battle ?? {};
    // While switching targets, do not label the previous result as the selected
    // boss. Server reconciliation may still return an actually active old fight.
    const battleState =
      pendingCommands > 0 &&
      localBoss &&
      numericId(savedBattle.boss) !== numericId(localBoss)
        ? { ...EMPTY_BATTLE, boss: localBoss }
        : savedBattle;
    snapshot = Object.freeze({
      ...EMPTY_BATTLE,
      ...battleState,
      raid: server?.raid ?? EMPTY_RAID,
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
    characterSnapshot = Object.freeze({
      ...(server?.characterUpgrade ?? {}),
      loaded: Boolean(server?.characterUpgrade),
      busy: pendingCommands > 0,
      blocked: false,
      error: transportError || characterCommandError,
    });
    notify(characterListeners, characterSnapshot);
    workFarmSnapshot = Object.freeze({
      ...EMPTY_WORK_FARM,
      ...(server?.workFarm ?? {}),
      loaded: Boolean(server),
      pending: pendingCommands > 0,
      error: transportError || workCommandError,
    });
    notify(workFarmListeners, workFarmSnapshot);
    floorSnapshot = Object.freeze({
      ...(server?.floorRunner ?? { status: "stopped" }),
      loaded: Boolean(server),
      pending: pendingCommands > 0,
      error: transportError || floorCommandError,
    });
    notify(floorListeners, floorSnapshot);
    invitationSnapshot = Object.freeze({
      ...EMPTY_INVITATIONS,
      ...(server?.invitations ?? {}),
      pending: pendingCommands > 0,
      unresolved: Boolean(server?.battle?.pendingInvitation),
      blocked: Boolean(
        server?.auto?.enabled ||
        server?.workFarm?.run?.status === "running" ||
        server?.businessAssistant?.run?.status === "running" ||
        server?.battle?.battle?.status === "active",
      ),
      error: transportError || invitationCommandError,
    });
    notify(invitationListeners, invitationSnapshot);
    subscriptionSnapshot = Object.freeze({
      detectedRaids: server?.detectedRaids ?? [],
      subscription: server?.subscription ?? null,
      loaded: connected && serverReady,
      friend: server?.raidFriend ?? { statuses: {} },
      friendError: friendCommandError,
      pending: pendingCommands > 0,
      error: transportError || invitationCommandError,
    });
    notify(subscriptionListeners, subscriptionSnapshot);
  }

  function setServerState(value) {
    transportError = null;
    workCommandError = null;
    businessCommandError = null;
    floorCommandError = null;
    characterCommandError = null;
    invitationCommandError = null;
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
    ) {
      server = value;
      serverReady = true;
    }
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
      raidsVisible ||
      server?.auto?.enabled ||
      server?.raid?.enabled ||
      server?.buddy?.enabled ||
      server?.buddy?.hasSuspendedGoal ||
      server?.subscription?.enabled ||
      server?.subscription?.hasSuspendedGoal ||
      server?.goal?.status === "running" ||
      server?.goal?.status === "active" ||
      server?.businessAssistant?.run?.status === "running" ||
      server?.workFarm?.run?.status === "running" ||
      server?.floorRunner?.status === "running" ||
      server?.characterUpgrade?.run?.status === "running"
    );
  }
  const pollInterval = () =>
    transportError || workCommandError || businessCommandError || launchPending
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
      // Restore the local server view before optional live game discovery.
      // A slow/failed launch must not hide durable jobs or their stop controls.
      if (launchPending && !server) {
        const saved = await request("GET", "/api/automation/state");
        if (!connected || run !== epoch) return false;
        setServerState(saved);
      }
      let result;
      try {
        result = launchPending
          ? await request("POST", "/api/automation/launch", {
              activeBossBattle: launchBattle(),
            })
          : await request("GET", "/api/automation/state");
      } catch (error) {
        // A 409 is returned before launch reconciliation starts. Keep the
        // durable server view visible and retry this read-only reconciliation.
        if (launchPending && error?.status === 409 && error.snapshot) {
          if (!connected || run !== epoch) return false;
          setServerState(error.snapshot);
          return false;
        }
        throw error;
      }
      if (!connected || run !== epoch) return false;
      launchPending = false;
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
    launchPending = Boolean(launchBattle);
    visibility?.removeEventListener("visibilitychange", onVisibilityChange);
    transportError = null;
    workCommandError = null;
    businessCommandError = null;
    characterCommandError = null;
    invitationCommandError = null;
    friendCommandError = null;
    epoch++;
    clearTimer();
    pendingCommands = 0;
    visible = false;
    pvpVisible = false;
    raidsVisible = false;
    localBoss = null;
    openingBossId = null;
    openingRequirements = [];
    server = null;
    serverReady = false;
    publish();
  }

  async function send(command, args = {}) {
    const urgent =
      command === "auto.stop" ||
      command === "raid.stop" ||
      command === "subscription.stop" ||
      command === "goal.stop" ||
      command === "business.run.stop" ||
      command === "character.stop" ||
      command === "work.stop";
    const floorStop = command === "floor.stop";
    if (!connected || (!urgent && !floorStop && pendingCommands > 0))
      return false;
    if (command.startsWith("floor.")) floorCommandError = null;
    if (command.startsWith("raid.friend.")) friendCommandError = null;
    pendingCommands++;
    publish();
    const run = epoch;
    try {
      let value;
      for (let attempt = 0; ; attempt++) {
        try {
          value = await request("POST", "/api/automation/commands", {
            id: commandId(makeId),
            expectedVersion: server?.version ?? null,
            command,
            args,
          });
          break;
        } catch (error) {
          if (!connected || run !== epoch) return false;
          if (error?.status === 409 && error.snapshot) {
            setServerState(error.snapshot);
            // Refresh is read-only, so it can safely rebase once on the
            // conflict snapshot. Never replay a command that can mutate state.
            if (
              ["work.refresh", "character.refresh"].includes(command) &&
              attempt === 0
            )
              continue;
          }
          throw error;
        }
      }
      if (!connected || run !== epoch) return false;
      setServerState(value);
      return true;
    } catch (error) {
      if (!connected || run !== epoch) return false;
      if (command.startsWith("floor.")) {
        floorCommandError =
          "Не удалось изменить авторежим. Проверьте активные цели и повторите попытку.";
        publish();
      }
      if (
        error?.status === 409 &&
        error.snapshot &&
        command.startsWith("subscription.")
      ) {
        invitationCommandError =
          "Состояние изменилось. Проверьте рейд и попробуйте снова.";
        publish();
      }
      if (command.startsWith("raid.friend.")) {
        friendCommandError =
          "Не удалось проверить или изменить заявку. Проверьте состояние и попробуйте снова.";
        publish();
      }
      if (
        error?.status === 409 &&
        error.snapshot &&
        command.startsWith("business.")
      ) {
        businessCommandError =
          "Состояние изменилось. Проверьте план и попробуйте снова.";
        publish();
      }
      if (command.startsWith("character.")) {
        characterCommandError =
          error?.status === 409
            ? "Состояние изменилось. Обновите данные и проверьте прокачку."
            : "Не удалось выполнить запрос. Проверьте состояние перед повтором.";
        publish();
      }
      if (
        !(error?.status === 409 && error.snapshot) &&
        !command.startsWith("raid.friend.") &&
        !command.startsWith("character.")
      ) {
        const commandError = error?.message || "Не удалось выполнить команду.";
        if (
          command.startsWith("invitations.") ||
          command.startsWith("subscription.")
        )
          invitationCommandError = commandError;
        else if (command.startsWith("work.")) workCommandError = commandError;
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
        ? requirements.map(
            ({
              destination,
              label,
              note,
              verification,
              category,
              required,
              current,
              kind,
              itemKey,
            }) => ({
              destination,
              label,
              note,
              verification,
              ...(category ? { category } : {}),
              ...(Number.isSafeInteger(required) && required > 0
                ? { required }
                : {}),
              ...(Number.isSafeInteger(current) && current >= 0
                ? { current }
                : {}),
              ...(kind === "business_items" ? { kind, itemKey } : {}),
            }),
          )
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
    configureHealing: (settings) => send("healing.configure", { settings }),
    acknowledgeHealing: () => send("healing.ack"),
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
    start: (settings) => send("auto.start", settings ? { settings } : {}),
    stop: () => send("auto.stop"),
    startRaid: (settings) => send("raid.start", { settings }),
    stopRaid: () => send("raid.stop"),
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
  const characterUpgrade = {
    subscribe(listener) {
      characterListeners.add(listener);
      return () => characterListeners.delete(listener);
    },
    getSnapshot: () => characterSnapshot,
    refresh: () => send("character.refresh"),
    upgrade: (args) => send("character.upgrade", args),
    start: (args) => send("character.start", args),
    startAll: (args) => send("character.startAll", args),
    stop: () => send("character.stop"),
  };
  const workFarm = {
    subscribe(listener) {
      workFarmListeners.add(listener);
      return () => workFarmListeners.delete(listener);
    },
    getSnapshot: () => workFarmSnapshot,
    refresh: (workId, options = {}) =>
      send("work.refresh", { workId, ...options }),
    useBooster: (workId, type) => send("work.booster.use", { workId, type }),
    plan: (args) => send("work.plan", args),
    start: (args) => send("work.start", args),
    stop: () => send("work.stop"),
  };
  const bossInvitations = {
    subscribe(listener) {
      invitationListeners.add(listener);
      return () => invitationListeners.delete(listener);
    },
    getSnapshot: () => invitationSnapshot,
    refresh: () => send("invitations.refresh"),
    async accept(invitationId) {
      const accepted = await send("invitations.accept", { invitationId });
      if (
        accepted &&
        server?.battle?.battle &&
        !server.battle.pendingInvitation
      ) {
        openingBossId = null;
        openingRequirements = [];
        localOpen(server.battle.boss);
        return true;
      }
      return false;
    },
    async reconcile() {
      const refreshed = await send("invitations.refresh");
      if (
        refreshed &&
        server?.battle?.invitationOnly &&
        server.battle.battle &&
        !server.battle.pendingInvitation
      ) {
        openingBossId = null;
        openingRequirements = [];
        localOpen(server.battle.boss);
        return true;
      }
      return false;
    },
  };
  const raidSubscriptions = {
    subscribe(listener) {
      subscriptionListeners.add(listener);
      return () => subscriptionListeners.delete(listener);
    },
    getSnapshot: () => subscriptionSnapshot,
    watch(value) {
      raidsVisible = Boolean(value);
      if (connected) schedulePoll(0);
    },
    start: (leaderPlayerId, bossId, leaderUsername) =>
      send("subscription.start", { leaderPlayerId, bossId, leaderUsername }),
    stop: () => send("subscription.stop"),
    checkFriends: (targets) => send("raid.friend.check", { targets }),
    inspectFriend: (playerId, username) =>
      send("raid.friend.inspect", { playerId, username }),
    requestFriend: (playerId, username) =>
      send("raid.friend.request", { playerId, username }),
    refreshFriend: () => send("raid.friend.refresh"),
  };
  const floorAutomation = {
    subscribe(listener) {
      floorListeners.add(listener);
      return () => floorListeners.delete(listener);
    },
    getSnapshot: () => floorSnapshot,
    start: () => send("floor.start"),
    stop: () => send("floor.stop"),
  };
  return Object.freeze({
    floorAutomation,
    bossInvitations,
    raidSubscriptions,
    businessAssistant,
    characterUpgrade,
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
