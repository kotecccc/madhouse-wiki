import {
  authorizeRequest,
  readSession,
  subscribeSession,
} from "./auth-session.js";

// One in-memory session cache and one paced GET queue for all account UI data.
// No JWT or personal response is written to the catalogue or local storage.
export function createSessionApi({
  authorize,
  fetcher = fetch,
  now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  interval = 1100,
  ttl = 180000,
}) {
  const entries = new Map();
  const controllers = new Set();
  let generation = 0;
  let identity = null;
  let tail = Promise.resolve();
  let lastStarted = -Infinity;
  function clear() {
    generation++;
    identity = null;
    entries.clear();
    tail = Promise.resolve();
    tail = Promise.resolve();
    for (const controller of controllers) controller.abort();
    controllers.clear();
  }
  function request(method, path, body, { fresh = false, signal } = {}) {
    if (!/^\/api\/[\w/?.=&%+-]+$/.test(path))
      return Promise.reject(new Error("Недопустимый API-запрос"));
    // Validate even a cache hit, so expired/cleared sessions cannot reuse it.
    try {
      const current = authorize({ url: path }).headers.Authorization;
      if (identity !== current) {
        clear();
        identity = current;
      }
    } catch (error) {
      clear();
      return Promise.reject(error);
    }
    const cached = method === "GET" ? entries.get(path) : null;
    if (!fresh && cached && (cached.pending || now() < cached.until))
      return cached.promise;
    const requestGeneration = generation;
    const entry = { pending: true };
    const task = async () => {
      const wait = interval - (now() - lastStarted);
      if (wait > 0) await pause(wait);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (generation !== requestGeneration)
        throw new Error("Сессия изменилась");
      const request = authorize({ url: path });
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 20000);
      lastStarted = now();
      try {
        const options = {
          method,
          headers: {
            ...request.headers,
            ...(body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          cache: "no-store",
          signal: controller.signal,
        };
        let response;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (generation !== requestGeneration || controller.signal.aborted)
            throw new Error("Сессия изменилась");
          lastStarted = now();
          response = await fetcher(request.url, options);
          if (
            method !== "GET" ||
            ![500, 502, 503, 504].includes(response.status) ||
            attempt === 2
          )
            break;
          await response.body?.cancel();
          await pause(Math.max(interval, 1000) * (attempt + 1));
        }
        if (!response.ok) {
          const error = new Error("Не удалось загрузить данные");
          error.status = response.status;
          const retryAfter = response.headers?.get?.("Retry-After");
          if (retryAfter) {
            const delay = /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - now();
            if (Number.isFinite(delay) && delay >= 0)
              error.retryAfterMilliseconds = delay;
          }
          throw error;
        }
        const data = await response.json();
        if (generation !== requestGeneration || controller.signal.aborted)
          throw new Error("Сессия изменилась");
        entry.until = now() + ttl;
        entry.value = data;
        return data;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", forwardAbort);
        controllers.delete(controller);
      }
    };
    entry.promise = tail.then(task);
    tail = entry.promise.catch(() => {});
    if (method === "GET") entries.set(path, entry);
    entry.promise.then(
      () => {
        entry.pending = false;
      },
      () => {
        if (entries.get(path) === entry) entries.delete(path);
      },
    );
    return entry.promise;
  }
  return {
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, body, options) => request("POST", path, body, options),
    peek(path, { allowStale = false } = {}) {
      try {
        if (authorize({ url: path }).headers.Authorization !== identity) {
          clear();
          return null;
        }
      } catch {
        clear();
        return null;
      }
      const entry = entries.get(path);
      return entry && !entry.pending && (allowStale || now() < entry.until)
        ? entry.value
        : null;
    },
    clear,
  };
}
let sessionApi;
export function getSessionJson(path, { signal, fresh = false } = {}) {
  if (!sessionApi) {
    sessionApi = createSessionApi({ authorize: authorizeRequest });
    subscribeSession(() => {
      if (readSession().status !== "ready") sessionApi.clear();
    });
  }
  if (readSession().status !== "ready") {
    sessionApi.clear();
    return Promise.reject(new Error("Требуется вход"));
  }
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  const promise = sessionApi.get(path, { fresh, signal });
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export function postSessionJson(path, body, { signal } = {}) {
  if (!sessionApi) {
    sessionApi = createSessionApi({ authorize: authorizeRequest });
    subscribeSession(() => {
      if (readSession().status !== "ready") sessionApi.clear();
    });
  }
  if (readSession().status !== "ready") {
    sessionApi.clear();
    return Promise.reject(new Error("Требуется вход"));
  }
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  const promise = sessionApi.post(path, body, { signal });
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

// The nickname is already loaded for the account overview; this accessor never
// issues an API request and never exposes an identity from another session.
export function readCachedPlayerIdentity() {
  if (readSession().status !== "ready") return null;
  const profile = sessionApi?.peek("/api/me", { allowStale: true });
  if (!profile) return null;
  const nickname = [profile.nickname, profile.username, profile.firstName].find(
    (value) => typeof value === "string" && value.trim(),
  );
  return nickname
    ? {
        playerId: Number.isSafeInteger(profile.playerId)
          ? profile.playerId
          : null,
        nickname: nickname.trim().slice(0, 80),
      }
    : null;
}
