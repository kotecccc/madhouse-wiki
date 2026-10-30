import { createHash } from "node:crypto";
import { isSnapshotPath } from "./snapshots.mjs";
import { currentWorkerLease } from "../automation/worker-lease-context.mjs";

// Owns logical read sharing above the route/transport boundary. Every waiter
// independently revalidates its credential and route before receiving data.
export function createAccountDataService({ transport, snapshots } = {}) {
  if (!transport || !snapshots)
    throw new TypeError("account_data_dependencies_required");
  const flights = new Map();
  async function scope(authorization, path) {
    if (typeof transport.shareScope === "function")
      return transport.shareScope(authorization, path);
    if (!snapshots.credentialCurrent(authorization)) return null;
    const version = snapshots.observationVersion(authorization, { path });
    return version
      ? { route: `direct:${version.split(":")[0]}`, version }
      : null;
  }
  async function read(url, init = {}, live = false) {
    const parsed = new URL(url);
    const method = String(init.method || "GET").toUpperCase();
    const dispatch = live ? transport.liveFetch : transport.fetch;
    const authorization = new Headers(init.headers).get("authorization");
    if (
      method !== "GET" ||
      init.body != null ||
      !isSnapshotPath(parsed.pathname) ||
      init.canDispatch ||
      init.gameBootstrapPermit ||
      init.gameAttempt != null ||
      currentWorkerLease() ||
      init.gameSource === "automation" ||
      !authorization
    )
      return dispatch.call(transport, url, init);
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const currentScope = await scope(authorization, parsed.pathname);
    if (!currentScope) return dispatch.call(transport, url, init);
    if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const headers = [...new Headers(init.headers).entries()].sort();
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          authorization,
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
    if (!flight) {
      if (flights.size >= 256)
        throw Object.assign(new Error("account_read_capacity"), {
          status: 503,
        });
      const controller = new AbortController();
      flight = { controller, waiters: 0, settled: false };
      const active = flight;
      active.promise = Promise.resolve()
        .then(() =>
          dispatch.call(transport, url, { ...init, signal: controller.signal }),
        )
        .finally(() => {
          active.settled = true;
          if (flights.get(key) === active) flights.delete(key);
        });
      flights.set(key, active);
    }
    const active = flight;
    active.waiters++;
    return new Promise((resolve, reject) => {
      let completed = false;
      const release = () => {
        init.signal?.removeEventListener("abort", abort);
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
            if (completed) return;
            completed = true;
            release();
            resolve(response.clone());
          } catch (error) {
            if (completed) return;
            completed = true;
            release();
            reject(error);
          }
        },
        (error) => {
          if (completed) return;
          completed = true;
          release();
          reject(error);
        },
      );
    });
  }
  return Object.freeze({
    fetch: (url, init) => read(url, init, false),
    liveFetch: (url, init) => read(url, init, true),
    readStored: (...args) => transport.readStored(...args),
    ...(typeof transport.verifyLocal === "function"
      ? { verifyLocal: (...args) => transport.verifyLocal(...args) }
      : {}),
  });
}
