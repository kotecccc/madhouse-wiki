import { createGameRouter } from "./game-router.mjs";
import { bridgeProfileCurrent, bridgeReadCurrent } from "./account-service.mjs";

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

  // Compatible login consumers share one bridge read and its snapshot ticket.
  // Keep the flight alive through each consumer's router checks and commit so
  // a new caller cannot invalidate a ticket between response and persistence.
  const pendingProfiles = new Map();
  function readProfile(
    owner,
    authorization,
    profileCredential,
    signal,
    canDispatch,
    shareable,
    observationVersion,
    freshness,
    createSnapshotRead,
  ) {
    if (signal?.aborted)
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    const key = shareable
      ? JSON.stringify([
          owner,
          authorization,
          profileCredential,
          observationVersion,
          freshness,
        ])
      : Symbol("profile-read");
    let pending = pendingProfiles.get(key);
    if (!pending) {
      const controller = new AbortController();
      pending = {
        controller,
        snapshotRead: createSnapshotRead(),
        waiters: 0,
      };
      const current = pending;
      current.promise = Promise.resolve().then(() =>
        accountService.profile(owner, {
          signal: controller.signal,
          canDispatch,
        }),
      );
      pendingProfiles.set(key, current);
    }
    pending.waiters += 1;
    return new Promise((resolve, reject) => {
      let completed = false;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        signal?.removeEventListener("abort", abort);
        pending.waiters -= 1;
        if (!pending.waiters && pendingProfiles.get(key) === pending) {
          pendingProfiles.delete(key);
          if (!pending.settled) pending.controller.abort();
        }
      };
      const abort = () => {
        if (completed) {
          release();
          return;
        }
        completed = true;
        release();
        reject(new DOMException("Aborted", "AbortError"));
      };
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      pending.promise.then(
        (result) => {
          pending.settled = true;
          if (completed) return;
          completed = true;
          resolve({ result, snapshotRead: pending.snapshotRead, release });
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
    // Kept per dispatch (not on the shared pending profile read): concurrent
    // consumers can have different snapshot revisions and must commit against
    // their own tickets after the router has revalidated the route.
    let bridgeProfileCommit = null;
    let bridgeObservationCommit = null;
    let releaseProfileRead = null;
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
        const boundPlayer = Number(accounts.read?.(owner)?.playerId);
        const observationVersion = snapshots.observationVersion?.(credential, {
          verifiedPlayerId: boundPlayer,
        });
        const refresh = new Headers(init.headers).get(
          "X-Madhouse-Snapshot-Refresh",
        );
        if (!live && typeof snapshots.readDisplayCache === "function") {
          const headers = new Headers(init.headers);
          headers.set("Authorization", credential);
          const saved = snapshots.readDisplayCache(
            url,
            { ...init, headers },
            { verifiedPlayerId: boundPlayer },
          );
          if (saved) return saved;
        } else if (!live && !refresh && snapshots.bridgeProfile) {
          const saved = snapshots.bridgeProfile(credential);
          if (saved) return saved;
        }
        const profileRead = await readProfile(
          owner,
          authorization,
          credential,
          options.signal,
          options.canDispatch,
          !init.signal &&
            !init.canDispatch &&
            (typeof snapshots.observationVersion !== "function" ||
              observationVersion !== null),
          observationVersion,
          live
            ? "live"
            : refresh ||
                (new Headers(init.headers).get("X-Madhouse-Snapshot-Only") ===
                "1"
                  ? "stored"
                  : "display"),
          () => {
            const hasBridgeProfileReadApi =
              typeof snapshots.beginBridgeProfileRead === "function" &&
              typeof snapshots.commitBridgeProfileRead === "function";
            const boundPlayer = Number(accounts.read?.(owner)?.playerId);
            const ticket = hasBridgeProfileReadApi
              ? snapshots.beginBridgeProfileRead(credential, {
                  ...(Number.isSafeInteger(boundPlayer) && boundPlayer > 0
                    ? { verifiedPlayerId: boundPlayer }
                    : {}),
                })
              : null;
            return { credential, ticket, hasBridgeProfileReadApi };
          },
        );
        releaseProfileRead = profileRead.release;
        const { result, snapshotRead } = profileRead;
        bridgeProfileCommit = {
          ...snapshotRead,
          profile: result.profile,
          current: result[bridgeProfileCurrent],
        };
        return new Response(JSON.stringify(result.profile), {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-store",
            "X-Madhouse-Snapshot": "current",
            "X-Madhouse-Snapshot-Completeness": "unknown",
            "X-Madhouse-Section-Updated": String(Date.now()),
          },
        });
      },
      ...(typeof accountService.read === "function"
        ? {
            bridgeRead: async (owner, path, options) => {
              const boundPlayer = Number(accounts.read?.(owner)?.playerId);
              if (!live && typeof snapshots.readDisplayCache === "function") {
                const headers = new Headers(init.headers);
                headers.set(
                  "Authorization",
                  canonicalCredential(authorization),
                );
                const saved = snapshots.readDisplayCache(
                  new URL(path, url),
                  { ...init, method: options.method || "GET", headers },
                  { verifiedPlayerId: boundPlayer },
                );
                if (saved) return saved;
              } else if (
                !live &&
                (options.method || "GET") === "GET" &&
                new Headers(init.headers).get("X-Madhouse-Snapshot-Only") ===
                  "1" &&
                Number.isSafeInteger(boundPlayer) &&
                boundPlayer > 0 &&
                typeof snapshots.readStored === "function"
              ) {
                const stored = snapshots.readStored(
                  new URL(path, url),
                  {
                    headers: {
                      Authorization: canonicalCredential(authorization),
                    },
                  },
                  { verifiedWiki: true, verifiedPlayerId: boundPlayer },
                );
                if (stored.ok) return stored;
                if (stored.status !== 404) return stored;
              }
              const ticket = snapshots.beginBridgeObservation?.(
                canonicalCredential(authorization),
                path,
                {
                  ...(Number.isSafeInteger(boundPlayer) && boundPlayer > 0
                    ? { verifiedPlayerId: boundPlayer }
                    : {}),
                },
              );
              const result = await accountService.read(owner, path, options);
              if (
                ticket &&
                result.status === 200 &&
                Buffer.isBuffer(result.body)
              ) {
                try {
                  bridgeObservationCommit = {
                    ticket,
                    data: JSON.parse(
                      new TextDecoder("utf-8", { fatal: true }).decode(
                        result.body,
                      ),
                    ),
                    current: result[bridgeReadCurrent],
                  };
                } catch {
                  // A malformed response is never saved as a resource.
                }
              }
              return new Response(
                [204, 205, 304].includes(result.status) ? null : result.body,
                {
                  status: result.status,
                  headers: {
                    "Content-Type": "application/json; charset=utf-8",
                    "Cache-Control": "private, no-store",
                    ...(ticket && result.status === 200
                      ? {
                          "X-Madhouse-Snapshot": "current",
                          "X-Madhouse-Snapshot-Completeness": "unknown",
                          "X-Madhouse-Section-Updated": String(Date.now()),
                        }
                      : {}),
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
                beforeDispatch: ({
                  authorization: gameAuthorization,
                  playerId,
                }) => {
                  const ticket = snapshots.beginMutation?.(
                    gameAuthorization,
                    method,
                    path,
                    { verifiedPlayerId: Number(playerId) },
                  );
                  return ticket
                    ? snapshots.commitMutationBarrier(ticket)
                    : typeof snapshots.beginMutation !== "function";
                },
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
    try {
      const response = await router.fetchGame({
        url,
        init,
        verifiedIdentity: identity,
      });
      if (init.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (bridgeProfileCommit) {
        const {
          credential,
          profile,
          ticket,
          hasBridgeProfileReadApi,
          current,
        } = bridgeProfileCommit;
        if (current && current() !== true) throw fail("game_route_changed");
        if (hasBridgeProfileReadApi) {
          if (snapshots.commitBridgeProfileRead(ticket, profile) !== true)
            return new Response(
              JSON.stringify({ error: "snapshot_superseded" }),
              {
                status: 409,
                headers: {
                  "Content-Type": "application/json; charset=utf-8",
                  "Cache-Control": "private, no-store",
                },
              },
            );
        } else snapshots.saveBridgeProfile?.(credential, profile);
      }
      if (bridgeObservationCommit) {
        const { ticket, data, current } = bridgeObservationCommit;
        if (current && current() !== true) throw fail("game_route_changed");
        if (snapshots.commitBridgeObservation(ticket, data) !== true)
          return new Response(
            JSON.stringify({ error: "snapshot_superseded" }),
            {
              status: 409,
              headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "private, no-store",
              },
            },
          );
      }
      return response;
    } finally {
      releaseProfileRead?.();
    }
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
