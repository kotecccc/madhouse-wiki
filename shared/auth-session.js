import { telegramContext } from "./telegram-context.js";
import { normalizeActiveBossBattle } from "./active-boss-battle.js";
export const TOKEN_KEY = "madhouse.wiki.jwt";
export const TOKEN_OWNER_KEY = "madhouse.wiki.jwt-owner";
let volatileToken = null;
let volatileOwner = null;
let volatilePlayerLevel = null;
let volatileExperience = null;
let volatileActiveBossBattle = null;
const CHANGE_EVENT = "madhouse:auth-change";
let authRestoreSettled = false;
export const AUTH_RESTORE_SETTLED_EVENT = "madhouse:auth-restore-settled";

export function hasAuthRestoreSettled() {
  return authRestoreSettled;
}

export function signalAuthRestoreSettled() {
  authRestoreSettled = true;
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(AUTH_RESTORE_SETTLED_EVENT));
}

function decodePart(part) {
  const base64 = part.replaceAll("-", "+").replaceAll("_", "/");
  return JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(
        atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")),
        (c) => c.charCodeAt(0),
      ),
    ),
  );
}
export function inspectToken(value, now = Date.now()) {
  const token = String(value ?? "")
    .trim()
    .replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts.some((p) => !p || !/^[A-Za-z0-9_-]+$/.test(p))
  )
    throw new Error("Вставьте JWT из трёх частей, разделённых точками.");
  let header, payload;
  try {
    header = decodePart(parts[0]);
    payload = decodePart(parts[1]);
  } catch {
    throw new Error("Не удалось прочитать JWT. Проверьте токен.");
  }
  if (
    !header?.alg ||
    header.alg === "none" ||
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload)
  )
    throw new Error("Некорректный JWT.");
  for (const claim of ["exp", "nbf"])
    if (
      payload[claim] != null &&
      (typeof payload[claim] !== "number" ||
        !Number.isFinite(payload[claim]) ||
        !Number.isFinite(new Date(payload[claim] * 1000).getTime()))
    )
      throw new Error("Некорректный срок действия JWT.");
  const expiresAt = payload.exp == null ? null : payload.exp * 1000;
  const notBefore = payload.nbf == null ? null : payload.nbf * 1000;
  const status =
    expiresAt !== null && now >= expiresAt
      ? "expired"
      : notBefore !== null && now < notBefore
        ? "pending"
        : "ready";
  return { token, expiresAt, notBefore, status };
}
export function readSession(now = Date.now()) {
  if (typeof window === "undefined")
    return { status: "empty", expiresAt: null };
  const context = telegramContext();
  const expected = context.userId;
  let token, owner;
  if (context.isTelegram) {
    // The server is canonical for Mini App sessions. Never reuse a disk JWT
    // before authenticating the current launch; keep this document's token only.
    token = volatileToken;
    owner = volatileOwner;
    try {
      window.localStorage.removeItem(TOKEN_KEY);
      window.localStorage.removeItem(TOKEN_OWNER_KEY);
    } catch {
      /* denied storage is normal in some WebViews */
    }
  } else {
    try {
      token = window.localStorage.getItem(TOKEN_KEY);
      owner = window.localStorage.getItem(TOKEN_OWNER_KEY);
    } catch {
      token = volatileToken;
      owner = volatileOwner;
    }
  }
  if (
    token &&
    ((owner && !expected) ||
      (expected && owner !== expected) ||
      (context.isTelegram && !expected))
  ) {
    clearToken();
    return { status: "empty", expiresAt: null, activeBossBattle: null };
  }
  if (!token)
    return { status: "empty", expiresAt: null, activeBossBattle: null };
  try {
    const { status, expiresAt, notBefore } = inspectToken(token, now);
    return {
      status,
      expiresAt,
      notBefore,
      playerLevel:
        status === "ready" && token === volatileToken && owner === volatileOwner
          ? volatilePlayerLevel
          : null,
      experience:
        status === "ready" && token === volatileToken && owner === volatileOwner
          ? volatileExperience
          : null,
      activeBossBattle:
        status === "ready" && token === volatileToken && owner === volatileOwner
          ? volatileActiveBossBattle
          : null,
    };
  } catch {
    return { status: "invalid", expiresAt: null, activeBossBattle: null };
  }
}
export function saveToken(
  value,
  { playerLevel, currentExp, expToNextLevel, activeBossBattle } = {},
) {
  const session = inspectToken(value);
  if (session.status === "expired")
    throw new Error("Срок действия этого JWT уже истёк.");
  const owner = telegramContext().userId || null;
  const normalizedLevel =
    Number.isSafeInteger(playerLevel) && playerLevel > 0 ? playerLevel : null;
  const normalizedExperience =
    Number.isSafeInteger(currentExp) &&
    currentExp >= 0 &&
    Number.isSafeInteger(expToNextLevel) &&
    expToNextLevel > 0
      ? { current: currentExp, toNextLevel: expToNextLevel }
      : null;
  const normalizedActiveBossBattle =
    normalizeActiveBossBattle(activeBossBattle);
  if (
    volatileToken === session.token &&
    volatileOwner === owner &&
    volatilePlayerLevel === normalizedLevel &&
    volatileExperience?.current === normalizedExperience?.current &&
    volatileExperience?.toNextLevel === normalizedExperience?.toNextLevel &&
    JSON.stringify(volatileActiveBossBattle) ===
      JSON.stringify(normalizedActiveBossBattle)
  )
    return;
  volatileToken = session.token;
  volatileOwner = owner;
  volatilePlayerLevel = normalizedLevel;
  volatileExperience = normalizedExperience;
  volatileActiveBossBattle = normalizedActiveBossBattle;
  try {
    if (telegramContext().isTelegram) {
      window.localStorage.removeItem(TOKEN_KEY);
      window.localStorage.removeItem(TOKEN_OWNER_KEY);
    } else {
      window.localStorage.setItem(TOKEN_KEY, session.token);
      window.localStorage.removeItem(TOKEN_OWNER_KEY);
    }
  } catch {
    // A WebView with blocked localStorage uses only this document's memory.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function clearToken() {
  volatileToken = null;
  volatileOwner = null;
  volatilePlayerLevel = null;
  volatileExperience = null;
  volatileActiveBossBattle = null;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(TOKEN_OWNER_KEY);
  } catch {
    /* An unavailable store cannot supply the active in-memory token. */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function subscribeSession(listener) {
  const onStorage = (event) => {
    if (
      event.key === TOKEN_KEY ||
      event.key === TOKEN_OWNER_KEY ||
      event.key === null
    )
      listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(CHANGE_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(CHANGE_EVENT, listener);
  };
}
export function authorizeRequest(request, origin = window.location.origin) {
  const url = new URL(request.url, origin);
  if (!url.pathname.startsWith("/api/")) return request;
  if (url.origin !== origin)
    throw new Error("JWT Wiki используется только через локальный API-прокси.");
  const session = readSession();
  if (session.status !== "ready")
    throw new Error(
      session.status === "expired"
        ? "JWT истёк. Обновите его через Login в Wiki."
        : "Добавьте действующий JWT через Login в Wiki.",
    );
  let token = volatileToken;
  if (!telegramContext().isTelegram) {
    try {
      token = window.localStorage.getItem(TOKEN_KEY) || volatileToken;
    } catch {
      /* memory fallback */
    }
  }
  const inspected = inspectToken(token || volatileToken);
  if (inspected.status !== "ready")
    throw new Error(
      "JWT больше не действует. Обновите его через Login в Wiki.",
    );
  const headers = { ...request.headers };
  for (const key of Object.keys(headers))
    if (key.toLowerCase() === "authorization") delete headers[key];
  headers.Authorization = `Bearer ${inspected.token}`;
  return { ...request, headers };
}
export function formatExpiry(session, now = Date.now()) {
  if (session.status === "empty") return "Токен не добавлен";
  if (session.status === "invalid") return "Токен повреждён — замените его";
  if (session.status === "unavailable") return "Локальное хранилище недоступно";
  const date = (value) => {
    const parts = new Intl.DateTimeFormat("ru-RU", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(value));
    const fields = Object.fromEntries(
      parts.map(({ type, value }) => [type, value]),
    );
    return `${fields.hour}:${fields.minute} ${fields.day}.${fields.month}.${fields.year}`;
  };
  if (session.status === "expired") return `Истёк ${date(session.expiresAt)}`;
  if (session.status === "pending")
    return `Начнёт действовать ${date(session.notBefore)}`;
  if (session.expiresAt === null) return "Срок действия в JWT не указан";
  const seconds = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));
  const remaining =
    seconds >= 86400
      ? `${Math.ceil(seconds / 86400)} дн.`
      : seconds >= 3600
        ? `${Math.ceil(seconds / 3600)} ч.`
        : seconds >= 60
          ? `${Math.ceil(seconds / 60)} мин.`
          : `${seconds} сек.`;
  return `Истекает ${date(session.expiresAt)} • Осталось ${remaining}`;
}
