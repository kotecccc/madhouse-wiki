import bossEmoji from "./global-raids-boss-emoji.json" with { type: "json" };

const DAY = 86400000;
const THREE_MINUTES = 180000;
const TEN_MINUTES = 600000;
const PUBLISH_INTERVAL = 60000;
const HALF_HOUR = 1800000;
const FRESH = 90000;
// Conservative bounds below Telegram's rich-message text and block limits.
const MAX_MESSAGE_LENGTH = 30000;
const MAX_TABLE_ROWS = 450;
// Animated single-dot emoji from the iconemoji1 set.
const STATUS_EMOJI = {
  waiting: ["5819143265412189249", "⚪"],
  active: ["5819095256267755019", "🔵"],
  finished: ["5818665600624365278", "🔴"],
  paused: ["5819028847483423716", "🟡"],
};
const dayOf = (now) => new Date(now + 3 * 3600000).toISOString().slice(0, 10);
const escape = (value) =>
  String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
const escapeAttribute = (value) => escape(value).replaceAll('"', "&quot;");
const positive = (v) => Number.isSafeInteger(v) && v > 0;
const identifier = (v) =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(v);

export function advanceGlobalRaidDay(state, now) {
  const day = dayOf(now);
  if (state.day === day) return state;
  const carry =
    state.day === dayOf(now - DAY)
      ? (state.raids || [])
          .filter((r) => r.active || now - r.lastBattleAt < HALF_HOUR)
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

export function observeGlobalInvitations(
  state,
  playerId,
  raw,
  projected,
  now,
  history = [],
) {
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
  // The TMA history is account-scoped and already validated. Only import
  // histories for leaders with a currently available invitation; a history
  // record alone cannot establish that a raid is active.
  const activeKeys = new Set(
    projected
      .filter(
        (item) =>
          item.available &&
          positive(item.leaderPlayerId) &&
          positive(item.bossId),
      )
      .map((item) => `${item.leaderPlayerId}:${item.bossId}`),
  );
  for (const item of Array.isArray(history) ? history : []) {
    if (
      !identifier(item?.battleId) ||
      !positive(item.leaderPlayerId) ||
      !positive(item.bossId) ||
      !Number.isFinite(item.seenAt) ||
      item.seenAt > now ||
      item.seenAt <= now - 7200000 ||
      !activeKeys.has(`${item.leaderPlayerId}:${item.bossId}`)
    )
      continue;
    const existing = state.observations[item.battleId];
    if (
      existing &&
      (existing.leaderPlayerId !== item.leaderPlayerId ||
        existing.bossId !== item.bossId)
    )
      continue;
    if (existing) {
      existing.firstSeen = Math.min(existing.firstSeen, item.seenAt);
      existing.tmaSeenAt = { ...existing.tmaSeenAt, [source]: item.seenAt };
    } else
      state.observations[item.battleId] = {
        id: item.battleId,
        bossId: item.bossId,
        leaderPlayerId: item.leaderPlayerId,
        firstSeen: item.seenAt,
        lastSeen: item.seenAt,
        sources: {},
        tmaSeenAt: { [source]: item.seenAt },
      };
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
        event.firstSeen >= row.lastBattleAt + HALF_HOUR
      )
        row = null;
      if (
        !row &&
        pending.length &&
        event.firstSeen >= pending.at(-1).lastSeen + HALF_HOUR
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
    const activeEvents = events.filter((e) =>
      Object.values(e.sources || {}).some(
        (s) => s.active && s.expiresAt > now && now - s.checkedAt <= FRESH,
      ),
    );
    const recentCount = events.filter((e) => {
      const observations = Object.values(e.tmaSeenAt || {});
      return (observations.length ? observations : [e.firstSeen]).some(
        (at) => Number.isFinite(at) && at > now - 7200000 && at <= now,
      );
    }).length;
    // TMA displays an active invitation after three observed battles. Match
    // that view even when a longer quiet period split historical series.
    if (activeEvents.length && recentCount >= 3) {
      const active = activeEvents.at(-1);
      if (!row) {
        row = {
          key,
          bossId: active.bossId,
          leaderPlayerId: active.leaderPlayerId,
          count: 0,
          lastBattleAt: active.lastSeen,
          sources: {},
          carried: false,
        };
        rows.push(row);
      }
      row.count = Math.max(row.count, recentCount);
      row.lastBattleAt = Math.max(row.lastBattleAt || 0, active.lastSeen);
      row.lastBattleId = active.id;
      row.leaderName = active.leaderName || row.leaderName;
      row.leaderUsername = active.leaderUsername || row.leaderUsername;
      for (const [id, source] of Object.entries(active.sources || {}))
        row.sources[id] = source;
      row.activeIds = activeEvents.map((e) => e.id);
    } else if (row) row.activeIds = activeEvents.map((e) => e.id);
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

export function formatGlobalRaidPages(
  state,
  now,
  getBoss,
  {
    customEmoji = false,
    continuationUrl = "",
    maxMessageLength = MAX_MESSAGE_LENGTH,
  } = {},
) {
  const marker = (kind) => {
    const [id, fallback] = STATUS_EMOJI[kind];
    return customEmoji ? `<tg-emoji emoji-id="${id}">⏺</tg-emoji>` : fallback;
  };
  const date = state.day.split("-").reverse().join(".");
  const time = new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    hour: "2-digit",
    minute: "2-digit",
  }).format(now);
  const updated = `<h3>🔥 Активные рейды • ${date} • ${time} МСК</h3>`;
  const knownNames = new Map();
  for (const observation of Object.values(state.observations || {})) {
    if (
      !positive(observation.leaderPlayerId) ||
      typeof observation.leaderName !== "string" ||
      !observation.leaderName.trim() ||
      !Number.isFinite(observation.lastSeen)
    )
      continue;
    const previous = knownNames.get(observation.leaderPlayerId);
    if (!previous || observation.lastSeen > previous.at)
      knownNames.set(observation.leaderPlayerId, {
        name: observation.leaderName.trim(),
        at: observation.lastSeen,
      });
  }
  const floorOrder = "ABCDEFGHIJKLMNO$";
  const rows = state.raids
    .filter(
      (row) =>
        row.count >= 10 &&
        (row.active || now - row.lastBattleAt < HALF_HOUR) &&
        (positive(row.leaderPlayerId) ||
          /^[A-Za-z0-9_]{5,32}$/.test(row.leaderUsername || "") ||
          (typeof row.leaderName === "string" && row.leaderName.trim())),
    )
    .map((row) => {
      const boss = getBoss(row.bossId);
      const match = /^dept-([A-O]|\$)(\d+)$/.exec(boss?.departmentId || "");
      return {
        row,
        boss,
        zone: match ? `${match[1]}${match[2]}` : "—",
        floor: match ? floorOrder.indexOf(match[1]) : Infinity,
        department: match ? Number(match[2]) : Infinity,
      };
    })
    .sort(
      (a, b) =>
        a.floor - b.floor ||
        a.department - b.department ||
        b.row.lastBattleAt - a.row.lastBattleAt,
    );
  const tableHeader =
    "<table bordered striped compact><tr><th>Зона</th><th>Босс</th><th>Боев</th><th>Ведущий</th></tr>";
  const rendered = rows.map(({ row, boss, zone, floor, department }, index) => {
    const age = now - row.lastBattleAt;
    const kind =
      row.active || age < THREE_MINUTES
        ? "active"
        : !row.fresh
          ? "unknown"
          : age < TEN_MINUTES
            ? "waiting"
            : "paused";
    const status =
      kind === "active"
        ? marker("active")
        : kind === "unknown"
          ? marker("waiting")
          : kind === "waiting"
            ? marker("waiting")
            : marker("paused");
    const nickname =
      knownNames.get(row.leaderPlayerId)?.name ||
      (typeof row.leaderName === "string" ? row.leaderName.trim() : "");
    const leader = /^[A-Za-z0-9_]{5,32}$/.test(row.leaderUsername || "")
      ? `@${row.leaderUsername}`
      : nickname
        ? nickname.slice(0, 80)
        : "";
    const copyValue = leader || String(row.leaderPlayerId);
    const copyLabel = leader || `ID ${row.leaderPlayerId}`;
    const copyButton = `<tg-button type="copy_text" text="${escapeAttribute(copyValue)}">${escape(copyLabel)}</tg-button>`;
    const emojiId = customEmoji && boss?.name && bossEmoji[boss.name];
    const bossIcon = emojiId
      ? `<tg-emoji emoji-id="${emojiId}">👹</tg-emoji> `
      : "";
    return {
      row,
      floor,
      department,
      index,
      kind,
      named: Boolean(leader),
      line: `<tr><td>${status} ${escape(zone)}</td><td>${bossIcon}${escape(boss?.name || `Босс №${row.bossId}`)}</td><td>${row.count}</td><td>${copyButton}</td></tr>`,
    };
  });
  const compose = (selected) => {
    const hidden = rows.length - selected.length;
    const table = rows.length
      ? `${tableHeader}${selected
          .slice()
          .sort((a, b) => a.index - b.index)
          .map((item) => item.line)
          .join("")}</table>`
      : "<p>Активных рейдов пока нет.</p>";
    return [
      updated,
      table,
      ...(hidden
        ? [
            `<p>${continuationUrl ? `<a href="${escapeAttribute(continuationUrl)}">Ещё рейдов: ${hidden}</a>` : `Ещё рейдов: ${hidden}`}</p>`,
          ]
        : []),
    ].join("\n");
  };
  if (
    rendered.length <= MAX_TABLE_ROWS &&
    compose(rendered).length <= maxMessageLength
  )
    return [compose(rendered)];
  const priority = { active: 2, unknown: 2, waiting: 1, paused: 0 };
  const selected = [];
  const remaining = rendered.slice();
  while (remaining.length) {
    const bosses = new Set(selected.map((item) => item.row.bossId));
    remaining.sort(
      (a, b) =>
        (Number.isFinite(b.floor) ? b.floor : -1) -
          (Number.isFinite(a.floor) ? a.floor : -1) ||
        priority[b.kind] - priority[a.kind] ||
        Number(bosses.has(a.row.bossId)) - Number(bosses.has(b.row.bossId)) ||
        Number(b.named) - Number(a.named) ||
        b.row.count - a.row.count ||
        b.row.lastBattleAt - a.row.lastBattleAt ||
        a.index - b.index,
    );
    const item = remaining.shift();
    if (
      selected.length < MAX_TABLE_ROWS &&
      compose([...selected, item]).length <= maxMessageLength
    )
      selected.push(item);
  }
  const pages = [compose(selected)];
  const chosen = new Set(selected);
  const overflow = rendered.filter((item) => !chosen.has(item));
  const makeContinuation = (items) =>
    `<h3>Остальные рейды • ${date} • ${time} МСК</h3>\n${tableHeader}${items.map((item) => item.line).join("")}</table>`;
  let page = [];
  for (const item of overflow) {
    if (
      page.length &&
      (page.length >= MAX_TABLE_ROWS ||
        makeContinuation([...page, item]).length > maxMessageLength)
    ) {
      pages.push(makeContinuation(page));
      page = [];
    }
    page.push(item);
  }
  if (page.length) pages.push(makeContinuation(page));
  return pages;
}

export function formatGlobalRaidSummary(state, now, getBoss, options) {
  return formatGlobalRaidPages(state, now, getBoss, options)[0];
}

export function createGlobalRaidsWorker({
  store,
  owner,
  now,
  telegram,
  chatId,
  getBoss,
  isClosed,
  customEmoji = false,
  getLeaderProfile,
  maxMessageLength = MAX_MESSAGE_LENGTH,
}) {
  let running = false;
  let nextAttempt = 0;
  let nextProfileAttempt = 0;
  const profileAttempts = new Map();
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
    observe(playerId, raw, projected, history = []) {
      if (isClosed()) return;
      const state = observeGlobalInvitations(
        load(),
        playerId,
        raw,
        projected,
        now(),
        history,
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
        const unresolved = state.raids.find(
          (row) =>
            row.count >= 10 &&
            (row.active || now() - row.lastBattleAt < HALF_HOUR) &&
            !row.leaderName &&
            !row.leaderUsername &&
            now() >= (profileAttempts.get(row.leaderPlayerId) || 0),
        );
        if (unresolved && getLeaderProfile && now() >= nextProfileAttempt) {
          const id = unresolved.leaderPlayerId;
          profileAttempts.set(id, now() + 5 * 60000);
          nextProfileAttempt = now() + 60000;
          try {
            const profile = await getLeaderProfile(id);
            if (
              profile?.playerId === id &&
              typeof profile.nickname === "string" &&
              profile.nickname.trim()
            ) {
              state = load();
              for (const row of state.raids)
                if (row.leaderPlayerId === id)
                  row.leaderName = profile.nickname.trim().slice(0, 80);
              for (const obs of Object.values(state.observations))
                if (obs.leaderPlayerId === id)
                  obs.leaderName = profile.nickname.trim().slice(0, 80);
              save(state);
            }
          } catch (error) {
            nextProfileAttempt = Math.max(
              nextProfileAttempt,
              now() + (Number(error?.retryAfterMs) || 0),
            );
          }
          state = refreshGlobalRaidRows(load(), now());
        }
        if (isClosed() || now() < state.nextPublishAt || state.pendingSend)
          return;
        const continuationId = state.continuations?.[0]?.messageId;
        const channelName = /^@([A-Za-z0-9_]{5,})$/.exec(chatId)?.[1];
        const channelId = /^-100(\d+)$/.exec(chatId)?.[1];
        const continuationUrl =
          continuationId && (channelName || channelId)
            ? `https://t.me/${channelName || `c/${channelId}`}/${continuationId}`
            : "";
        const pages = formatGlobalRaidPages(state, now(), getBoss, {
          customEmoji,
          continuationUrl,
          maxMessageLength,
        });
        const text = pages[0];
        const day = state.day;
        const messageId = state.messageId;
        if (!messageId) {
          state.pendingSend = true;
          save(state);
        }
        try {
          const result = await telegram.request(
            messageId ? "editMessageText" : "sendRichMessage",
            {
              chat_id: chatId,
              ...(messageId ? { message_id: messageId } : {}),
              rich_message: { html: text },
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
          const count = Math.max(
            pages.length - 1,
            state.continuations?.length || 0,
          );
          for (let i = 0; i < count; i++) {
            if (isClosed()) return;
            state = load();
            if (state.day !== day) return;
            state.continuations ||= [];
            const current = state.continuations[i] || {};
            if (current.pendingSend) break;
            const pageText =
              pages[i + 1] || `<p>Остальных рейдов сейчас нет.</p>`;
            if (!current.messageId && !pages[i + 1]) continue;
            if (!current.messageId) {
              state.continuations[i] = { ...current, pendingSend: true };
              save(state);
            }
            try {
              const result = await telegram.request(
                current.messageId ? "editMessageText" : "sendRichMessage",
                {
                  chat_id: chatId,
                  ...(current.messageId
                    ? { message_id: current.messageId }
                    : {}),
                  rich_message: { html: pageText },
                },
              );
              const id = current.messageId || result?.message_id;
              if (!Number.isSafeInteger(id) || id <= 0)
                throw new Error("missing_message_id");
              state = load();
              if (state.day !== day) return;
              state.continuations ||= [];
              if (state.continuations[i]?.messageId !== current.messageId)
                return;
              state.continuations[i] = { messageId: id, pendingSend: false };
              save(state);
            } catch (error) {
              state = load();
              if (state.day !== day) return;
              if (
                !current.messageId &&
                (error?.notDispatched ||
                  error?.knownRejected ||
                  (Number.isInteger(error?.status) &&
                    error.status >= 400 &&
                    error.status < 500 &&
                    error.status !== 408))
              ) {
                state.continuations[i].pendingSend = false;
              }
              state.nextPublishAt =
                now() +
                Math.max(PUBLISH_INTERVAL, Number(error?.retryAfterMs) || 0);
              save(state);
              break;
            }
          }
        } catch (error) {
          state = load();
          if (state.day !== day || state.messageId !== messageId) return;
          if (
            !messageId &&
            (error?.notDispatched ||
              error?.knownRejected ||
              (Number.isInteger(error?.status) &&
                error.status >= 400 &&
                error.status < 500 &&
                error.status !== 408))
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
