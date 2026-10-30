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
  authorizeStoredRequest,
  authorizeLocalAutomationCommand,
  isLocalAutomationCommand,
  readSession,
  subscribeSession,
} from "./auth-session.js";

// One in-memory session cache for account UI data. Physical game pacing is
// enforced by the server coordinator; independent Wiki reads use bounded slots.
// No JWT or personal response is written to the catalogue or local storage.
export function createSessionApi({
  authorize,
  authorizeStored = authorize,
  authorizeLocalCommand = authorize,
  fetcher = fetch,
  now = Date.now,
  pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  interval = 0,
  ttl = 180000,
  shouldRefresh = () => true,
  failureCooldown = ttl,
}) {
  const entries = new Map();
  const resourceSubscriptions = new Map();
  const pending = new Map();
  const pendingModes = new Map();
  const storedPending = new Map();
  const failedAt = new Map();
  const controllers = new Set();
  const listeners = new Set();
  let generation = 0;
  let identity = null;
  let tail = Promise.resolve();
  let automationCommandTail = Promise.resolve();
  let readLane = { active: 0, waiting: [] };
  const readLimit = interval > 0 ? 1 : 4;
  // Wiki-owned stop commands remain usable when game requests are stalled.
  // They are ordered with each other, but stored reads do not occupy this lane.
  let localCommandTail = Promise.resolve();
  let lastStarted = -Infinity;
  let refreshing = 0;
  let publicationClock = 0;
  let resourceVersions = null;
  let automationVersion = -1;
  const isSnapshotPath = (path) =>
    /^\/api\/(?:automation\/bosses|me|me\/bag|stash\/sets|floors|floors\/[^/?]+\/info|rooms|clothing(?:\/by-category\/[1-9])?|ornaments\/zones\/[^/?]+|(?:weapons|pets|businesses|bosses)\/[^/?]+)$/.test(
      path,
    );
  // `automation/bosses` has its own server contract and is not an account
  // snapshot resource. Keep it out of the strict saved-data reader.
  const isStoredReadPath = (path) =>
    path === "/api/automation/state" ||
    (isSnapshotPath(path) && path !== "/api/automation/bosses");
  function publish(event) {
    if (
      ["/api/automation/state", "/api/automation/commands"].includes(event.path)
    )
      observeResourceVersions(event.data);
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
    pending.clear();
    pendingModes.clear();
    storedPending.clear();
    failedAt.clear();
    resourceVersions = null;
    automationVersion = -1;
    tail = Promise.resolve();
    automationCommandTail = Promise.resolve();
    readLane = { active: 0, waiting: [] };
    localCommandTail = Promise.resolve();
    for (const controller of controllers) controller.abort();
    controllers.clear();
    refreshing = 0;
    publish({ cleared: true, refreshing: false });
  }
  function scheduleRead(task) {
    const lane = readLane;
    return new Promise((resolve, reject) => {
      const start = () => {
        lane.active++;
        Promise.resolve()
          .then(task)
          .then(resolve, reject)
          .finally(() => {
            lane.active--;
            lane.waiting.shift()?.();
          });
      };
      if (lane.active < readLimit) start();
      else lane.waiting.push(start);
    });
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
      storedOnly = false,
      serverRefresh = false,
      afterPending = false,
      refreshBoss,
    } = {},
  ) {
    if (!/^\/api\/[\w/?.=&%+-]+$/.test(path))
      return Promise.reject(new Error("Недопустимый API-запрос"));
    // Validate even a cache hit, so expired/cleared sessions cannot reuse it.
    const localCommand = isLocalAutomationCommand(
      { url: path, method },
      body?.command,
    );
    const queuedCommand =
      method === "POST" && path === "/api/automation/commands";
    try {
      const current = (
        storedOnly
          ? authorizeStored
          : localCommand
            ? (request) => authorizeLocalCommand(request, body.command)
            : authorize
      )({
        url: path,
        method,
        ...(storedOnly ? { storedOnly: true } : {}),
      }).headers.Authorization;
      if (!storedOnly && !localCommand && identity !== current) {
        clear();
        identity = current;
      }
    } catch (error) {
      clear();
      return Promise.reject(error);
    }
    const cached = method === "GET" ? entries.get(path) : null;
    if (!storedOnly && method === "GET" && pending.has(path)) {
      const active = [...pending.get(path)];
      const modes = active.map((promise) => pendingModes.get(promise));
      const separateDisplay =
        snapshotOnly &&
        !afterPending &&
        modes.every((mode) => !mode?.snapshotOnly);
      if (
        !separateDisplay &&
        ((fresh && modes.some((mode) => mode?.snapshotOnly)) ||
          modes.some((mode) => mode?.serverRefresh !== serverRefresh) ||
          modes.some((mode) => mode?.refreshBoss !== refreshBoss) ||
          afterPending)
      ) {
        const waitingGeneration = generation;
        return Promise.allSettled(active).then(() => {
          if (generation !== waitingGeneration)
            throw new Error("Сессия изменилась");
          const current = pending.get(path);
          for (const promise of active) {
            current?.delete(promise);
            pendingModes.delete(promise);
          }
          if (!current?.size) pending.delete(path);
          return request(method, path, body, {
            fresh: true,
            signal,
            background,
            snapshotOnly: false,
            serverRefresh,
            afterPending: true,
            refreshBoss,
          });
        });
      }
      // Strict reads go independently to the server, which can coalesce them
      // using its mutation revision. The browser cannot know whether a worker
      // mutated the account since an older read started.
      if (!separateDisplay && serverRefresh !== "live") return active[0];
    }
    if (
      !storedOnly &&
      !fresh &&
      cached &&
      !isSnapshotPath(path) &&
      now() < cached.until
    )
      return Promise.resolve(cached.value);
    const requestGeneration = generation;
    const startedAtPublication = publicationClock;
    const entry = storedOnly ? {} : cached || {};
    const newerPublished = (observedAt) => {
      const current = entries.get(path);
      if (
        current?.value === undefined ||
        !(
          current.publication > startedAtPublication ||
          (observedAt !== undefined &&
            current.updatedAt != null &&
            (observedAt == null || current.updatedAt > observedAt))
        )
      )
        return null;
      return {
        presence: "present",
        data: current.value,
        updatedAt: current.updatedAt ?? null,
        snapshotStatus: current.snapshotStatus || "current",
        ...(current.snapshotCompleteness
          ? { snapshotCompleteness: current.snapshotCompleteness }
          : {}),
        source: "memory",
        gameStatus: current.gameStatus || "unknown",
      };
    };
    const task = async () => {
      const wait =
        storedOnly || localCommand || queuedCommand
          ? 0
          : interval - (now() - lastStarted);
      if (wait > 0) await pause(wait);
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (generation !== requestGeneration)
        throw new Error("Сессия изменилась");
      // A queued refresh may reach its turn after the app was backgrounded.
      if (background && (!shouldRefresh() || !hasRefreshDemand(path)))
        return entry.value;
      const request = (
        storedOnly
          ? authorizeStored
          : localCommand
            ? (request) => authorizeLocalCommand(request, body.command)
            : authorize
      )({
        url: path,
        method,
        ...(storedOnly ? { storedOnly: true } : {}),
      });
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      controllers.add(controller);
      const timeout = setTimeout(() => controller.abort(), 20000);
      if (!storedOnly && !localCommand && !queuedCommand) lastStarted = now();
      try {
        const options = {
          method,
          headers: {
            ...request.headers,
            ...(storedOnly ? { "X-Madhouse-Stored-Only": "1" } : {}),
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
        const maxAttempts = storedOnly ? 1 : 3;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          if (generation !== requestGeneration || controller.signal.aborted)
            throw new Error("Сессия изменилась");
          if (!storedOnly && !localCommand && !queuedCommand)
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
        if (generation !== requestGeneration || controller.signal.aborted)
          throw new Error("Сессия изменилась");
        if (!response.ok) {
          const storedFailure =
            storedOnly && response.status === 404
              ? await response.json().catch(() => null)
              : null;
          if (storedFailure?.error === "snapshot_unavailable") {
            if (generation !== requestGeneration || controller.signal.aborted)
              throw new Error("Сессия изменилась");
            const newer = newerPublished();
            if (newer) return newer;
            return {
              presence: "unknown",
              data: null,
              updatedAt: null,
              snapshotStatus: "missing",
              source: "stored",
            };
          }
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
        const snapshotStatus = response.headers?.get?.("X-Madhouse-Snapshot");
        const snapshotCompleteness = response.headers?.get?.(
          "X-Madhouse-Snapshot-Completeness",
        );
        if (storedOnly) {
          if (generation !== requestGeneration || controller.signal.aborted)
            throw new Error("Сессия изменилась");
          const updated = Number(
            response.headers?.get?.("X-Madhouse-Section-Updated"),
          );
          const updatedAt =
            Number.isFinite(updated) && updated > 0 ? updated : null;
          const newer = newerPublished(updatedAt);
          if (newer) return newer;
          const current = entries.get(path);
          if (isSnapshotPath(path)) {
            const ttlHeader = response.headers?.get?.(
              "X-Madhouse-Snapshot-TTL",
            );
            const serverTtl = ttlHeader == null ? NaN : Number(ttlHeader);
            const effectiveTtl =
              Number.isFinite(serverTtl) && serverTtl >= 0 ? serverTtl : ttl;
            const saved = current || {};
            Object.assign(saved, {
              value: data,
              updatedAt,
              until:
                snapshotStatus === "stale" && snapshotCompleteness !== "unknown"
                  ? now()
                  : updatedAt
                    ? updatedAt + effectiveTtl
                    : now() + effectiveTtl,
              snapshotStatus,
              snapshotCompleteness,
              gameStatus:
                response.headers?.get?.("X-Madhouse-Game-Status") || "unknown",
              publication: ++publicationClock,
            });
            entries.set(path, saved);
          }
          publish({
            path,
            data,
            updatedAt,
            snapshotStatus,
            ...(snapshotCompleteness ? { snapshotCompleteness } : {}),
            storedOnly: true,
          });
          return {
            presence: "present",
            data,
            updatedAt,
            snapshotStatus: snapshotStatus || "current",
            ...(snapshotCompleteness ? { snapshotCompleteness } : {}),
            source: "stored",
            gameStatus:
              response.headers?.get?.("X-Madhouse-Game-Status") || "unknown",
          };
        }
        if (serverRefresh === "live" && snapshotStatus === "stale") {
          throw new Error("Актуальные данные профиля недоступны");
        }
        if (generation !== requestGeneration || controller.signal.aborted)
          throw new Error("Сессия изменилась");
        const updatedHeader = response.headers?.get?.(
          "X-Madhouse-Section-Updated",
        );
        const ttlHeader = response.headers?.get?.("X-Madhouse-Snapshot-TTL");
        const sectionUpdated = updatedHeader ? Number(updatedHeader) : NaN;
        const serverTtl = ttlHeader ? Number(ttlHeader) : NaN;
        if (
          entry.value !== undefined &&
          entry.updatedAt != null &&
          Number.isFinite(sectionUpdated) &&
          sectionUpdated > 0 &&
          sectionUpdated < entry.updatedAt
        )
          return entry.value;
        const effectiveTtl =
          Number.isFinite(serverTtl) && serverTtl >= 0 ? serverTtl : ttl;
        entry.until =
          snapshotStatus === "stale" && snapshotCompleteness !== "unknown"
            ? now()
            : Number.isFinite(sectionUpdated) && sectionUpdated > 0
              ? sectionUpdated + effectiveTtl
              : now() + effectiveTtl;
        entry.value = data;
        entry.updatedAt =
          Number.isFinite(sectionUpdated) && sectionUpdated > 0
            ? sectionUpdated
            : null;
        entry.snapshotStatus = snapshotStatus;
        entry.snapshotCompleteness = snapshotCompleteness;
        entry.gameStatus =
          response.headers?.get?.("X-Madhouse-Game-Status") || "unknown";
        entry.publication = ++publicationClock;
        entry.lastFailureAt =
          response.headers?.get?.("X-Madhouse-Game-Status") === "unavailable"
            ? now()
            : null;
        if (snapshotOnly && now() >= entry.until)
          entry.revalidateAfterRequest = true;
        publish({
          path,
          data,
          updatedAt: entry.updatedAt,
          snapshotStatus,
          ...(snapshotCompleteness ? { snapshotCompleteness } : {}),
          liveRefresh: serverRefresh === "live",
          snapshotOnly,
        });
        return data;
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", forwardAbort);
        controllers.delete(controller);
      }
    };
    const promise = storedOnly
      ? Promise.resolve().then(task)
      : localCommand
        ? localCommandTail.then(task)
        : queuedCommand
          ? automationCommandTail.then(task)
          : method === "GET"
            ? scheduleRead(task)
            : tail.then(task);
    if (localCommand) localCommandTail = promise.catch(() => {});
    else if (queuedCommand) automationCommandTail = promise.catch(() => {});
    else if (!storedOnly && method !== "GET") tail = promise.catch(() => {});
    if (method === "GET" && !storedOnly) {
      if (!cached) entries.set(path, entry);
      let group = pending.get(path);
      if (!group) pending.set(path, (group = new Set()));
      group.add(promise);
      pendingModes.set(promise, { serverRefresh, refreshBoss, snapshotOnly });
      if (background) setRefreshing(1);
      promise
        .then(
          () => {
            failedAt.delete(path);
          },
          (error) => {
            if (!snapshotOnly || error?.status !== 404)
              failedAt.set(path, now());
            if (entries.get(path) === entry) {
              if (cached?.value !== undefined) {
                entry.lastFailureAt = now();
              } else if ((pending.get(path)?.size ?? 0) <= 1)
                entries.delete(path);
            }
            if (snapshotOnly && error?.status === 404)
              entry.revalidateAfterRequest = true;
          },
        )
        .finally(() => {
          const group = pending.get(path);
          group?.delete(promise);
          pendingModes.delete(promise);
          if (!group?.size) pending.delete(path);
          if (background && generation === requestGeneration) setRefreshing(-1);
          if (
            entry.revalidateAfterRequest &&
            generation === requestGeneration &&
            !pending.has(path)
          ) {
            entry.revalidateAfterRequest = false;
            const force = entry.forceRevalidateAfterRequest;
            entry.forceRevalidateAfterRequest = false;
            if (force || entry.value === undefined || now() >= entry.until)
              refreshPath(path);
          }
        });
    }
    return promise;
  }
  function hasRefreshDemand(path) {
    return [...(resourceSubscriptions.get(path) || [])].some(
      (subscription) => subscription.revalidate,
    );
  }
  function observeResourceVersions(data) {
    const next = data?.resourceVersions;
    if (
      !next ||
      !Array.isArray(data.queuedActions) ||
      !Number.isSafeInteger(next.revision) ||
      next.revision < 0 ||
      !next.sections ||
      typeof next.sections !== "object" ||
      Array.isArray(next.sections)
    )
      return;
    const version = Number.isSafeInteger(data.version) ? data.version : -1;
    if (
      version < automationVersion ||
      (resourceVersions && next.revision < resourceVersions.revision)
    )
      return;
    automationVersion = Math.max(automationVersion, version);
    const previous = resourceVersions;
    const sections = {};
    for (const [path, value] of Object.entries(next.sections)) {
      if (
        !isSnapshotPath(path) ||
        path === "/api/automation/bosses" ||
        !value ||
        !Number.isSafeInteger(value.revision) ||
        value.revision < 0 ||
        typeof value.dirty !== "boolean" ||
        !(
          value.updatedAt === null ||
          (Number.isFinite(value.updatedAt) && value.updatedAt > 0)
        )
      )
        continue;
      const old = previous?.sections[path];
      if (old && (value.updatedAt ?? 0) < (old.updatedAt ?? 0)) {
        sections[path] = old;
        continue;
      }
      if (
        old &&
        value.updatedAt === old.updatedAt &&
        value.revision < old.revision
      ) {
        sections[path] = old;
        continue;
      }
      sections[path] = value;
    }
    resourceVersions = { revision: next.revision, sections };
    const requestGeneration = generation;
    for (const [path, subscriptions] of resourceSubscriptions) {
      if (
        !subscriptions.size ||
        !isSnapshotPath(path) ||
        path === "/api/automation/bosses"
      )
        continue;
      const before = previous?.sections[path];
      const after = sections[path];
      if (!previous && !after?.dirty) continue;
      if (
        JSON.stringify(before) === JSON.stringify(after) &&
        (after || previous?.revision === next.revision)
      )
        continue;
      const cached = entries.get(path);
      if (after?.dirty || !after) {
        if (cached) {
          cached.until = 0;
          if (pending.has(path)) {
            cached.revalidateAfterRequest = true;
            cached.forceRevalidateAfterRequest = true;
          }
        }
      }
      // The worker may have already saved the observation; read it locally
      // before deciding whether any demanded refresh is still necessary.
      request("GET", path, undefined, { storedOnly: true, fresh: true })
        .then((saved) => {
          if (generation !== requestGeneration || !hasRefreshDemand(path))
            return;
          if (
            JSON.stringify(resourceVersions?.sections[path]) !==
            JSON.stringify(after)
          )
            return;
          const entry = entries.get(path);
          if (after?.dirty && entry) entry.until = 0;
          if (
            after?.dirty ||
            !after ||
            (saved.snapshotStatus === "stale" && now() >= (entry?.until ?? 0))
          ) {
            if (entries.get(path)?.value !== undefined) refreshPath(path);
            else if (!pending.has(path) && shouldRefresh())
              request("GET", path, undefined, {
                fresh: true,
                background: true,
              }).catch(() => {});
          }
        })
        .catch(() => {});
    }
  }
  function refreshPath(path) {
    const entry = entries.get(path);
    if (!hasRefreshDemand(path) || pending.has(path) || !shouldRefresh())
      return;
    if (
      entry?.lastFailureAt != null &&
      now() - entry.lastFailureAt < failureCooldown
    )
      return;
    if (failedAt.has(path) && now() - failedAt.get(path) < failureCooldown)
      return;
    request("GET", path, undefined, { background: true }).catch(() => {});
  }
  function refreshExpired() {
    if (!shouldRefresh()) return;
    for (const path of resourceSubscriptions.keys()) {
      const entry = entries.get(path);
      if (
        isSnapshotPath(path) &&
        (entry?.value === undefined || now() >= entry.until)
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
      const cached = entries.get(path);
      if (
        !options.fresh &&
        isSnapshotPath(path) &&
        cached?.value !== undefined
      ) {
        if (options.revalidate !== false && now() >= cached.until)
          refreshPath(path);
        return Promise.resolve(cached.value);
      }
      const promise = request("GET", path, undefined, {
        ...options,
        // Snapshot reads can be shared even when freshness is requested. A
        // caller's cancellation must not abort the other consumers' transport.
        // getSessionJson cancels that caller's wait independently.
        ...(isSnapshotPath(path) ? { signal: undefined } : {}),
        snapshotOnly:
          !options.fresh && isSnapshotPath(path) && cached?.value === undefined,
      });
      return promise;
    },
    readStored(path, options = {}) {
      if (!/^\/api\/[\w/?.=&%+-]+$/.test(path) || !isStoredReadPath(path))
        return Promise.reject(new Error("Недопустимый сохранённый ресурс"));
      let credential;
      try {
        credential = authorizeStored({
          url: path,
          method: "GET",
          storedOnly: true,
        }).headers.Authorization;
      } catch (error) {
        clear();
        return Promise.reject(error);
      }
      const key = JSON.stringify([generation, path, credential]);
      if (storedPending.has(key)) return storedPending.get(key);
      const promise = request("GET", path, undefined, {
        ...options,
        signal: undefined,
        fresh: true,
        storedOnly: true,
        snapshotOnly: false,
        serverRefresh: false,
        background: false,
      });
      storedPending.set(key, promise);
      const release = () => {
        if (storedPending.get(key) === promise) storedPending.delete(key);
      };
      promise.then(release, release);
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
    subscribe(listener, { resources = [], revalidate = true } = {}) {
      listeners.add(listener);
      const subscription = { revalidate: revalidate !== false };
      const paths = [...new Set(resources)].filter(isSnapshotPath);
      for (const path of paths) {
        let subscriptions = resourceSubscriptions.get(path);
        if (!subscriptions)
          resourceSubscriptions.set(path, (subscriptions = new Set()));
        subscriptions.add(subscription);
      }
      return () => {
        listeners.delete(listener);
        for (const path of paths) {
          const subscriptions = resourceSubscriptions.get(path);
          subscriptions?.delete(subscription);
          if (!subscriptions?.size) resourceSubscriptions.delete(path);
        }
      };
    },
    publishResponse(
      path,
      data,
      {
        updatedAt = null,
        snapshotStatus = null,
        snapshotCompleteness = null,
      } = {},
    ) {
      if (isSnapshotPath(path)) {
        // A snapshot publication without its observation time cannot be
        // ordered against in-flight reads and must not replace personal data.
        if (!Number.isFinite(updatedAt) || updatedAt <= 0) return;
        let current;
        try {
          current = authorize({ url: path }).headers.Authorization;
        } catch {
          clear();
          return;
        }
        if (identity !== current) {
          clear();
          identity = current;
        }
        const entry = entries.get(path) || {};
        if (entry.updatedAt != null && entry.updatedAt > updatedAt) return;
        Object.assign(entry, {
          value: data,
          updatedAt,
          until: snapshotStatus === "stale" ? now() : updatedAt + ttl,
          snapshotStatus,
          snapshotCompleteness,
          publication: ++publicationClock,
        });
        entries.set(path, entry);
      }
      publish({
        path,
        data,
        updatedAt,
        ...(snapshotStatus ? { snapshotStatus } : {}),
        ...(snapshotCompleteness ? { snapshotCompleteness } : {}),
      });
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
    authorizeStored: authorizeStoredRequest,
    authorizeLocalCommand: authorizeLocalAutomationCommand,
    shouldRefresh: () =>
      readSession().status === "ready" &&
      (typeof document === "undefined" ||
        document.visibilityState === "visible"),
  });
  if (typeof window !== "undefined") subscribeSession(() => sessionApi.clear());
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
    window.addEventListener("online", refresh);
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
    afterPending = false,
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
    afterPending,
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
// Strict display bootstrap read. Missing snapshots are explicit, while an
// empty saved resource remains a present payload (for example data: []).
export function readStoredSessionJson(path, { signal } = {}) {
  ensureSessionApi();
  const session = readSession();
  if (session.status !== "ready" && !session.wikiSessionReady) {
    sessionApi.clear();
    return Promise.reject(new Error("Требуется вход"));
  }
  if (signal?.aborted)
    return Promise.reject(new DOMException("Aborted", "AbortError"));
  const promise = sessionApi.readStored(path, { signal });
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
  const session = readSession();
  const localCommand = isLocalAutomationCommand(
    { url: path, method: "POST" },
    body?.command,
  );
  if (
    session.status !== "ready" &&
    !(localCommand && session.wikiSessionReady)
  ) {
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

// Subscribers receive {path, data} after successful session API responses,
// {refreshing} when background revalidation activity changes, and {cleared:true}
// when the authenticated account changes or the session is cleared.
export function subscribeSessionData(listener, options) {
  return ensureSessionApi().subscribe(listener, options);
}
export function publishSessionData(
  path,
  data,
  expectedAuthorization,
  metadata,
) {
  if (typeof path !== "string" || !path.startsWith("/api/")) return;
  try {
    if (
      !expectedAuthorization ||
      (path === "/api/automation/state"
        ? authorizeStoredRequest({ url: path, method: "GET" })
        : authorizeRequest({ url: path })
      ).headers.Authorization !== expectedAuthorization
    )
      return;
  } catch {
    return;
  }
  ensureSessionApi().publishResponse(path, data, metadata);
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
