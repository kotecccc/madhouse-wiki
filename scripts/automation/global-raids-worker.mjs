const DAY = 86400000;
const FIVE_MINUTES = 300000;
const PUBLISH_INTERVAL = 60000;
const HALF_HOUR = 1800000;
const FRESH = 90000;
const dayOf = (now) => new Date(now + 3 * 3600000).toISOString().slice(0, 10);
const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const identifier = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(v);

export function advanceGlobalRaidDay(state, now) {
  const day = dayOf(now);
  if (state.day === day) return state;
  const carry =
    state.day === dayOf(now - DAY)
      ? (state.raids || [])
          .filter((r) => r.active || now - r.lastBattleAt <= HALF_HOUR)
          .map((r) => ({
            ...r,
            carried: true,
            base: { ...r, base: undefined },
            carriedIds: [
              ...new Set(
                [...(r.activeIds || []), r.lastBattleId].filter(Boolean),
              ),
            ],
          }))
      : [];
  const ids = new Set(carry.flatMap((r) => r.carriedIds));
  const observations = Object.fromEntries(
    Object.entries(state.observations || {}).filter(([id]) => ids.has(id)),
  );
  return {
    schema: 2,
    day,
    observations,
    raids: carry,
    messageId: null,
    pendingSend: false,
    nextPublishAt: 0,
  };
}

export function observeGlobalInvitations(state, playerId, raw, projected, now) {
  if (
    !Array.isArray(raw?.items) ||
    raw.partial ||
    raw.error ||
    raw.success === false ||
    !Array.isArray(projected)
  )
    return state;
  state = advanceGlobalRaidDay(state, now);
  const source = String(playerId);
  const byId = new Map(
    raw.items.slice(0, 100).map((item) => [item?.invitationId, item]),
  );
  // A full 100-item page may be truncated; missing entries are not evidence.
  if (
    raw.items.length < 100 &&
    raw.hasMore !== true &&
    !raw.nextCursor &&
    !raw.nextPage
  ) {
    for (const observation of Object.values(state.observations)) {
      if (observation.sources?.[source])
        observation.sources[source] = {
          ...observation.sources[source],
          active: false,
          checkedAt: now,
        };
    }
  }
  for (const invitation of projected) {
    const item = byId.get(invitation.invitationId);
    if (
      !item ||
      !invitation.available ||
      !identifier(invitation.battleId) ||
      !positive(invitation.bossId) ||
      !positive(item.leaderPlayerId) ||
      !Number.isFinite(invitation.expiresAt)
    )
      continue;
    const old = state.observations[invitation.battleId];
    if (
      old &&
      (old.bossId !== invitation.bossId ||
        old.leaderPlayerId !== item.leaderPlayerId)
    )
      continue;
    const isLeader =
      item.peerPlayerId === item.leaderPlayerId &&
      item.inviterPlayerId === item.leaderPlayerId;
    const value = old || {
      id: invitation.battleId,
      bossId: invitation.bossId,
      leaderPlayerId: item.leaderPlayerId,
      firstSeen: now,
      sources: {},
    };
    value.lastSeen = now;
    if (
      isLeader &&
      typeof item.peerNickname === "string" &&
      item.peerNickname.trim()
    )
      value.leaderName = item.peerNickname.trim().slice(0, 80);
    if (
      isLeader &&
      typeof item.peerUsername === "string" &&
      /^[A-Za-z0-9_]{5,32}$/.test(item.peerUsername)
    )
      value.leaderUsername = item.peerUsername;
    value.sources[source] = {
      active: true,
      checkedAt: now,
      expiresAt: invitation.expiresAt,
    };
    state.observations[value.id] = value;
  }
  return refreshGlobalRaidRows(state, now);
}

export function refreshGlobalRaidRows(state, now) {
  const groups = new Map();
  for (const obs of Object.values(state.observations || {})) {
    if (
      !positive(obs.leaderPlayerId) ||
      !positive(obs.bossId) ||
      !Number.isFinite(obs.firstSeen)
    )
      continue;
    const key = `${obs.leaderPlayerId}:${obs.bossId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(obs);
  }
  const rows = (state.raids || [])
    .filter((r) => r.carried && r.base)
    .map((r) => ({
      ...r.base,
      carried: true,
      base: r.base,
      carriedIds: r.carriedIds || [],
    }));
  for (const [key, events] of groups) {
    events.sort(
      (a, b) => a.firstSeen - b.firstSeen || a.id.localeCompare(b.id),
    );
    let row = rows.find((r) => r.key === key && r.carried);
    let pending = [];
    for (const event of events) {
      if (
        row &&
        !row.carriedIds?.includes(event.id) &&
        event.firstSeen > row.lastBattleAt + HALF_HOUR
      )
        row = null;
      if (
        !row &&
        pending.length &&
        event.firstSeen > pending.at(-1).lastSeen + HALF_HOUR
      )
        pending = [];
      if (!row) {
        pending.push(event);
        const last = pending.slice(-6);
        if (last.length < 6 || last[5].firstSeen - last[0].firstSeen > 7200000)
          continue;
        row = {
          key,
          bossId: event.bossId,
          leaderPlayerId: event.leaderPlayerId,
          count: pending.length,
          lastBattleAt: event.lastSeen,
          activeIds: [],
          sources: {},
          carried: false,
        };
        rows.push(row);
        for (const item of pending) Object.assign(row.sources, item.sources);
        pending = [];
      } else if (!row.carriedIds?.includes(event.id)) row.count++;
      if (event.lastSeen >= (row.lastBattleAt || 0))
        row.lastBattleId = event.id;
      row.lastBattleAt = Math.max(row.lastBattleAt || 0, event.lastSeen);
      row.leaderName = event.leaderName || row.leaderName;
      row.leaderUsername = event.leaderUsername || row.leaderUsername;
      for (const [id, source] of Object.entries(event.sources || {})) {
        if (!row.sources[id] || source.checkedAt >= row.sources[id].checkedAt)
          row.sources[id] = source;
      }
    }
    if (row)
      row.activeIds = events
        .filter((e) =>
          Object.values(e.sources || {}).some(
            (s) => s.active && s.expiresAt > now && now - s.checkedAt <= FRESH,
          ),
        )
        .map((e) => e.id);
  }
  for (const row of rows) {
    row.active = row.activeIds?.length > 0;
    row.fresh = Object.values(row.sources || {}).some(
      (s) => now - s.checkedAt <= FRESH,
    );
  }
  state.raids = rows;
  return state;
}

export function formatGlobalRaidSummary(state, now, getBoss) {
  const lines = [
    `🔥 <b>РЕЙДЫ — ${state.day.split("-").reverse().join(".")}</b>`,
    "",
  ];
  const rows = [...state.raids].sort((a, b) => b.lastBattleAt - a.lastBattleAt);
  for (const row of rows) {
    const age = now - row.lastBattleAt;
    const status = row.active
      ? "🔵 Идёт"
      : !row.fresh
        ? "⚪ Ждёт · данные устарели"
        : age <= FIVE_MINUTES
          ? "⚪ Ждёт"
          : age <= HALF_HOUR
            ? `🟡 Пауза · ${Math.floor(age / 60000)} мин`
            : "🔴 Завершён";
    const boss = getBoss(row.bossId);
    const zone = /^dept-[A-Za-z0-9]+$/.test(boss?.departmentId || "")
      ? boss.departmentId.slice(5)
      : "—";
    const name = row.leaderName || `Игрок №${row.leaderPlayerId}`;
    const username = /^[A-Za-z0-9_]{5,32}$/.test(row.leaderUsername || "")
      ? ` (@${row.leaderUsername})`
      : "";
    const line = `${status} · ${escape(zone)} · ${escape(boss?.name || `Босс №${row.bossId}`)} · ${escape(name)}${username} · ${row.count}`;
    if (lines.join("\n").length + line.length > 3500) {
      lines.push(`Ещё рейдов: ${rows.length - (lines.length - 2)}`);
      break;
    }
    lines.push(line);
  }
  if (!rows.length) lines.push("Активных рейдов пока нет.");
  lines.push(
    "",
    `Обновлено: ${new Intl.DateTimeFormat("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", minute: "2-digit" }).format(now)} МСК`,
  );
  return lines.join("\n");
}

export function createGlobalRaidsWorker({
  store,
  owner,
  now,
  telegram,
  chatId,
  getBoss,
  isClosed,
}) {
  let running = false;
  let nextAttempt = 0;
  const save = (state) => store.writeGlobalRaids(state, owner, now());
  const load = () => {
    let state = store.readGlobalRaids() || {};
    if (state.schema !== 2)
      state = {
        schema: 2,
        day: state.day,
        observations: {},
        raids: (state.raids || []).map((raid) => ({
          ...raid,
          sources: {},
          activeIds: [],
          carried: true,
          carriedIds: raid.activeId ? [raid.activeId] : [],
          base: { ...raid, sources: {}, activeIds: [] },
        })),
        messageId: state.messageId,
        pendingSend: state.pendingSend,
        nextPublishAt: state.nextPublishAt || 0,
      };
    return advanceGlobalRaidDay(state, now());
  };
  return {
    observe(playerId, raw, projected) {
      if (isClosed()) return;
      const state = observeGlobalInvitations(
        load(),
        playerId,
        raw,
        projected,
        now(),
      );
      save(state);
    },
    async tick() {
      if (running || isClosed() || now() < nextAttempt) return;
      running = true;
      try {
        let state = refreshGlobalRaidRows(load(), now());
        save(state);
        if (now() < state.nextPublishAt || state.pendingSend) return;
        const text = formatGlobalRaidSummary(state, now(), getBoss);
        const day = state.day;
        const messageId = state.messageId;
        if (!messageId) {
          state.pendingSend = true;
          save(state);
        }
        try {
          const result = await telegram.request(
            messageId ? "editMessageText" : "sendMessage",
            {
              chat_id: chatId,
              ...(messageId ? { message_id: messageId } : {}),
              text,
              parse_mode: "HTML",
            },
          );
          if (isClosed()) return;
          const id = messageId || result?.message_id;
          if (!Number.isSafeInteger(id) || id <= 0)
            throw new Error("missing_message_id");
          state = load();
          if (state.day !== day || state.messageId !== messageId) return;
          state.messageId = id;
          state.pendingSend = false;
          state.nextPublishAt = now() + PUBLISH_INTERVAL;
          state.lastText = text;
          save(state);
        } catch (error) {
          state = load();
          if (state.day !== day || state.messageId !== messageId) return;
          if (
            !messageId &&
            Number.isInteger(error?.status) &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408
          )
            state.pendingSend = false;
          state.nextPublishAt =
            now() +
            Math.max(PUBLISH_INTERVAL, Number(error?.retryAfterMs) || 0);
          save(state);
        }
      } finally {
        running = false;
        nextAttempt = now() + 30000;
      }
    },
  };
}
