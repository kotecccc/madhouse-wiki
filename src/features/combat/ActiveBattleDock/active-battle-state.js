export function isActiveBattle(battle, now = Date.now()) {
  return Boolean(
    battle &&
    typeof battle.id === "string" &&
    battle.id &&
    battle.status === "active" &&
    (battle.expiresAt == null || now < battle.expiresAt),
  );
}

export function activeBattleEntries(
  bossState,
  pvpState,
  now = Date.now(),
  auto = null,
) {
  const entries = [];
  // Without polling, retain the last server-confirmed active fight until a
  // manual refresh/action returns its outcome. Expiry alone is not that outcome.
  const rememberedBoss =
    bossState.battle &&
    isActiveBattle({ ...bossState.battle, expiresAt: null }, now);
  if (bossState.boss && (rememberedBoss || auto?.enabled))
    entries.push({
      kind: "boss",
      title: bossState.boss.name,
      battle: bossState.battle,
    });
  if (isActiveBattle(pvpState.battle, now))
    entries.push({ kind: "pvp", title: "PvP", battle: pvpState.battle });
  return entries;
}

export function normalizePvpBattle(raw, expectedId, now = Date.now()) {
  if (
    !raw ||
    raw.battleId !== expectedId ||
    !/^[A-Za-z0-9_-]+$/.test(raw.battleId) ||
    typeof raw.status !== "string"
  )
    throw new Error("Неподдерживаемое состояние PvP");
  const serverTime = Date.parse(raw.serverTimeUtc);
  const expires = Date.parse(raw.expiresAtUtc);
  const health = (value) =>
    Number.isFinite(value) && value >= 0 ? value : null;
  return {
    id: raw.battleId,
    status: raw.status.trim().toLowerCase(),
    playerHealth: health(raw.playerHealth),
    opponentHealth: health(raw.opponentHealth),
    expiresAt: Number.isFinite(expires)
      ? now + expires - (Number.isFinite(serverTime) ? serverTime : now)
      : null,
  };
}

// Read-only observer. No player identities, raw payloads, mutations or disk state.
export function createPvpBattleObserver({ request, now = Date.now }) {
  let state = { battle: null, visible: false, pending: false, error: false };
  let generation = 0;
  let controller;
  const listeners = new Set();
  function publish(patch) {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  }
  async function refresh() {
    if (state.pending) return;
    const version = generation;
    controller = new AbortController();
    const signal = controller.signal;
    const get = (path) => {
      if (generation !== version || signal.aborted)
        throw new Error("Сессия изменилась");
      return request(path, { signal, fresh: true });
    };
    publish({ pending: true, error: false });
    try {
      let id = isActiveBattle(state.battle, now()) ? state.battle.id : null;
      if (!id) {
        const current = await get("/api/combat");
        id = current?.activeBattle?.battleId;
      }
      let battle = null;
      if (typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id))
        battle = normalizePvpBattle(
          await get(`/api/combat/battles/${encodeURIComponent(id)}`),
          id,
          now(),
        );
      if (version === generation) publish({ battle });
    } catch {
      if (version === generation) publish({ battle: null, error: true });
    } finally {
      if (version === generation) publish({ pending: false });
    }
  }
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    open() {
      publish({ visible: true });
      void refresh();
    },
    close: () => publish({ visible: false }),
    reset() {
      generation++;
      controller?.abort();
      publish({ battle: null, visible: false, pending: false, error: false });
    },
  };
}
