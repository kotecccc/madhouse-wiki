const GAME_ORIGIN = "https://cargohustle.online";
import {
  isAllowedGameRead,
  isAllowedWorkView,
  isInventoryActionRoute,
  isBattleActionRoute,
} from "./profile-client.mjs";
const fail = (code) => Object.assign(new Error(code), { code });

const MAX_DIRECT_RESPONSE_BYTES = 4 * 1024 * 1024;
async function drainDirectResponse(response) {
  if (!(response instanceof Response)) throw fail("game_response_invalid");
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_DIRECT_RESPONSE_BYTES) {
      await reader.cancel();
      throw fail("game_response_too_large");
    }
    chunks.push(value);
  }
  return new Response(Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * A route resolver must use server-verified identity, not an ID supplied by the
 * browser. Unknown or unavailable policy fails closed. Bridge MVP currently
 * supports selected read-only paths and never dispatches game mutations.
 */
export function createGameRouter({
  resolveRoute,
  directFetch,
  bridgeProfile,
  bridgeRead,
  bridgeAction,
  withDirectLease,
} = {}) {
  if (
    typeof resolveRoute !== "function" ||
    typeof directFetch !== "function" ||
    typeof bridgeProfile !== "function"
  )
    throw new TypeError("game_router_dependencies_required");
  async function fetchGame({ url, init = {}, verifiedIdentity }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw fail("game_target_forbidden");
    }
    if (
      parsed.origin !== GAME_ORIGIN ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    )
      throw fail("game_target_forbidden");
    if (!verifiedIdentity || typeof verifiedIdentity !== "object")
      throw fail("game_identity_unverified");
    let route;
    try {
      route = await resolveRoute(verifiedIdentity);
    } catch {
      throw fail("game_route_unavailable");
    }
    if (
      !route ||
      !["direct", "bridge_required"].includes(route.policy) ||
      !Number.isSafeInteger(route.epoch) ||
      route.epoch < 0
    )
      throw fail("game_route_unavailable");
    if (route.policy === "direct") {
      if (route.owner != null || route.epoch < 1)
        throw fail("game_route_unavailable");
      if (typeof withDirectLease !== "function")
        throw fail("game_route_unavailable");
      return withDirectLease(
        verifiedIdentity,
        route.epoch,
        async (markDispatched, markReadFinished) => {
          let current;
          try {
            current = await resolveRoute(verifiedIdentity);
          } catch {
            throw fail("game_route_unavailable");
          }
          if (
            !current ||
            current.policy !== "direct" ||
            current.epoch !== route.epoch ||
            current.owner != null
          )
            throw fail("game_route_changed");
          markDispatched();
          const response = await drainDirectResponse(
            await directFetch(parsed.href, { ...init, redirect: "manual" }),
          );
          if (
            ["GET", "HEAD"].includes(String(init.method || "GET").toUpperCase())
          )
            markReadFinished?.();
          // A proxy may have collapsed an uncertain upstream failure into 5xx.
          // Keep the lease until it is reconciled rather than assuming failure.
          if (
            response.status >= 500 ||
            response.headers.get("x-madhouse-snapshot") === "stale"
          )
            throw fail("direct_result_uncertain");
          return response;
        },
        {
          effect: ["GET", "HEAD"].includes(
            String(init.method || "GET").toUpperCase(),
          )
            ? "read"
            : "mutation",
        },
      );
    }
    if (route.epoch < 1 || typeof route.owner !== "string" || !route.owner)
      throw fail("game_route_unavailable");
    if (route.credentialCurrent === false) throw fail("game_credentials_stale");
    const method = String(init.method || "GET").toUpperCase();
    const path = parsed.pathname + parsed.search;
    // A bridge error is final; it is never retried via directFetch.
    let result;
    if (
      method === "GET" &&
      init.body == null &&
      isAllowedGameRead(path) &&
      !(parsed.pathname === "/api/me" && parsed.search)
    ) {
      if (path === "/api/me") {
        result = await bridgeProfile(route.owner, { signal: init.signal });
      } else {
        if (typeof bridgeRead !== "function")
          throw fail("bridge_operation_not_supported");
        result = await bridgeRead(route.owner, path, { signal: init.signal });
      }
    } else if (
      isAllowedWorkView(method, path, init.body) &&
      typeof bridgeRead === "function"
    ) {
      result = await bridgeRead(route.owner, path, {
        signal: init.signal,
        method,
        body: init.body,
      });
    } else if (
      typeof bridgeAction === "function" &&
      method === "POST" &&
      path === "/api/works/tasks/perform" &&
      typeof init.body === "string"
    ) {
      result = await bridgeAction(route.owner, method, path, {
        signal: init.signal,
        body: init.body,
      });
    } else if (
      typeof bridgeAction === "function" &&
      !parsed.search &&
      (((isInventoryActionRoute(method, path) ||
        isBattleActionRoute(method, path)) &&
        (init.body == null || typeof init.body === "string")) ||
        (method === "POST" &&
          [
            "/api/friends/requests",
            "/api/me/bag/boosters/use",
            "/api/me/bag/boosters/buy",
          ].includes(path) &&
          typeof init.body === "string") ||
        (method === "POST" &&
          /^\/api\/friends\/requests\/[1-9][0-9]*\/accept$/.test(path) &&
          init.body === "{}") ||
        (method === "DELETE" &&
          /^\/api\/friends\/(?:requests\/)?[1-9][0-9]*$/.test(path) &&
          init.body == null))
    ) {
      result = await bridgeAction(route.owner, method, path, {
        signal: init.signal,
        body: init.body,
      });
    } else {
      throw fail("bridge_operation_not_supported");
    }
    let current;
    try {
      current = await resolveRoute(verifiedIdentity);
    } catch {
      throw fail("game_route_unavailable");
    }
    if (
      !current ||
      current.policy !== "bridge_required" ||
      current.epoch !== route.epoch ||
      current.owner !== route.owner ||
      current.credentialCurrent === false
    )
      throw fail("game_route_changed");
    return result;
  }
  return Object.freeze({ fetchGame });
}
