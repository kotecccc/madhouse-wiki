import { createHash } from "node:crypto";
import { retryDelay } from "./action-queue.mjs";

// Evidence contains hashes only: paths can include account or entity IDs.
const WINDOW_MS = 60_000;
const empty = () => ({ evidence: [], readyAt: 0, failures: 0 });

export function emptyGameOutage() {
  return empty();
}

export function recordGameFailure(
  state,
  path,
  now,
  random = Math.random,
  retryAfterMs = 0,
) {
  if (state.readyAt) return state;
  // Two endpoints of the same subsystem can fail together independently of
  // the rest of the game (for example one business and its upgrade route).
  const route = path.split("/").slice(0, 3).join("/");
  const id = createHash("sha256").update(route).digest("hex");
  const previous = state.evidence.find(
    (item) => item.id === id && item.at <= now && now - item.at <= WINDOW_MS,
  );
  const evidence = state.evidence.filter(
    (item) => item.at <= now && now - item.at <= WINDOW_MS && item.id !== id,
  );
  evidence.push({
    id,
    at: now,
    retryAt: Math.max(now + retryAfterMs, previous?.retryAt ?? 0),
  });
  if (evidence.length < 2) return { ...state, evidence };
  return {
    evidence: [],
    readyAt: Math.max(
      now + retryDelay(0, random),
      ...evidence.map((item) => item.retryAt),
    ),
    failures: 1,
  };
}

// Persist this reservation before probing. A crash or concurrent worker then
// cannot immediately produce another probe for every queued action.
export function reserveGameProbe(state, now, random = Math.random) {
  if (!state.readyAt || now < state.readyAt) return null;
  return {
    evidence: [],
    readyAt: now + retryDelay(state.failures, random),
    failures: state.failures + 1,
  };
}

export function gameProbeSucceeded() {
  return empty();
}

function retryAfterMs(response, now) {
  const value = response.headers.get("retry-after");
  const delay = value
    ? /^\d+$/.test(value)
      ? Number(value) * 1000
      : Date.parse(value) - now
    : 0;
  return Number.isSafeInteger(delay) &&
    delay > 0 &&
    Number.isSafeInteger(now + delay)
    ? delay
    : 0;
}

export function createGameOutageFetch({
  fetcher,
  load,
  save,
  now = Date.now,
  random = Math.random,
  onStorageError = () => {},
}) {
  let storageFailed = false;
  let probing = null;
  function markStorageFailure(error) {
    storageFailed = true;
    onStorageError(error);
  }
  function denied(delay = 0) {
    return Object.assign(new Error("game_outage_wait"), {
      notDispatched: true,
      retryAfterMs: Math.max(0, delay),
    });
  }
  function current() {
    if (storageFailed) throw denied();
    try {
      return load();
    } catch (error) {
      markStorageFailure(error);
      throw denied();
    }
  }
  function store(state) {
    try {
      save(state);
    } catch (error) {
      markStorageFailure(error);
      throw error;
    }
  }
  async function probe(url, init, state) {
    let reserved = reserveGameProbe(state, now(), random);
    if (!reserved) throw denied(state.readyAt - now());
    try {
      store(reserved);
    } catch {
      throw denied();
    }
    const authorization = new Headers(init.headers).get("authorization");
    if (!authorization) throw denied(reserved.readyAt - now());
    try {
      const response = await fetcher(new URL("/api/me", url).toString(), {
        method: "GET",
        headers: { Authorization: authorization, Accept: "application/json" },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      });
      if (response.status === 401) {
        // The game answered; this credential is invalid, not evidence that
        // every account must remain behind the shared outage barrier.
        store(gameProbeSucceeded());
        return {
          invalidCredential: createHash("sha256")
            .update(authorization)
            .digest("hex"),
        };
      }
      if (!response.ok) {
        const delay = retryAfterMs(response, now());
        if (delay > 0) {
          reserved = {
            ...reserved,
            readyAt: Math.max(reserved.readyAt, now() + delay),
          };
          store(reserved);
        }
        throw new Error("game_probe_failed");
      }
      const body = await response.json();
      if (!Number.isSafeInteger(body?.playerId) || body.playerId <= 0)
        throw new Error("game_probe_invalid");
      store(gameProbeSucceeded());
      return null;
    } catch {
      throw denied(reserved.readyAt - now());
    }
  }
  return async (url, init = {}) => {
    const state = current();
    if (state.readyAt) {
      let probeResult;
      if (!probing) {
        const pending = probe(url, init, state);
        probing = pending;
        try {
          probeResult = await pending;
        } finally {
          if (probing === pending) probing = null;
        }
      } else probeResult = await probing;
      const authorization = new Headers(init.headers).get("authorization");
      if (
        probeResult?.invalidCredential &&
        authorization &&
        createHash("sha256").update(authorization).digest("hex") ===
          probeResult.invalidCredential
      )
        throw Object.assign(new Error("game_session_required"), {
          status: 401,
          notDispatched: true,
        });
    }
    try {
      const response = await fetcher(url, {
        ...init,
        canDispatch: () => {
          try {
            return (
              !current().readyAt && (!init.canDispatch || init.canDispatch())
            );
          } catch {
            return false;
          }
        },
      });
      try {
        const latest = current();
        if (response.status >= 500)
          store(
            recordGameFailure(
              latest,
              new URL(url).pathname,
              now(),
              random,
              retryAfterMs(response, now()),
            ),
          );
        else if (response.ok && !latest.readyAt && latest.evidence.length)
          store(emptyGameOutage());
      } catch {
        // A response may confirm a mutation. Never replace it with a storage
        // error; the storage failure blocks all subsequent dispatches.
      }
      return response;
    } catch (error) {
      if (
        !error?.notDispatched &&
        (error instanceof TypeError || error?.name === "TimeoutError")
      ) {
        try {
          store(
            recordGameFailure(current(), new URL(url).pathname, now(), random),
          );
        } catch {
          // Preserve the original uncertain outcome of a submitted mutation.
        }
      }
      throw error;
    }
  };
}
