import { createHash, randomUUID } from "node:crypto";

const DEFAULT_ORIGINS = ["https://cargohustle.online"];
function makeError(message, code = "DIRECT_REQUEST_NOT_DISPATCHED") {
  return Object.assign(new Error(message), { code, notDispatched: true });
}
function retryAfterMs(response, now) {
  const value = response.headers?.get?.("retry-after") ?? response.retryAfter;
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now() + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now(), date) : null;
}

export function createDirectExecutor({
  fetcher = globalThis.fetch,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  gameOrigins = DEFAULT_ORIGINS,
  minGlobalSpacingMs = 300,
  minAccountSpacingMs = 1_100,
  minDeviceSpacingMs = 300,
  maxDirectInFlight = 4,
  agingMs = 1000,
  maxQueueSize = 100,
  maxQueueWaitMs = 20_000,
  canDispatch: defaultCanDispatch = () => true,
  onDiagnostic = () => {},
} = {}) {
  if (
    typeof fetcher !== "function" ||
    !Number.isSafeInteger(maxDirectInFlight) ||
    maxDirectInFlight < 1 ||
    agingMs <= 0
  )
    throw new TypeError("invalid_executor_configuration");
  const origins = new Set(gameOrigins.map((origin) => new URL(origin).origin));
  const queue = [],
    aliases = new Map(),
    activeAccounts = new Map(),
    activeDevices = new Set();
  const accountReadyAt = new Map(),
    accountCooldownUntil = new Map(),
    deviceReadyAt = new Map();
  let globalReadyAt = 0,
    timer = null,
    closed = false,
    dispatched = 0,
    activeDirect = 0,
    dispatchCheckPending = false;
  const events = [];
  const canonical = (id) => {
    while (aliases.has(id)) id = aliases.get(id);
    return id;
  };
  function record(item, outcome, status) {
    const event = {
      id: item.id,
      source: item.source,
      operation: item.operation,
      account: createHash("sha256")
        .update(canonical(item.accountId))
        .digest("hex")
        .slice(0, 12),
      egress: item.transport === "direct" ? "vps-direct" : "bridge-device",
      scope: item.transport === "direct" ? "vps" : "device",
      waitedMs: Math.max(0, (item.sentAt ?? now()) - item.queuedAt),
      delay: item.delayReason || "none",
      attempt: item.attempt,
      outcome,
      ...(status ? { status } : {}),
    };
    events.push(event);
    try {
      onDiagnostic(event);
    } catch {
      /* diagnostics cannot affect traffic */
    }
    if (events.length > 256) events.shift();
  }
  function rejectQueued(item, error) {
    const index = queue.indexOf(item);
    if (index < 0) return;
    queue.splice(index, 1);
    item.cleanup();
    clearTimer(item.deadlineTimer);
    item.releaseCheck?.();
    record(item, error.code || "refused");
    item.reject(error);
    queueMicrotask(pump);
  }
  function eligibility(item, current) {
    const account = canonical(item.accountId);
    if ((activeAccounts.get(account) || 0) > 0) {
      item.delayReason = "account_in_flight";
      return Infinity;
    }
    if (item.transport === "direct" && activeDirect >= maxDirectInFlight) {
      item.delayReason = "vps_in_flight";
      return Infinity;
    }
    if (item.transport === "bridge" && activeDevices.has(item.deviceId)) {
      item.delayReason = "device_in_flight";
      return Infinity;
    }
    const accountAt = Math.max(
      accountReadyAt.get(account) || 0,
      accountCooldownUntil.get(account) || 0,
    );
    const routeAt =
      item.transport === "direct"
        ? globalReadyAt
        : deviceReadyAt.get(item.deviceId) || 0;
    const ready = Math.max(accountAt, routeAt);
    if (ready > current)
      item.delayReason =
        accountAt >= routeAt
          ? "account_interval_or_cooldown"
          : "transport_interval_or_cooldown";
    return ready;
  }
  function pump() {
    if (timer) clearTimer(timer);
    timer = null;
    if (closed || dispatchCheckPending || !queue.length) return;
    const current = now();
    for (const item of [...queue]) {
      if (item.signal?.aborted)
        rejectQueued(
          item,
          makeError("Request cancelled", "DIRECT_REQUEST_CANCELLED"),
        );
      else if (current >= item.deadlineAt)
        rejectQueued(
          item,
          makeError("Request deadline elapsed", "DIRECT_REQUEST_DEADLINE"),
        );
    }
    let candidate = null,
      best = -Infinity,
      nextAt = Infinity;
    for (const item of queue) {
      const eligibleAt = eligibility(item, current);
      if (eligibleAt <= current) {
        const score =
          item.priority + Math.floor((current - item.queuedAt) / agingMs);
        if (score > best) {
          candidate = item;
          best = score;
        }
      } else nextAt = Math.min(nextAt, eligibleAt, item.deadlineAt);
    }
    if (!candidate) {
      if (Number.isFinite(nextAt))
        timer = setTimer(pump, Math.max(0, nextAt - current));
      return;
    }
    dispatchCheckPending = true;
    const cancelled = new Promise((resolve) => {
      candidate.releaseCheck = () => resolve(false);
    });
    Promise.race([
      Promise.resolve().then(() => candidate.canDispatch()),
      cancelled,
    ])
      .then(
        (allowed) => {
          if (!queue.includes(candidate)) return;
          const currentTime = now();
          if (candidate.signal?.aborted)
            return rejectQueued(
              candidate,
              makeError("Request cancelled", "DIRECT_REQUEST_CANCELLED"),
            );
          if (currentTime >= candidate.deadlineAt)
            return rejectQueued(
              candidate,
              makeError("Request deadline elapsed", "DIRECT_REQUEST_DEADLINE"),
            );
          if (allowed !== true)
            return rejectQueued(
              candidate,
              makeError("Dispatch is no longer allowed"),
            );
          if (eligibility(candidate, currentTime) > currentTime) return;
          queue.splice(queue.indexOf(candidate), 1);
          candidate.cleanup();
          clearTimer(candidate.deadlineTimer);
          const account = canonical(candidate.accountId);
          activeAccounts.set(account, (activeAccounts.get(account) || 0) + 1);
          if (candidate.transport === "direct") {
            activeDirect++;
            globalReadyAt = currentTime + minGlobalSpacingMs;
          } else activeDevices.add(candidate.deviceId);
          candidate.sentAt = currentTime;
          dispatched++;
          record(candidate, "started");
          Promise.resolve()
            .then(candidate.execute)
            .then(
              async (response) => {
                if (response?.status === 429) {
                  const until = retryAfterMs(response, now) ?? now() + 1000;
                  if (candidate.cooldownScope === "account")
                    accountCooldownUntil.set(
                      canonical(candidate.accountId),
                      Math.max(
                        accountCooldownUntil.get(
                          canonical(candidate.accountId),
                        ) || 0,
                        until,
                      ),
                    );
                  else if (candidate.transport === "direct")
                    globalReadyAt = Math.max(globalReadyAt, until);
                  else
                    deviceReadyAt.set(
                      candidate.deviceId,
                      Math.max(
                        deviceReadyAt.get(candidate.deviceId) || 0,
                        until,
                      ),
                    );
                }
                // A direct fetch resolves at headers; keep its slot until the response body ends.
                if (
                  candidate.transport === "direct" &&
                  response instanceof Response &&
                  response.body
                )
                  await response.clone().arrayBuffer();
                record(
                  candidate,
                  response?.status === 429 ? "cooldown" : "response",
                  response?.status,
                );
                candidate.resolve(response);
              },
              (error) => {
                candidate.quarantined =
                  candidate.transport === "bridge" && !error?.notDispatched;
                record(
                  candidate,
                  error?.notDispatched ? "not_dispatched" : "uncertain",
                );
                candidate.reject(error);
              },
            )
            .catch((error) => {
              candidate.quarantined =
                candidate.transport === "bridge" && !error?.notDispatched;
              record(candidate, "uncertain");
              candidate.reject(error);
            })
            .finally(() => {
              if (candidate.quarantined) {
                pump();
                return;
              }
              const account = canonical(candidate.accountId);
              const count = (activeAccounts.get(account) || 1) - 1;
              if (count) activeAccounts.set(account, count);
              else activeAccounts.delete(account);
              accountReadyAt.set(
                account,
                Math.max(
                  accountReadyAt.get(account) || 0,
                  now() + minAccountSpacingMs,
                ),
              );
              if (candidate.transport === "direct") activeDirect--;
              else {
                activeDevices.delete(candidate.deviceId);
                deviceReadyAt.set(
                  candidate.deviceId,
                  Math.max(
                    deviceReadyAt.get(candidate.deviceId) || 0,
                    now() + minDeviceSpacingMs,
                  ),
                );
              }
              pump();
            });
        },
        () => {
          if (queue.includes(candidate))
            rejectQueued(candidate, makeError("Dispatch check failed"));
        },
      )
      .finally(() => {
        candidate.releaseCheck = null;
        dispatchCheckPending = false;
        pump();
      });
  }
  function schedule(execute, init, context, transport) {
    if (closed)
      return Promise.reject(
        makeError("Executor is closed", "DIRECT_REQUEST_CLOSED"),
      );
    if (queue.length >= maxQueueSize)
      return Promise.reject(
        makeError("Request queue is full", "DIRECT_REQUEST_QUEUE_FULL"),
      );
    const accountId =
      context.accountId == null ? "default" : String(context.accountId);
    const timeout = Number.isFinite(context.queueTimeoutMs)
      ? Math.max(0, context.queueTimeoutMs)
      : maxQueueWaitMs;
    const deadlineAt = Number.isFinite(context.deadlineAt)
      ? context.deadlineAt
      : now() + timeout;
    return new Promise((resolve, reject) => {
      const source = [
        "connector",
        "proxy",
        "automation",
        "identity",
        "catalogue",
      ].includes(context.source)
        ? context.source
        : "wiki";
      const item = {
        id: randomUUID(),
        execute,
        transport,
        deviceId: context.deviceId,
        accountId,
        resolve,
        reject,
        signal: context.signal ?? init.signal,
        deadlineAt,
        queuedAt: now(),
        source,
        operation: ["GET", "HEAD"].includes(
          String(init.method || "GET").toUpperCase(),
        )
          ? "read"
          : "action",
        priority: source === "automation" ? 2 : source === "catalogue" ? 0 : 1,
        attempt: Number.isSafeInteger(context.attempt) ? context.attempt : 1,
        cooldownScope:
          context.cooldownScope === "account" ? "account" : "global",
        canDispatch:
          context.canDispatch ?? init.canDispatch ?? defaultCanDispatch,
        cleanup: () => item.signal?.removeEventListener("abort", onAbort),
      };
      const onAbort = () =>
        rejectQueued(
          item,
          makeError("Request cancelled", "DIRECT_REQUEST_CANCELLED"),
        );
      if (item.signal?.aborted)
        return reject(
          makeError("Request cancelled", "DIRECT_REQUEST_CANCELLED"),
        );
      item.signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(item);
      record(item, "queued");
      item.deadlineTimer = setTimer(
        () =>
          rejectQueued(
            item,
            makeError("Request deadline elapsed", "DIRECT_REQUEST_DEADLINE"),
          ),
        Math.max(0, deadlineAt - now()),
      );
      pump();
    });
  }
  function request(url, init = {}, context = {}) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.reject(
        makeError("Invalid game URL", "DIRECT_REQUEST_INVALID_URL"),
      );
    }
    if (!origins.has(parsed.origin))
      return Promise.reject(
        makeError("Origin denied", "DIRECT_REQUEST_ORIGIN_DENIED"),
      );
    const fetchInit = { ...init };
    delete fetchInit.canDispatch;
    return schedule(
      () => fetcher(parsed.href, fetchInit),
      init,
      context,
      "direct",
    );
  }
  function bridge(execute, init = {}, context = {}) {
    if (
      typeof execute !== "function" ||
      typeof context.deviceId !== "string" ||
      !context.deviceId
    )
      return Promise.reject(makeError("Invalid bridge request"));
    return schedule(execute, init, context, "bridge");
  }
  function close() {
    closed = true;
    if (timer) clearTimer(timer);
    for (const item of [...queue])
      rejectQueued(item, makeError("Executor is closed"));
  }
  function bindAccount(provisional, verified) {
    if (!provisional || !verified) return;
    provisional = canonical(provisional);
    verified = canonical(verified);
    if (provisional === verified) return;
    aliases.set(provisional, verified);
    for (const map of [accountReadyAt, accountCooldownUntil]) {
      map.set(
        verified,
        Math.max(map.get(verified) || 0, map.get(provisional) || 0),
      );
      map.delete(provisional);
    }
    activeAccounts.set(
      verified,
      (activeAccounts.get(verified) || 0) +
        (activeAccounts.get(provisional) || 0),
    );
    activeAccounts.delete(provisional);
    pump();
  }
  return {
    request,
    bridge,
    close,
    bindAccount,
    diagnostics() {
      return {
        queued: queue.length,
        dispatched,
        activeDirect,
        activeDevices: activeDevices.size,
        accountsCoolingDown: [...accountCooldownUntil].filter(
          ([, until]) => until > now(),
        ).length,
        recent: [...events],
      };
    },
  };
}
