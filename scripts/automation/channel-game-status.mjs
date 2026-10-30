// Only allowlisted game paths are classified. Never persist paths or IDs.
export const STATUS_SECTIONS = Object.freeze([
  ["authorization", "Авторизация"],
  ["floors", "Этажи"],
  ["bosses", "Боссы"],
  ["works", "Работа"],
  ["businesses", "Бизнес"],
  ["pvp", "PvP"],
  ["clothing", "Гардероб"],
  ["weapons", "Оружие"],
  ["pets", "Питомцы"],
  ["rooms", "Комнаты"],
  ["ornaments", "Татуировки"],
  ["mutagens", "Мутагены"],
]);

export function statusSectionForPath(path) {
  if (typeof path !== "string") return null;
  if (path === "/api/me" || path.startsWith("/api/auth/"))
    return "authorization";
  if (path === "/api/combat" || path.startsWith("/api/combat/")) return "pvp";
  if (path === "/api/clothing/by-category/1") return "weapons";
  if (path === "/api/clothing/by-category/9") return "pets";
  for (const key of [
    "floors",
    "bosses",
    "works",
    "businesses",
    "pvp",
    "clothing",
    "weapons",
    "pets",
    "rooms",
    "ornaments",
    "mutagens",
  ]) {
    if (path === `/api/${key}` || path.startsWith(`/api/${key}/`)) return key;
  }
  return null;
}

// Fixed route words identify related operations without keeping account or entity IDs.
const ROUTE_WORDS = new Set([
  "me",
  "auth",
  "telegram",
  "floors",
  "info",
  "bosses",
  "battles",
  "attack",
  "invitations",
  "works",
  "open",
  "tasks",
  "perform",
  "businesses",
  "upgrade",
  "combat",
  "clothing",
  "by-category",
  "weapons",
  "pets",
  "rooms",
  "ornaments",
  "zones",
  "sets",
  "elements",
  "equip",
  "mutagens",
  "exchange",
  "state",
  "buy",
  "select",
  "repair",
  "pvp",
]);
export function statusRouteGroup(path) {
  return path
    .split("/")
    .slice(2, 8)
    .map((part) => (ROUTE_WORDS.has(part) ? part.replaceAll("-", "_") : "item"))
    .join("_");
}

const WINDOW = 120_000;
const SPACING = 15_000;
export const STATUS_FRESH_MS = 600_000;

// Call once per physical response, never for cached or synthesized responses.
// routeGroup is a fixed allowlisted category, not a raw path or identifier.
export function observeChannelStatus(section, { status, at, routeGroup }) {
  const prior = section ?? {};
  if (
    !Number.isSafeInteger(at) ||
    at <= 0 ||
    typeof routeGroup !== "string" ||
    !/^[a-z_]{1,100}$/.test(routeGroup) ||
    (status !== 500 && !(status >= 200 && status < 300))
  )
    return prior;
  if (prior.lastAt && at <= prior.lastAt) return prior;
  const kind = status === 500 ? "failure" : "success";
  if (
    kind === "success" &&
    prior.confirmed === "failure" &&
    prior.failureGroups?.length &&
    !prior.failureGroups.includes(routeGroup)
  )
    return prior;
  const observations = (prior[kind] || []).filter(
    (item) => item.at <= at && at - item.at <= WINDOW,
  );
  // Ignore bursts while retaining independent recovery evidence for each route.
  const sameGroup =
    kind === "failure"
      ? observations
      : observations.filter((item) => item.routeGroup === routeGroup);
  if (sameGroup.length && at - sameGroup.at(-1).at < SPACING) return prior;
  const next = { ...prior, lastAt: at };
  observations.push({ at, routeGroup });
  next[kind] = observations.slice(-24);
  if (kind === "failure") next.success = [];
  if (
    kind === "failure" &&
    observations.length >= 3 &&
    observations.at(-1).at - observations.at(-2).at >= SPACING &&
    observations.at(-2).at - observations.at(-3).at >= SPACING
  ) {
    next.confirmed = "failure";
    next.failureGroups = [
      ...new Set([
        ...(prior.confirmed === "failure" ? prior.failureGroups || [] : []),
        ...observations.slice(-3).map((item) => item.routeGroup),
      ]),
    ].slice(-12);
  }
  if (kind === "success") {
    const groups =
      prior.confirmed === "failure" ? prior.failureGroups || [] : [];
    const recovered = groups.length
      ? groups.every(
          (group) =>
            observations.filter((item) => item.routeGroup === group).length >=
            2,
        )
      : observations.length >= 2 &&
        observations.at(-1).at - observations.at(-2).at >= SPACING;
    if (recovered) {
      next.confirmed = "success";
      next.failure = [];
      delete next.failureGroups;
    }
  }
  if (next.confirmed === kind) next.confirmedAt = at;
  return next;
}

export function channelStatusAt(section, now) {
  if (
    !section?.confirmedAt ||
    now < section.confirmedAt ||
    now - section.confirmedAt > STATUS_FRESH_MS
  )
    return "unknown";
  return section.confirmed || "unknown";
}

const EDIT_INTERVAL = 120_000;
const RETRY_INTERVAL = 60_000;
const RED_ID = "5818665600624365278";
const WHITE_ID = "5819143265412189249";

// Verified against the iconemoji1 custom-emoji set.
const GREEN_ID = "5818812952362356039";

export function formatChannelGameStatus(state, now) {
  const markers = {
    failure: [RED_ID, "⏺"],
    unknown: [WHITE_ID, "⏺"],
    success: [GREEN_ID, "🟢"],
  };
  const rows = STATUS_SECTIONS.map(([key, title]) => {
    const [id, emoji] = markers[channelStatusAt(state.sections?.[key], now)];
    return `<tr><td>${title}</td><td><tg-emoji emoji-id="${id}">${emoji}</tg-emoji></td></tr>`;
  });
  return `<h5>Состояние игры</h5><table bordered striped compact><tr><th>Раздел</th><th>Статус</th></tr>${rows.join("")}</table>`;
}

export function createChannelGameStatusWorker({
  store,
  owner,
  now,
  telegram,
  chatId,
  isClosed = () => false,
}) {
  let running = false;
  const load = () => store.readChannelGameStatus() || { sections: {} };
  const save = (state) => store.writeChannelGameStatus(state, owner, now());
  return {
    observe(path, status) {
      const section = statusSectionForPath(path);
      if (!section || (status !== 500 && !(status >= 200 && status < 300)))
        return;
      const state = load();
      const before = state.sections?.[section];
      const after = observeChannelStatus(before, {
        status,
        at: now(),
        routeGroup: statusRouteGroup(path),
      });
      if (before === after) return;
      state.sections ||= {};
      state.sections[section] = after;
      save(state);
    },
    async tick() {
      if (running || isClosed()) return;
      running = true;
      try {
        let state = load();
        if (state.pendingSend || now() < (state.nextAttemptAt || 0)) return;
        const text = formatChannelGameStatus(state, now());
        if (
          state.messageId &&
          (state.lastText === text || now() < (state.nextEditAt || 0))
        )
          return;
        const messageId = state.messageId || null;
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
          if ((state.messageId || null) !== messageId) return;
          state.messageId = id;
          state.pendingSend = false;
          state.lastText = text;
          state.nextEditAt = now() + EDIT_INTERVAL;
          state.nextAttemptAt = 0;
          save(state);
        } catch (error) {
          if (isClosed()) return;
          state = load();
          if ((state.messageId || null) !== messageId) return;
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
          state.nextAttemptAt =
            now() + Math.max(RETRY_INTERVAL, Number(error?.retryAfterMs) || 0);
          save(state);
        }
      } finally {
        running = false;
      }
    },
  };
}

// Both publishers use the same MTProto session; never open two clients at once.
export function createChannelPublicationTick({
  raids,
  status,
  isClosed = () => false,
}) {
  let running = false;
  return async () => {
    if (running || isClosed()) return;
    running = true;
    try {
      try {
        await raids?.tick();
      } catch {
        /* each publisher retries its own work */
      }
      if (!isClosed()) {
        try {
          await status?.tick();
        } catch {
          /* each publisher retries its own work */
        }
      }
    } finally {
      running = false;
    }
  };
}
