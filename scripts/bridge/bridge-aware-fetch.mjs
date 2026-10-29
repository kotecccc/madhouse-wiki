import { createGameRouter } from "./game-router.mjs";

const fail = (code) => Object.assign(new Error(code), { code });

/**
 * Server-side bridge boundary for the Wiki snapshot/automation transport.
 * The identity is derived from protected server state; no player ID from a
 * request is trusted. This module is not enabled until all egress paths and
 * restore/rollback gates use the same durable policy.
 */
export function createBridgeAwareAccountFetch({
  snapshots,
  accounts,
  directRoutes,
  directCredentials = null,
  accountService,
  canonicalCredential = (value) => value,
} = {}) {
  if (
    !snapshots ||
    typeof snapshots.identity !== "function" ||
    typeof snapshots.fetch !== "function" ||
    typeof snapshots.liveFetch !== "function" ||
    typeof accounts?.resolveCredential !== "function" ||
    typeof directRoutes?.resolve !== "function" ||
    typeof directRoutes?.registerVerifiedDirect !== "function" ||
    typeof directRoutes?.withDirectLease !== "function" ||
    (directCredentials !== null &&
      typeof directCredentials?.resolve !== "function") ||
    typeof accountService?.profile !== "function"
  )
    throw new TypeError("bridge_fetch_dependencies_required");

  // Concurrent login consumers share one bridge read. Cancellation belongs to
  // each consumer; the device request stops only when nobody is waiting.
  const pendingProfiles = new Map();
  function readProfile(owner, authorization, signal, canDispatch) {
    if (signal?.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    const key = `${owner}:${authorization}`;
    let pending = pendingProfiles.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = { controller, waiters: 0 };
      const current = pending;
      current.promise = Promise.resolve()
        .then(() =>
          accountService.profile(owner, {
            signal: controller.signal,
            canDispatch,
          }),
        )
        .finally(() => {
          if (pendingProfiles.get(key) === current) pendingProfiles.delete(key);
        });
      pendingProfiles.set(key, current);
    }
    pending.waiters += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        signal?.removeEventListener("abort", abort);
        pending.waiters -= 1;
        if (!pending.waiters && pendingProfiles.get(key) === pending) {
          pendingProfiles.delete(key);
          pending.controller.abort();
        }
        callback(value);
      };
      const abort = () =>
        finish(reject, new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", abort, { once: true });
      pending.promise.then(
        (result) => finish(resolve, result),
        (error) => finish(reject, error),
      );
    });
  }

  // Snapshot identity is server-owned and was established by a prior verified
  // game response. Enrollment is atomic with the bridge tombstone check; an
  // unknown client-provided token or a deleted bridge account cannot enroll.
  function snapshotRoute(playerId, owner) {
    const identity = { playerId, ...(owner ? { owner } : {}) };
    const existing = directRoutes.resolve(identity);
    if (existing) return existing;
    directRoutes.registerVerifiedDirect(playerId, owner);
    return directRoutes.resolve(identity);
  }

  async function dispatch(url, init = {}, live = false) {
    const authorization = new Headers(init.headers).get("authorization");
    if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))
      throw fail("game_identity_unverified");
    const identity = { authorization };
    const resolveRoute = async () => {
      const known = accounts.resolveCredential(authorization);
      if (known) return known;
      const registered = directCredentials?.resolve(authorization);
      if (registered) {
        if (
          (identity.playerId && identity.playerId !== registered.playerId) ||
          (identity.owner && identity.owner !== registered.owner)
        )
          throw fail("game_identity_changed");
        identity.playerId = registered.playerId;
        identity.owner = registered.owner;
        const route = directRoutes.resolve(registered);
        return route?.policy === "bridge_required"
          ? { ...route, credentialCurrent: false }
          : route;
      }
      const snapshot = (snapshots.routingIdentity || snapshots.identity).call(
        snapshots,
        authorization,
      );
      if (!Number.isSafeInteger(snapshot?.playerId) || snapshot.playerId <= 0)
        return null;
      const playerId = String(snapshot.playerId);
      if (identity.playerId && identity.playerId !== playerId)
        throw fail("game_identity_changed");
      identity.playerId = playerId;
      if (identity.owner && identity.owner !== snapshot.owner)
        throw fail("game_identity_changed");
      if (snapshot.owner) identity.owner = snapshot.owner;
      const route = snapshotRoute(playerId, snapshot.owner);
      // A known bridge player with an unrecognized token must rebind it;
      // possession of an old snapshot never grants access to the new token.
      if (route?.policy === "bridge_required")
        return { ...route, credentialCurrent: false };
      return route;
    };
    const router = createGameRouter({
      resolveRoute,
      directFetch: (target, options) =>
        live
          ? snapshots.liveFetch(target, options)
          : snapshots.fetch(target, options),
      withDirectLease: directRoutes.withDirectLease,
      bridgeProfile: async (owner, options) => {
        const credential = canonicalCredential(authorization);
        const refresh = new Headers(init.headers).get(
          "X-Madhouse-Snapshot-Refresh",
        );
        if (!live && !refresh && snapshots.bridgeProfile) {
          const saved = snapshots.bridgeProfile(credential);
          if (saved) return saved;
        }
        const result = await readProfile(
          owner,
          authorization,
          options.signal,
          options.canDispatch,
        );
        snapshots.saveBridgeProfile?.(credential, result.profile);
        return new Response(JSON.stringify(result.profile), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-store",
          },
        });
      },
      ...(typeof accountService.read === "function"
        ? {
            bridgeRead: async (owner, path, options) => {
              const result = await accountService.read(owner, path, options);
              return new Response(
                [204, 205, 304].includes(result.status) ? null : result.body,
                {
                  status: result.status,
                  headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "private, no-store",
                    ...(result.retryAfter
                      ? { "Retry-After": result.retryAfter }
                      : {}),
                  },
                },
              );
            },
          }
        : {}),
      ...(live && typeof accountService.send === "function"
        ? {
            bridgeAction: async (owner, method, path, options) => {
              const result = await accountService.send(owner, method, path, {
                ...options,
                callerAuthorization: authorization,
                validateCaller: () => {
                  const route = accounts.resolveCredential(authorization);
                  return (
                    route?.policy === "bridge_required" &&
                    route.owner === owner &&
                    route.credentialCurrent === true
                  );
                },
              });
              return new Response(
                [204, 205, 304].includes(result.status) ? null : result.body,
                {
                  status: result.status,
                  headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "private, no-store",
                    ...(result.retryAfter
                      ? { "Retry-After": result.retryAfter }
                      : {}),
                  },
                },
              );
            },
          }
        : {}),
    });
    return router.fetchGame({ url, init, verifiedIdentity: identity });
  }
  async function verifyLocal(authorization) {
    if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))
      throw fail("game_identity_unverified");
    const known = accounts.resolveCredential(authorization);
    if (known) {
      if (
        known.policy !== "bridge_required" ||
        known.credentialCurrent !== true ||
        !Number.isSafeInteger(known.epoch) ||
        known.epoch < 1
      )
        throw fail("game_credentials_stale");
      return { policy: "bridge_required" };
    }
    const registered = directCredentials?.resolve(authorization);
    if (registered) {
      const route = directRoutes.resolve(registered);
      if (
        route?.policy !== "direct" ||
        !Number.isSafeInteger(route.epoch) ||
        route.epoch < 1
      )
        throw fail("game_route_unavailable");
      return { policy: "direct" };
    }
    const snapshot = (snapshots.routingIdentity || snapshots.identity).call(
      snapshots,
      authorization,
    );
    if (!Number.isSafeInteger(snapshot?.playerId) || snapshot.playerId <= 0)
      throw fail("game_identity_unverified");
    const route = snapshotRoute(String(snapshot.playerId), snapshot.owner);
    if (
      !route ||
      route.policy !== "direct" ||
      !Number.isSafeInteger(route.epoch) ||
      route.epoch < 1
    )
      throw fail("game_route_unavailable");
    return { policy: "direct" };
  }
  return Object.freeze({
    fetch: (url, init) => dispatch(url, init, false),
    liveFetch: (url, init) => dispatch(url, init, true),
    async readStored(url, init = {}) {
      const headers = new Headers(init.headers);
      const authorization = headers.get("authorization");
      await verifyLocal(authorization);
      const canonical = canonicalCredential(authorization);
      headers.set("authorization", canonical);
      return snapshots.readStored(
        url,
        { ...init, headers },
        {
          verifiedWiki: canonical !== authorization,
        },
      );
    },
    verifyLocal,
  });
}
