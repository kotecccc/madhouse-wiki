import { telegramContext } from "./telegram-context.js";

// These keys are retained only so old browser JWTs can be erased on upgrade.
export const TOKEN_KEY = "madhouse.wiki.jwt";
export const TOKEN_OWNER_KEY = "madhouse.wiki.jwt-owner";
const CHANGE_EVENT = "madhouse:auth-change";
let volatileOwner = null;
let volatileServerManaged = false;
let volatileGeneration = 0;
let authRestoreSettled = false;
export const AUTH_RESTORE_SETTLED_EVENT = "madhouse:auth-restore-settled";

function clearLegacyTokens() {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(TOKEN_OWNER_KEY);
  } catch {
    // Storage may be unavailable in an embedded browser.
  }
}

function emptySession() {
  return {
    status: "empty",
    expiresAt: null,
    identity: null,
    activeBossBattle: null,
  };
}

export function hasAuthRestoreSettled() {
  return authRestoreSettled;
}

export function signalAuthRestoreSettled() {
  authRestoreSettled = true;
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(AUTH_RESTORE_SETTLED_EVENT));
}

export function readSession() {
  if (typeof window === "undefined") return emptySession();
  clearLegacyTokens();
  const context = telegramContext();
  if (
    !volatileServerManaged ||
    !context.isTelegram ||
    !context.initData ||
    !context.userId ||
    context.userId !== volatileOwner
  ) {
    if (volatileServerManaged) clearToken();
    return emptySession();
  }
  return {
    status: "ready",
    expiresAt: null,
    identity: `telegram:${volatileOwner}:${volatileGeneration}`,
    serverManaged: true,
    playerLevel: null,
    experience: null,
    activeBossBattle: null,
  };
}

export function saveServerManagedSession(ownerId) {
  const context = telegramContext();
  const owner = String(ownerId ?? "");
  if (
    typeof window === "undefined" ||
    !context.isTelegram ||
    !context.initData ||
    !/^[1-9][0-9]{0,15}$/.test(owner) ||
    context.userId !== owner
  )
    throw new Error("Требуется повторно открыть Wiki через Telegram.");
  clearLegacyTokens();
  volatileOwner = owner;
  volatileServerManaged = true;
  volatileGeneration += 1;
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function clearToken() {
  volatileOwner = null;
  volatileServerManaged = false;
  volatileGeneration += 1;
  clearLegacyTokens();
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(CHANGE_EVENT));
}

export function subscribeSession(listener) {
  const onStorage = (event) => {
    if (
      event.key === TOKEN_KEY ||
      event.key === TOKEN_OWNER_KEY ||
      event.key === null
    ) {
      clearLegacyTokens();
      listener();
    }
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
    throw new Error(
      "Запросы Wiki разрешены только через локальный API-прокси.",
    );
  const session = readSession();
  if (session.status !== "ready" || session.serverManaged !== true)
    throw new Error(
      "Откройте Wiki через Telegram и подключите игровой аккаунт.",
    );
  const context = telegramContext();
  if (
    !context.isTelegram ||
    !context.initData ||
    context.userId !== volatileOwner
  )
    throw new Error("Откройте Wiki заново в Telegram.");
  const headers = { ...request.headers };
  for (const key of Object.keys(headers))
    if (
      ["authorization", "x-madhouse-wiki-init-data"].includes(key.toLowerCase())
    )
      delete headers[key];
  headers["X-Madhouse-Wiki-Init-Data"] = context.initData;
  return { ...request, headers };
}

export function formatExpiry(session) {
  if (session.status === "ready" && session.serverManaged)
    return "Сеанс хранится в Wiki";
  if (session.status === "invalid") return "Сеанс недоступен";
  if (session.status === "unavailable") return "Локальное хранилище недоступно";
  return "Подключите игровой аккаунт через Telegram";
}
