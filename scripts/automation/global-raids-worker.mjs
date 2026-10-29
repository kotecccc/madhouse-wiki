import { projectGlobalRaidBattle } from "./global-raids.mjs";

const DAY = 86400000;
const HALF_HOUR = 1800000;
const INTERVAL = 300000;
const SCAN_INTERVAL = 30000;
const dayOf = (now) => new Date(now + 3 * 3600000).toISOString().slice(0, 10);
const dayStart = (day) => Date.parse(`${day}T00:00:00+03:00`);
const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

export function advanceGlobalRaidDay(state, now) {
  const day = dayOf(now);
  if (state.day === day) return state;
  const previous = state.day === dayOf(now - DAY);
  const carry = previous
    ? (state.raids || [])
        .filter((raid) => raid.active || now - raid.lastBattleAt <= HALF_HOUR)
        .map((raid) => ({
          ...raid,
          carried: true,
          base: { ...raid, carried: true, base: undefined },
        }))
    : [];
  const observations = Object.fromEntries(
    Object.entries(state.observations || {}).filter(
      ([, battle]) =>
        previous &&
        battle.status === "active" &&
        carry.some((raid) => raid.activeId === battle.id),
    ),
  );
  return {
    day,
    observations,
    raids: carry,
    messageId: null,
    pendingSend: false,
    lastText: null,
    nextPublishAt: 0,
  };
}

// Derive sessions from independently observed and deduplicated battle IDs.
export function refreshGlobalRaidRows(state, _now) {
  const previous = state.raids || [];
  const grouped = new Map();
  for (const battle of Object.values(state.observations || {})) {
    const key = `${battle.leaderPlayerId}:${battle.bossId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(battle);
  }
  const rows = previous
    .filter((row) => row.carried)
    .map((row) => ({ ...row.base, carried: true, base: row.base }));
  for (const [key, battles] of grouped) {
    battles.sort(
      (a, b) =>
        (a.startedAt ?? a.completedAt ?? a.seenAt) -
        (b.startedAt ?? b.completedAt ?? b.seenAt),
    );
    let row = rows.find((item) => item.key === key && item.carried);
    let sequence = [];
    for (const battle of battles) {
      const started = battle.startedAt ?? battle.completedAt ?? battle.seenAt;
      if (
        row &&
        started > row.lastBattleAt + HALF_HOUR &&
        row.activeId !== battle.id
      )
        row = null;
      if (
        !row &&
        sequence.length &&
        started > sequence.at(-1).completedAt + HALF_HOUR
      )
        sequence = [];
      if (battle.status === "active") {
        if (row) {
          row.active = true;
          row.activeId = battle.id;
          row.activeSeenAt = battle.seenAt;
        }
        continue;
      }
      if (row) {
        if (row.activeId === battle.id) row.activeId = null;
        row.active = false;
        row.lastBattleAt = Math.max(row.lastBattleAt, battle.completedAt);
        row.count += 1;
        continue;
      }
      sequence.push(battle);
      const lastSix = sequence.slice(-6);
      if (
        lastSix.length === 6 &&
        lastSix[5].completedAt - lastSix[0].completedAt <= 7200000
      ) {
        row = {
          key,
          bossId: battle.bossId,
          leaderPlayerId: battle.leaderPlayerId,
          leaderName: battle.leaderName,
          leaderUsername: battle.leaderUsername,
          startedAt: sequence[0].startedAt ?? sequence[0].completedAt,
          lastBattleAt: battle.completedAt,
          count: sequence.length,
          active: false,
          carried: false,
        };
        rows.push(row);
        sequence = [];
      }
    }
  }
  state.raids = rows;
  return state;
}

export function formatGlobalRaidSummary(state, now, getBoss) {
  const lines = [
    `🔥 <b>РЕЙДЫ — ${state.day.split("-").reverse().join(".")}</b>`,
    "Время: МСК",
    "",
  ];
  const rows = [...state.raids].sort((a, b) => b.lastBattleAt - a.lastBattleAt);
  for (const row of rows) {
    const age = now - row.lastBattleAt;
    const status =
      row.active && now - row.activeSeenAt <= INTERVAL * 2
        ? "🔵 Идёт"
        : row.active
          ? "⚪ Нет данных"
          : age <= 300000
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
    const line = `${status} · ${escape(zone)} · ${escape(boss?.name || `Босс №${row.bossId}`)} · ${escape(name)}${username} · ${row.count} боёв`;
    if (lines.join("\n").length + line.length > 3500) {
      lines.push(`Ещё рейдов: ${rows.length - (lines.length - 3)}`);
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
  readGame,
  canRead,
  actors,
  isClosed,
}) {
  let running = false;
  let nextScan = 0;
  function save(state) {
    store.writeGlobalRaids(state, owner, now());
  }
  return {
    async tick() {
      if (running || isClosed() || !telegram || !chatId || now() < nextScan)
        return;
      running = true;
      nextScan = now() + SCAN_INTERVAL;
      try {
        let state = advanceGlobalRaidDay(store.readGlobalRaids() || {}, now());
        save(state);
        const all = [...actors()];
        for (const entry of all) {
          if (isClosed()) return;
          if (!canRead(entry)) continue;
          let invitations;
          try {
            invitations = await readGame(
              entry.credential,
              "/api/bosses/invitations?direction=incoming&status=pending",
            );
          } catch {
            continue;
          }
          if (
            !Array.isArray(invitations?.items) ||
            invitations.partial ||
            invitations.error ||
            invitations.success === false
          )
            continue;
          const candidates = new Map();
          for (const invite of invitations.items.slice(0, 100)) {
            if (
              typeof invite?.battleId === "string" &&
              /^[A-Za-z0-9_-]{1,120}$/.test(invite.battleId) &&
              Number.isSafeInteger(invite.bossId) &&
              invite.bossId > 0
            )
              candidates.set(invite.battleId, invite);
          }
          for (const existing of Object.values(state.observations)) {
            if (
              existing.status === "active" &&
              existing.sourcePlayerId === entry.playerId &&
              !candidates.has(existing.id)
            )
              candidates.set(existing.id, {
                battleId: existing.id,
                bossId: existing.bossId,
                leaderPlayerId: existing.leaderPlayerId,
              });
          }
          for (const invite of candidates.values()) {
            if (isClosed()) return;
            const recorded = state.observations[invite.battleId];
            if (recorded && recorded.status !== "active") continue;
            let detail;
            try {
              detail = await readGame(
                entry.credential,
                `/api/bosses/battles/${invite.battleId}`,
              );
            } catch {
              continue;
            }
            const battle = projectGlobalRaidBattle(invite, detail);
            state = advanceGlobalRaidDay(state, now());
            if (
              !battle ||
              (battle.completedAt != null &&
                battle.completedAt < dayStart(state.day))
            )
              continue;
            const previous = state.observations[battle.id];
            if (previous && previous.status !== "active") continue;
            state.observations[battle.id] = {
              ...battle,
              seenAt: now(),
              sourcePlayerId: entry.playerId,
            };
          }
          state = refreshGlobalRaidRows(state, now());
          save(state);
        }
        state = advanceGlobalRaidDay(state, now());
        state = refreshGlobalRaidRows(state, now());
        save(state);
        if (isClosed() || now() < state.nextPublishAt || state.pendingSend)
          return;
        const text = formatGlobalRaidSummary(state, now(), getBoss);
        if (!state.messageId) {
          state.pendingSend = true;
          save(state);
        }
        try {
          const result = await telegram.request(
            state.messageId ? "editMessageText" : "sendMessage",
            {
              chat_id: chatId,
              ...(state.messageId ? { message_id: state.messageId } : {}),
              text,
              parse_mode: "HTML",
            },
          );
          if (isClosed()) return;
          const id = state.messageId || result?.message_id;
          if (!Number.isSafeInteger(id) || id <= 0)
            throw new Error("missing_message_id");
          state.messageId = id;
          state.pendingSend = false;
          state.lastText = text;
          state.nextPublishAt = now() + INTERVAL;
          save(state);
        } catch (error) {
          if (
            !state.messageId &&
            Number.isInteger(error?.status) &&
            error.status >= 400 &&
            error.status < 500 &&
            error.status !== 408
          )
            state.pendingSend = false;
          state.nextPublishAt =
            now() + Math.max(INTERVAL, Number(error?.retryAfterMs) || 0);
          save(state);
        }
      } finally {
        running = false;
      }
    },
  };
}
