export const TOKEN_KEY = "madhouse.wiki.jwt";
const CHANGE_EVENT = "madhouse:auth-change";

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
  let token;
  try {
    token = window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return { status: "unavailable", expiresAt: null };
  }
  if (!token) return { status: "empty", expiresAt: null };
  try {
    const { status, expiresAt, notBefore } = inspectToken(token, now);
    return { status, expiresAt, notBefore };
  } catch {
    return { status: "invalid", expiresAt: null };
  }
}
export function saveToken(value) {
  const session = inspectToken(value);
  if (session.status === "expired")
    throw new Error("Срок действия этого JWT уже истёк.");
  try {
    window.localStorage.setItem(TOKEN_KEY, session.token);
  } catch {
    throw new Error("Браузер не разрешает локальное сохранение токена.");
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function clearToken() {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    throw new Error("Браузер не разрешает удалить токен.");
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function subscribeSession(listener) {
  const onStorage = (event) => {
    if (event.key === TOKEN_KEY || event.key === null) listener();
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
  const token = window.localStorage.getItem(TOKEN_KEY);
  const inspected = inspectToken(token);
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
  const date = (value) =>
    new Date(value).toLocaleString("ru-RU", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "short",
    });
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
  return `Истекает ${date(session.expiresAt)} · осталось ${remaining}`;
}
