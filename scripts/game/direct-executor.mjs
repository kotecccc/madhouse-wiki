const DEFAULT_ORIGINS = ["https://cargohustle.online"];
import { createHash } from "node:crypto";

function makeError(message, code = "DIRECT_REQUEST_NOT_DISPATCHED") {
  const error = new Error(message);
  error.code = code;
  error.notDispatched = true;
  return error;
}

function retryAfterMs(response, now) {
  const value = response.headers?.get?.("retry-after");
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return now() + seconds * 1000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(now(), date) : null;
}

export function createDirectExecutor({
  fetcher = globalThis.fetch,
  now = Date.now,
  gameOrigins = DEFAULT_ORIGINS,
  minGlobalSpacingMs = 300,
  minAccountSpacingMs = 1_100,
  maxQueueSize = 100,
  maxQueueWaitMs = 20_000,
  canDispatch: defaultCanDispatch = () => true,
  onDiagnostic = () => {},
} = {}) {
  if (typeof fetcher !== "function")
    throw new TypeError("fetcher must be a function");
  const origins = new Set(gameOrigins.map((origin) => new URL(origin).origin));
  const queue = [];
  const accountReadyAt = new Map();
  const accountCooldownUntil = new Map();
  let globalReadyAt = 0;
  let timer = null;
  let closed = false;
  let dispatched = 0;
  let dispatchCheckPending = false;
  const events = [];
  function record(item, outcome, status) {
    const event = {
      source: item.source,
      account: createHash("sha256")
        .update(item.accountId)
        .digest("hex")
        .slice(0, 12),
      egress: "vps-direct",
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
      // Diagnostics cannot affect a game request.
    }
    if (events.length > 256) events.shift();
  }

  function rejectQueued(item, error) {
    const index = queue.indexOf(item);
    if (index >= 0) queue.splice(index, 1);
    item.cleanup();
    clearTimeout(item.deadlineTimer);
    item.releaseCheck?.();
    record(item, error.code || "refused");
    item.reject(error);
  }

  function pump() {
    if (timer) clearTimeout(timer);
    timer = null;
    if (closed || dispatchCheckPending || queue.length === 0) return;
    const current = now();
    // Expire and cancel queued requests independently, then pick the first eligible account.
    for (const item of [...queue]) {
      if (item.signal?.aborted)
        rejectQueued(
          item,
          makeError(
            "Request was cancelled before dispatch",
            "DIRECT_REQUEST_CANCELLED",
          ),
        );
      else if (current >= item.deadlineAt)
        rejectQueued(
          item,
          makeError(
            "Request deadline elapsed before dispatch",
            "DIRECT_REQUEST_DEADLINE",
          ),
        );
    }
    if (queue.length === 0) return;

    let candidate;
    let nextAt = Infinity;
    for (const item of queue) {
      const eligibleAt = Math.max(
        globalReadyAt,
        accountReadyAt.get(item.accountId) ?? 0,
        accountCooldownUntil.get(item.accountId) ?? 0,
      );
      if (eligibleAt > current) {
        item.delayReason =
          (accountCooldownUntil.get(item.accountId) ?? 0) > current
            ? "account_cooldown"
            : (accountReadyAt.get(item.accountId) ?? 0) > current
              ? "account_interval"
              : "vps_interval_or_cooldown";
      }
      if (eligibleAt <= current) {
        candidate = item;
        break;
      }
      nextAt = Math.min(nextAt, eligibleAt, item.deadlineAt);
    }
    if (!candidate) {
      timer = setTimeout(pump, Math.max(0, nextAt - current));
      return;
    }

    dispatchCheckPending = true;
    const cancelledCheck = new Promise((resolve) => {
      candidate.releaseCheck = () => resolve(false);
    });
    Promise.race([
      Promise.resolve().then(() => candidate.canDispatch()),
      cancelledCheck,
    ])
      .then(
        (allowed) => {
          if (!queue.includes(candidate)) return;
          const currentTime = now();
          if (candidate.signal?.aborted) {
            rejectQueued(
              candidate,
              makeError(
                "Request was cancelled before dispatch",
                "DIRECT_REQUEST_CANCELLED",
              ),
            );
            return;
          }
          if (currentTime >= candidate.deadlineAt) {
            rejectQueued(
              candidate,
              makeError(
                "Request deadline elapsed before dispatch",
                "DIRECT_REQUEST_DEADLINE",
              ),
            );
            return;
          }
          if (allowed === false) {
            rejectQueued(candidate, makeError("Dispatch is no longer allowed"));
            return;
          }
          const readyAt = Math.max(
            globalReadyAt,
            accountReadyAt.get(candidate.accountId) ?? 0,
            accountCooldownUntil.get(candidate.accountId) ?? 0,
          );
          if (readyAt > currentTime) return;
          queue.splice(queue.indexOf(candidate), 1);
          candidate.cleanup();
          clearTimeout(candidate.deadlineTimer);
          // Stamp spacing immediately before physical fetch; no retry is performed.
          const sentAt = now();
          candidate.sentAt = sentAt;
          globalReadyAt = sentAt + minGlobalSpacingMs;
          accountReadyAt.set(candidate.accountId, sentAt + minAccountSpacingMs);
          dispatched += 1;
          let sending;
          try {
            sending = fetcher(candidate.url, candidate.init);
          } catch (error) {
            record(candidate, "transport_error");
            candidate.reject(error);
            return;
          }
          Promise.resolve(sending)
            .then(
              (response) => {
                if (response?.status === 429) {
                  const until = retryAfterMs(response, now) ?? now() + 1000;
                  if (until != null) {
                    if (candidate.cooldownScope === "account")
                      accountCooldownUntil.set(candidate.accountId, until);
                    else globalReadyAt = Math.max(globalReadyAt, until);
                  }
                }
                record(
                  candidate,
                  response?.status === 429 ? "cooldown" : "response",
                  response?.status,
                );
                candidate.resolve(response);
              },
              (error) => {
                record(candidate, "transport_error");
                candidate.reject(error);
              },
            )
            .finally(pump);
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

  function request(url, init = {}, context = {}) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return Promise.reject(
        makeError("Invalid game request URL", "DIRECT_REQUEST_INVALID_URL"),
      );
    }
    if (!origins.has(parsed.origin))
      return Promise.reject(
        makeError(
          "Request origin is not allowed",
          "DIRECT_REQUEST_ORIGIN_DENIED",
        ),
      );
    if (closed)
      return Promise.reject(
        makeError("Executor is closed", "DIRECT_REQUEST_CLOSED"),
      );
    if (queue.length >= maxQueueSize)
      return Promise.reject(
        makeError("Direct request queue is full", "DIRECT_REQUEST_QUEUE_FULL"),
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
      const { canDispatch: initCanDispatch, ...fetchInit } = init;
      const item = {
        url: parsed.href,
        init: fetchInit,
        accountId,
        resolve,
        reject,
        signal: context.signal ?? init.signal,
        deadlineAt,
        queuedAt: now(),
        source: [
          "connector",
          "proxy",
          "automation",
          "identity",
          "catalogue",
        ].includes(context.source)
          ? context.source
          : "wiki",
        attempt: Number.isSafeInteger(context.attempt) ? context.attempt : 1,
        cooldownScope:
          context.cooldownScope === "account" ? "account" : "global",
        canDispatch:
          context.canDispatch ?? initCanDispatch ?? defaultCanDispatch,
        cleanup: () => item.signal?.removeEventListener("abort", onAbort),
      };
      const onAbort = () =>
        rejectQueued(
          item,
          makeError(
            "Request was cancelled before dispatch",
            "DIRECT_REQUEST_CANCELLED",
          ),
        );
      if (item.signal?.aborted)
        return reject(
          makeError(
            "Request was cancelled before dispatch",
            "DIRECT_REQUEST_CANCELLED",
          ),
        );
      item.signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(item);
      item.deadlineTimer = setTimeout(
        () =>
          rejectQueued(
            item,
            makeError(
              "Request deadline elapsed before dispatch",
              "DIRECT_REQUEST_DEADLINE",
            ),
          ),
        Math.max(0, deadlineAt - now()),
      );
      pump();
    });
  }

  function close() {
    closed = true;
    if (timer) clearTimeout(timer);
    timer = null;
    for (const item of [...queue])
      rejectQueued(item, makeError("Executor is closed"));
  }

  function bindAccount(provisional, verified) {
    if (!provisional || !verified || provisional === verified) return;
    for (const map of [accountReadyAt, accountCooldownUntil]) {
      map.set(
        verified,
        Math.max(map.get(verified) || 0, map.get(provisional) || 0),
      );
      map.delete(provisional);
    }
    for (const item of queue)
      if (item.accountId === provisional) item.accountId = verified;
    pump();
  }

  return {
    request,
    close,
    bindAccount,
    diagnostics() {
      return {
        queued: queue.length,
        dispatched,
        accountsCoolingDown: [...accountCooldownUntil].filter(
          ([, until]) => until > now(),
        ).length,
        recent: [...events],
      };
    },
  };
}
