import { createHash, randomUUID } from "node:crypto";
import { isSnapshotPath } from "./snapshots.mjs";
import { currentWorkerLease } from "../automation/worker-lease-context.mjs";
import { withReadDiagnostic } from "../game/read-diagnostics.mjs";

const safeSegments = new Set([
  "api",
  "me",
  "bag",
  "stash",
  "sets",
  "floors",
  "info",
  "rooms",
  "clothing",
  "by-category",
  "ornaments",
  "zones",
  "weapons",
  "pets",
  "businesses",
  "bosses",
]);
const safeResource = (path) =>
  path
    .split("/")
    .map((part) => (!part || safeSegments.has(part) ? part : ":id"))
    .join("/");

// Owns logical read sharing above the route/transport boundary. Every waiter
// independently revalidates its credential and route before receiving data.
export function createAccountDataService({
  transport,
  snapshots,
  onDiagnostic = () => {},
  now = Date.now,
} = {}) {
  if (!transport || !snapshots)
    throw new TypeError("account_data_dependencies_required");
  const flights = new Map();
  const emit = (event) => {
    try {
      onDiagnostic(event);
    } catch {
      /* diagnostics cannot affect reads */
    }
  };
  async function scope(authorization, path) {
    if (typeof transport.shareScope === "function")
      return transport.shareScope(authorization, path);
    if (!snapshots.credentialCurrent(authorization)) return null;
    const version = snapshots.observationVersion(authorization, { path });
    return version
      ? { kind: "direct", route: `direct:${version.split(":")[0]}`, version }
      : null;
  }
  async function read(url, init = {}, live = false) {
    const parsed = new URL(url);
    const method = String(init.method || "GET").toUpperCase();
    const dispatch = live ? transport.liveFetch : transport.fetch;
    const authorization = new Headers(init.headers).get("authorization");
    const started = now();
    const logicalId = randomUUID();
    const source = [
      "proxy",
      "automation",
      "identity",
      "catalogue",
      "connector",
    ].includes(init.gameSource)
      ? init.gameSource
      : "wiki";
    const refresh = new Headers(init.headers).get(
      "X-Madhouse-Snapshot-Refresh",
    );
    const mode = live ? "action" : refresh ? "refresh" : "display";
    const report = (
      trace,
      joined,
      response,
      failed = false,
      route = "unknown",
    ) => {
      const snapshot = response?.headers?.get?.("X-Madhouse-Snapshot");
      const cache = joined
        ? "joined"
        : trace?.physical
          ? "network"
          : snapshot === "stale"
            ? "stale"
            : response?.status === 404
              ? "missing"
              : response?.ok
                ? "hit"
                : "none";
      emit({
        id: logicalId,
        correlation: trace?.id ?? null,
        source,
        reason: mode,
        resource: safeResource(parsed.pathname),
        mode,
        route,
        cache,
        ...(["current", "stale"].includes(snapshot) ? { snapshot } : {}),
        physical: Boolean(trace?.physical),
        attempt: trace?.physical ?? 0,
        waitedMs: Math.max(0, now() - started),
        result: failed ? "error" : response?.ok ? "ok" : "http_error",
        ...(response?.status ? { status: response.status } : {}),
      });
    };
    if (method !== "GET") return dispatch.call(transport, url, init);
    const runUnscoped = async () => {
      const trace = { id: randomUUID(), physical: 0 };
      try {
        const response = await withReadDiagnostic(trace, () =>
          dispatch.call(transport, url, init),
        );
        report(trace, false, response);
        return response;
      } catch (error) {
        report(trace, false, null, true);
        throw error;
      }
    };
    if (
      init.body != null ||
      !isSnapshotPath(parsed.pathname) ||
      init.gameBootstrapPermit ||
      !authorization
    )
      return runUnscoped();
    if (init.signal?.aborted) {
      report(null, false, null, true);
      throw new DOMException("Aborted", "AbortError");
    }
    let currentScope;
    try {
      currentScope = await scope(authorization, parsed.pathname);
    } catch (error) {
      report(null, false, null, true);
      throw error;
    }
    if (!currentScope) return runUnscoped();
    if (init.signal?.aborted) {
      report(null, false, null, true, currentScope.kind);
      throw new DOMException("Aborted", "AbortError");
    }
    const allowFallback =
      !live &&
      new Headers(init.headers).get("X-Madhouse-Snapshot-Refresh") !== "live";
    const fallback = async (response, error, signal, canDispatch) => {
      if (!allowFallback || signal?.aborted) {
        if (error) throw error;
        return response;
      }
      const latest = await scope(authorization, parsed.pathname);
      if (!latest || latest.route !== currentScope.route)
        throw Object.assign(new Error("game_route_changed"), {
          code: "game_route_changed",
        });
      if (canDispatch && (await canDispatch()) !== true)
        throw Object.assign(new Error("game_route_changed"), {
          code: "game_route_changed",
        });
      if (currentScope.kind === "bridge")
        await transport.noteReadFailure?.(authorization, parsed.pathname);
      const stored = await transport.readStored(url, { ...init, signal });
      if (!stored.ok) {
        if (error) throw error;
        return response;
      }
      const headers = new Headers(stored.headers);
      headers.set("X-Madhouse-Snapshot", "stale");
      headers.set("X-Madhouse-Game-Status", "unavailable");
      const retryAfter = response?.headers?.get("Retry-After");
      if (retryAfter) headers.set("Retry-After", retryAfter);
      return new Response(stored.body, { status: 200, headers });
    };
    const execute = async (signal, canDispatch = init.canDispatch) => {
      try {
        const response = await dispatch.call(transport, url, {
          ...init,
          signal,
          ...(canDispatch ? { canDispatch } : {}),
        });
        return response.status === 429 || response.status >= 500
          ? fallback(response, null, signal, canDispatch)
          : response;
      } catch (error) {
        if (
          ![
            "device_offline",
            "device_unavailable",
            "bridge_unavailable",
            "profile_unavailable",
          ].includes(error?.code)
        )
          throw error;
        return fallback(null, error, signal, canDispatch);
      }
    };
    if (
      init.gameAttempt != null ||
      currentWorkerLease() ||
      init.gameSource === "automation"
    ) {
      const trace = { id: randomUUID(), physical: 0 };
      try {
        const response = await withReadDiagnostic(trace, () =>
          execute(init.signal),
        );
        report(trace, false, response, false, currentScope.kind);
        return response;
      } catch (error) {
        report(trace, false, null, true, currentScope.kind);
        throw error;
      }
    }
    // Credentials are independently validated for every consumer; compatible
    // sessions of the same verified account may share the physical read.
    const headers = [...new Headers(init.headers).entries()]
      .filter(([name]) => name !== "authorization")
      .sort();
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          parsed.href,
          headers,
          live,
          init.gameSource || "wiki",
          currentScope.route,
          currentScope.version,
        ]),
      )
      .digest("hex");
    let flight = flights.get(key);
    const joined = Boolean(flight);
    if (!flight) {
      if (flights.size >= 256)
        throw Object.assign(new Error("account_read_capacity"), {
          status: 503,
        });
      const controller = new AbortController();
      flight = {
        controller,
        waiters: 0,
        settled: false,
        consumers: new Set(),
        trace: { id: randomUUID(), physical: 0 },
      };
      const active = flight;
      const canDispatch = async () => {
        for (const consumer of active.consumers) {
          if (consumer.signal?.aborted) continue;
          try {
            if (
              !consumer.canDispatch ||
              (await consumer.canDispatch()) === true
            )
              return true;
          } catch {
            // One denied consumer does not prevent another from dispatching.
          }
        }
        return false;
      };
      active.promise = Promise.resolve()
        .then(() =>
          withReadDiagnostic(active.trace, () =>
            execute(controller.signal, canDispatch),
          ),
        )
        .finally(() => {
          active.settled = true;
          if (flights.get(key) === active) flights.delete(key);
        });
      flights.set(key, active);
    }
    const active = flight;
    active.waiters++;
    const consumer = { signal: init.signal, canDispatch: init.canDispatch };
    active.consumers.add(consumer);
    return new Promise((resolve, reject) => {
      let completed = false;
      const release = () => {
        init.signal?.removeEventListener("abort", abort);
        active.consumers.delete(consumer);
        active.waiters--;
        if (!active.waiters && !active.settled) {
          if (flights.get(key) === active) flights.delete(key);
          active.controller.abort();
        }
      };
      const abort = () => {
        if (completed) return;
        completed = true;
        release();
        report(active.trace, joined, null, true, currentScope.kind);
        reject(new DOMException("Aborted", "AbortError"));
      };
      init.signal?.addEventListener("abort", abort, { once: true });
      if (init.signal?.aborted) abort();
      active.promise.then(
        async (response) => {
          if (completed) return;
          try {
            const latest = await scope(authorization, parsed.pathname);
            if (!latest || latest.route !== currentScope.route)
              throw Object.assign(new Error("game_route_changed"), {
                code: "game_route_changed",
              });
            if (init.canDispatch && (await init.canDispatch()) !== true)
              throw Object.assign(new Error("game_route_changed"), {
                code: "game_route_changed",
              });
            if (completed) return;
            completed = true;
            release();
            report(active.trace, joined, response, false, currentScope.kind);
            resolve(response.clone());
          } catch (error) {
            if (completed) return;
            completed = true;
            release();
            report(active.trace, joined, null, true, currentScope.kind);
            reject(error);
          }
        },
        (error) => {
          if (completed) return;
          completed = true;
          release();
          report(active.trace, joined, null, true, currentScope.kind);
          reject(error);
        },
      );
    });
  }
  async function stored(url, init, options) {
    const started = now();
    let response;
    try {
      response = options
        ? await snapshots.readStored(url, init, options)
        : await transport.readStored(url, init);
      return response;
    } finally {
      emit({
        id: randomUUID(),
        correlation: null,
        source: "wiki",
        reason: "stored",
        resource: safeResource(new URL(url).pathname),
        mode: "stored",
        route: "local",
        cache:
          response?.status === 404
            ? "missing"
            : response?.headers?.get?.("X-Madhouse-Snapshot") === "stale"
              ? "stale"
              : response?.ok
                ? "hit"
                : "missing",
        physical: false,
        waitedMs: Math.max(0, now() - started),
        result: response?.ok ? "ok" : response ? "http_error" : "error",
        ...(response?.status ? { status: response.status } : {}),
      });
    }
  }
  return Object.freeze({
    fetch: (url, init) => read(url, init, false),
    liveFetch: (url, init) => read(url, init, true),
    readStored: (url, init) => stored(url, init),
    readVerifiedStored: (url, init, options) => stored(url, init, options),
    ...(typeof transport.verifyLocal === "function"
      ? { verifyLocal: (...args) => transport.verifyLocal(...args) }
      : {}),
  });
}
