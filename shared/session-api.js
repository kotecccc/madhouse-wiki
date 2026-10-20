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
  function get(path) {
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
    const cached = entries.get(path);
    if (cached && (cached.pending || now() < cached.until))
      return cached.promise;
    const requestGeneration = generation;
    const entry = { pending: true };
    const task = async () => {
      const wait = interval - (now() - lastStarted);
      if (wait > 0) await pause(wait);
      if (generation !== requestGeneration)
        throw new Error("Сессия изменилась");
      const request = authorize({ url: path });
      const controller = new AbortController();
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 20000);
      lastStarted = now();
      try {
        const response = await fetcher(request.url, {
          method: "GET",
          headers: request.headers,
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Не удалось загрузить данные");
        const data = await response.json();
        if (generation !== requestGeneration || controller.signal.aborted)
          throw new Error("Сессия изменилась");
        entry.until = now() + ttl;
        return data;
      } finally {
        clearTimeout(timeout);
        controllers.delete(controller);
      }
    };
    entry.promise = tail.then(task);
    tail = entry.promise.catch(() => {});
    entries.set(path, entry);
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
  return { get, clear };
}
let sessionApi;
export function getSessionJson(path, { signal } = {}) {
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
  const promise = sessionApi.get(path);
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
