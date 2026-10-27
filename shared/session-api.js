import {
  nextHealthWarningEvidence,
  HEALTH_WARNING_ATTEMPTS,
  hasConfirmedHealthWarning,
} from "./game-health-warning.js";
let healthWarningEvidence = {};
export function readConfirmedGameHealthFeatures() {
  return gameHealth.status === "unavailable"
    ? Object.keys(healthWarningEvidence).filter(
        (feature) =>
          healthWarningEvidence[feature].attempts >= HEALTH_WARNING_ATTEMPTS,
      )
    : [];
}
export function readGameHealthWarning() {
  return hasConfirmedHealthWarning(gameHealth, healthWarningEvidence);
}
import {
  GAME_HEALTH_FEATURES,
  safeFailedFeatures,
  safeSuccessfulFeatures,
} from "./game-health-features.js";
let gameHealth = {
  status: "unknown",
  lastSuccessAt: null,
  failedFeatures: [],
  successfulFeatures: [],
  featureCheckedAt: {},
};
function safeFeatureCheckedAt(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    GAME_HEALTH_FEATURES.flatMap((feature) => {
      const timestamp = Number(value[feature]);
      return Number.isFinite(timestamp) && timestamp > 0
        ? [[feature, timestamp]]
        : [];
    }),
  );
}
export function readGameHealth() {
  return gameHealth;
}
export function reportGameHealth(value) {
  if (
    !value ||
    !["available", "unavailable", "credentials_invalid", "unknown"].includes(
      value.status,
    )
  )
    return;
  const failedFeatures =
    value.status === "unavailable"
      ? safeFailedFeatures(value.failedFeatures)
      : [];
  const next = {
    status: value.status,
    lastSuccessAt: Number(value.lastSuccessAt) || null,
    failedFeatures,
    successfulFeatures: safeSuccessfulFeatures(
      value.successfulFeatures,
      failedFeatures,
    ),
    featureCheckedAt: safeFeatureCheckedAt(value.featureCheckedAt),
    ...(value.featureFailedAt && typeof value.featureFailedAt === "object"
      ? { featureFailedAt: safeFeatureCheckedAt(value.featureFailedAt) }
      : {}),
  };
  healthWarningEvidence = nextHealthWarningEvidence(
    healthWarningEvidence,
    next,
  );
  if (JSON.stringify(next) === JSON.stringify(gameHealth)) return;
  gameHealth = next;
  if (typeof window !== "undefined")
    window.dispatchEvent(
      new CustomEvent("madhouse:game-health", { detail: gameHealth }),
    );
}
export function observeGameResponse(response) {
  const status = response.headers?.get?.("X-Madhouse-Game-Status");
  if (status)
    reportGameHealth({
      status,
      lastSuccessAt: response.headers.get("X-Madhouse-Last-Success"),
      failedFeatures: response.headers
        .get("X-Madhouse-Failed-Features")
        ?.split(","),
      successfulFeatures: response.headers
        .get("X-Madhouse-Successful-Features")
        ?.split(","),
      ...(response.headers.get("X-Madhouse-Feature-Failed-At") != null
        ? {
            featureFailedAt: (() => {
              try {
                return JSON.parse(
                  response.headers.get("X-Madhouse-Feature-Failed-At"),
                );
              } catch {
                return {};
              }
            })(),
          }
        : {}),
      featureCheckedAt: (() => {
        try {
          return JSON.parse(
            response.headers.get("X-Madhouse-Feature-Checked-At") || "{}",
          );
        } catch {
          return {};
        }
      })(),
    });
}

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
  shouldRefresh = () => true,
  failureCooldown = ttl,
}) {
  const entries = new Map();
  const eventDrivenPaths = new Set();
  const pending = new Map();
  const snapshotOnlyPending = new Set();
  const controllers = new Set();
  const listeners = new Set();
  let generation = 0;
  let identity = null;
  let tail = Promise.resolve();
  let lastStarted = -Infinity;
  let refreshing = 0;
  const isSnapshotPath = (path) =>
    /^\/api\/(?:automation\/bosses|me|me\/bag|floors|floors\/[^/?]+\/info|rooms|clothing(?:\/by-category\/[1-9])?|ornaments\/zones\/[^/?]+|(?:weapons|pets|businesses|bosses)\/[^/?]+)$/.test(
      path,
    );
  function publish(event) {
    for (const listener of [...listeners]) {
      try {
        listener(event);
      } catch {
        /* subscribers cannot break requests */
      }
    }
  }
  function setRefreshing(delta) {
    const next = Math.max(0, refreshing + delta);
    if (next === refreshing) return;
    refreshing = next;
    publish({ refreshing: refreshing > 0 });
  }
  function clear() {
    reportGameHealth({ status: "unknown", lastSuccessAt: null });
    generation++;
    identity = null;
    entries.clear();
    eventDrivenPaths.clear();
    pending.clear();
    snapshotOnlyPending.clear();
    tail = Promise.resolve();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    refreshing = 0;
    publish({ cleared: true, refreshing: false });
  }
  function request(
    method,
    path,
    body,
    {
      fresh = false,
      signal,
      background = false,
      snapshotOnly = false,
      serverRefresh = false,
      refreshBoss,
    } = {},
  ) {
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
    if (method === "GET" && pending.has(path)) {
      const active = pending.get(path);
      if (fresh && snapshotOnlyPending.has(path))
        return active
          .catch(() => {})
          .then(() =>
            request(method, path, body, {
              fresh: true,
              signal,
              background,
              snapshotOnly: false,
              serverRefresh,
              refreshBoss,
            }),
          );
      return active;
    }
    if (!fresh && cached && !isSnapshotPath(path) && now() < cached.until)
      return Promise.resolve(cached.value);
    const requestGeneration = generation;
    const entry = cached || {};
    const task = async () => {
      const wait = interval - (now() - lastStarted);
      if (wait > 0) await pause(wait);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (generation !== requestGeneration)
        throw new Error("Сессия изменилась");
      // A queued refresh may reach its turn after the app was backgrounded.
      if (background && !shouldRefresh()) return entry.value;
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
            ...(snapshotOnly ? { "X-Madhouse-Snapshot-Only": "1" } : {}),
            ...(serverRefresh && method === "GET" && isSnapshotPath(path)
              ? {
                  "X-Madhouse-Snapshot-Refresh":
                    serverRefresh === "live" ? "live" : "1",
                }
              : {}),
            ...(path === "/api/automation/bosses" &&
            Number.isSafeInteger(refreshBoss) &&
            refreshBoss > 0
              ? { "X-Madhouse-Refresh-Boss": String(refreshBoss) }
              : {}),
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
          if (generation === requestGeneration && !controller.signal.aborted)
            observeGameResponse(response);
          if (
            response.headers?.get?.("X-Madhouse-Game-Status") ===
              "unavailable" ||
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
          if (path === "/api/automation/commands") {
            const failure = await response.json().catch(() => null);
            if (
              /^(inventory_[a-z_]+|automation_[a-z_]+|weapon_equipment_uncertain|subscription_controls_automation|character_upgrade_uncertain|character_batch_running|work_booster_uncertain|floor_automation_controls_resources|business_upgrade_uncertain)$/.test(
                failure?.inventoryReason || "",
              )
            )
              error.inventoryReason = failure.inventoryReason;
          }
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
        const updatedHeader = response.headers?.get?.(
          "X-Madhouse-Section-Updated",
        );
        const ttlHeader = response.headers?.get?.("X-Madhouse-Snapshot-TTL");
        const sectionUpdated = updatedHeader ? Number(updatedHeader) : NaN;
        const serverTtl = ttlHeader ? Number(ttlHeader) : NaN;
        const effectiveTtl =
          Number.isFinite(serverTtl) && serverTtl >= 0 ? serverTtl : ttl;
        entry.until =
          Number.isFinite(sectionUpdated) && sectionUpdated > 0
            ? sectionUpdated + effectiveTtl
            : now() + effectiveTtl;
        entry.value = data;
        entry.updatedAt =
          Number.isFinite(sectionUpdated) && sectionUpdated > 0
            ? sectionUpdated
            : null;
        entry.lastFailureAt =
          response.headers?.get?.("X-Madhouse-Game-Status") === "unavailable"
            ? now()
            : null;
        if (snapshotOnly && now() >= entry.until)
          entry.revalidateAfterRequest = true;
        publish({ path, data, updatedAt: entry.updatedAt });
        return data;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", forwardAbort);
        controllers.delete(controller);
      }
    };
    const promise = tail.then(task);
    tail = promise.catch(() => {});
    if (method === "GET") {
      if (!cached) entries.set(path, entry);
      pending.set(path, promise);
      if (snapshotOnly) snapshotOnlyPending.add(path);
      if (background) setRefreshing(1);
      promise
        .then(
          () => {},
          () => {
            if (entries.get(path) === entry) {
              if (cached?.value !== undefined) {
                entry.lastFailureAt = now();
              } else entries.delete(path);
            }
          },
        )
        .finally(() => {
          if (pending.get(path) === promise) {
            pending.delete(path);
            snapshotOnlyPending.delete(path);
          }
          if (background && generation === requestGeneration) setRefreshing(-1);
          if (
            entry.revalidateAfterRequest &&
            generation === requestGeneration
          ) {
            entry.revalidateAfterRequest = false;
            refreshPath(path);
          }
        });
    }
    return promise;
  }
  function refreshPath(path) {
    const entry = entries.get(path);
    if (
      eventDrivenPaths.has(path) ||
      !entry?.value ||
      pending.has(path) ||
      !shouldRefresh()
    )
      return;
    if (
      entry.lastFailureAt != null &&
      now() - entry.lastFailureAt < failureCooldown
    )
      return;
    request("GET", path, undefined, { background: true }).catch(() => {});
  }
  function refreshExpired() {
    if (!shouldRefresh()) return;
    for (const [path, entry] of entries) {
      if (
        isSnapshotPath(path) &&
        entry.value !== undefined &&
        now() >= entry.until
      )
        refreshPath(path);
    }
  }
  return {
    get(path, options = {}) {
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
      if (options.revalidate === false) eventDrivenPaths.add(path);
      const cached = entries.get(path);
      if (
        !options.fresh &&
        isSnapshotPath(path) &&
        cached?.value !== undefined
      ) {
        if (now() >= cached.until) refreshPath(path);
        return Promise.resolve(cached.value);
      }
      const promise = request("GET", path, undefined, {
        ...options,
        snapshotOnly: !options.fresh && isSnapshotPath(path) && !cached,
      });
      return promise;
    },
    post: (path, body, options) => request("POST", path, body, options),
    peek(path, { allowStale = false } = {}) {
      try {
        if (authorize({ url: path }).headers.Authorization !== identity) {
          return null;
        }
      } catch {
        return null;
      }
      const entry = entries.get(path);
      return entry &&
        entry.value !== undefined &&
        (allowStale || now() < entry.until)
        ? entry.value
        : null;
    },
    updatedAt(path) {
      return this.peek(path, { allowStale: true }) !== null
        ? (entries.get(path)?.updatedAt ?? null)
        : null;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isRefreshing: () => refreshing > 0,
    refreshExpired,
    clear,
  };
}
let sessionApi;
let refreshLifecycleStarted = false;
function ensureSessionApi() {
  if (sessionApi) return sessionApi;
  sessionApi = createSessionApi({
    authorize: authorizeRequest,
    shouldRefresh: () =>
      typeof document === "undefined" || document.visibilityState === "visible",
  });
  if (typeof window !== "undefined")
    subscribeSession(() => {
      if (readSession().status !== "ready") sessionApi.clear();
    });
  if (!refreshLifecycleStarted && typeof window !== "undefined") {
    refreshLifecycleStarted = true;
    const refresh = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "visible"
      )
        sessionApi?.refreshExpired();
    };
    window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", refresh);
  }
  return sessionApi;
}
export function getSessionJson(
  path,
  {
    signal,
    fresh = false,
    revalidate,
    serverRefresh = false,
    refreshBoss,
  } = {},
) {
  ensureSessionApi();
  if (readSession().status !== "ready") {
    sessionApi.clear();
    return Promise.reject(new Error("Требуется вход"));
  }
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  const promise = sessionApi.get(path, {
    fresh,
    signal,
    revalidate,
    serverRefresh,
    refreshBoss,
  });
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
  ensureSessionApi();
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

// Subscribers receive {path, data} after successful GET responses,
// {refreshing} when background revalidation activity changes, and {cleared:true}
// when the authenticated account changes or the session is cleared.
export function subscribeSessionData(listener) {
  return ensureSessionApi().subscribe(listener);
}
export function readSessionRefreshState() {
  return sessionApi?.isRefreshing() ?? false;
}
export function peekSessionUpdatedAt(path) {
  return ensureSessionApi().updatedAt(path);
}

export function peekSessionJson(path, options) {
  return ensureSessionApi().peek(path, options);
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
