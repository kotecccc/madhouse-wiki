const CARGO_ORIGIN = "https://cargohustle.online";
const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_REQUEST_DEADLINE_MS = 30_000;
const SAFE_UPSTREAM_HEADERS = new Set([
  "accept",
  "authorization",
  "cache-control",
  "content-type",
  "x-cargohustle-dev-key",
  "x-madhouse-snapshot-only",
  "x-madhouse-snapshot-refresh",
  "x-madhouse-wiki-init-data",
]);
const CANONICAL_HEADER_NAMES = Object.freeze({
  accept: "Accept",
  authorization: "Authorization",
  "cache-control": "Cache-Control",
  "content-type": "Content-Type",
  "x-cargohustle-dev-key": "X-CargoHustle-Dev-Key",
  "x-madhouse-snapshot-only": "X-Madhouse-Snapshot-Only",
  "x-madhouse-snapshot-refresh": "X-Madhouse-Snapshot-Refresh",
  "x-madhouse-wiki-init-data": "X-Madhouse-Wiki-Init-Data",
});

const routeError = (code, status = 503) =>
  Object.assign(new Error(code), { code, status });
const ensureNotAborted = (signal) => {
  if (!signal?.aborted) return;
  if (signal.reason?.name === "TimeoutError")
    throw routeError("game_request_timeout", 504);
  throw routeError("game_request_cancelled", 499);
};
function waitForSignal(promise, signal) {
  if (!signal) return Promise.resolve(promise);
  ensureNotAborted(signal);
  if (typeof signal.addEventListener !== "function")
    return Promise.resolve(promise);

  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => {
      try {
        ensureNotAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  return Promise.race([Promise.resolve(promise), aborted]).finally(() => {
    signal.removeEventListener("abort", onAbort);
  });
}

const REVIEWED_READ_PATHS = Object.freeze([
  "/api/me",
  "/api/me/bag",
  "/api/stash/sets",
  "/api/floors",
  "/api/floors/{code}/info",
  "/api/rooms",
  "/api/clothing",
  "/api/clothing/by-category/{category}",
  "/api/ornaments/zones/{zoneId}",
  "/api/weapons/{weaponId}",
  "/api/pets/{petId}",
  "/api/businesses/{businessId}",
  "/api/bosses/{bossId}",
  "/api/players/{playerId}",
  "/api/bosses/invitations",
  "/api/combat",
  "/api/combat/battles/{battleId}",
  "/api/bosses/battles/{battleId}",
  "/api/friends",
  "/api/friends/requests/outgoing",
  "/api/player-interactions/booster-requests/incoming",
  "/api/stash/help-requests/{playerId}",
]);
const REVIEWED_MUTATION_PATHS = Object.freeze([
  "/api/bosses/battles/{battleId}/attack",
]);

function pathPattern(template) {
  return new RegExp(
    "^" +
      template
        .split(/(\{[^}]+\})/u)
        .map((part) =>
          part.startsWith("{")
            ? "[A-Za-z0-9_$-]+"
            : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
        )
        .join("") +
      "$",
    "u",
  );
}

function reviewedReadPath(path) {
  const exact = REVIEWED_READ_PATHS.find((template) => template === path);
  if (exact) return exact;
  return (
    REVIEWED_READ_PATHS.find((template) => pathPattern(template).test(path)) ??
    null
  );
}

function reviewedMutationPath(path) {
  return REVIEWED_MUTATION_PATHS.some(
    (template) => template === path || pathPattern(template).test(path),
  );
}

function isReadQueryAllowed(operationPath, search) {
  if (!search) return true;
  const template = reviewedReadPath(operationPath);
  const params = new URLSearchParams(search.slice(1));
  const entries = [...params.entries()];
  if (new Set(entries.map(([key]) => key)).size !== entries.length)
    return false;
  if (template === "/api/floors/{code}/info")
    return (
      entries.length === 1 &&
      entries[0][0] === "locale" &&
      ["ru", "en"].includes(entries[0][1])
    );
  if (template === "/api/bosses/invitations")
    return (
      entries.length === 2 &&
      params.get("direction") === "incoming" &&
      params.get("status") === "pending"
    );
  if (template === "/api/player-interactions/booster-requests/incoming")
    return entries.length === 1 && params.get("limit") === "100";
  if (["/api/friends", "/api/friends/requests/outgoing"].includes(template)) {
    const cursor = params.get("cursor");
    return (
      entries.every(([key]) => key === "limit" || key === "cursor") &&
      params.get("limit") === "100" &&
      entries.length <= 2 &&
      (cursor === null ||
        (cursor.length > 0 &&
          new TextEncoder().encode(cursor).byteLength <= 512))
    );
  }
  return false;
}

export const legacyDirectRouteResolver = async () => ({
  policy: "direct",
  routeEpoch: 0,
});

export function classifyGameOperation({ method, path }) {
  const normalizedMethod = String(method || "GET").toUpperCase();
  if (path === "/api/auth/telegram" && normalizedMethod === "POST")
    return "auth_issuance";
  if (normalizedMethod === "GET")
    return reviewedReadPath(path) ? "read" : "effect_unknown";
  if (normalizedMethod === "POST" && reviewedMutationPath(path))
    return "mutation";
  return "effect_unknown";
}

function validateRoute(route) {
  if (route == null) throw routeError("game_route_unresolved");
  if (!route || !["direct", "bridge_required"].includes(route.policy))
    throw routeError("game_route_unavailable");
  if (!Number.isSafeInteger(route.routeEpoch) || route.routeEpoch < 0)
    throw routeError("game_route_unavailable");
  if (route.policy === "direct") {
    if (route.activeDeviceId != null)
      throw routeError("game_route_unavailable");
    return route;
  }
  if (
    route.routeEpoch < 1 ||
    typeof route.activeDeviceId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      route.activeDeviceId,
    )
  )
    throw routeError("game_route_unavailable");
  return route;
}

function validateOperation(operation, method, path, upstreamPath, search) {
  if (
    !operation ||
    typeof operation.path !== "string" ||
    !operation.path.startsWith("/api/") ||
    operation.path.includes("?") ||
    operation.path.includes("#") ||
    !new RegExp(
      "^" +
        operation.path
          .split(/(\{[^}]+\})/u)
          .map((part) =>
            part.startsWith("{")
              ? "[A-Za-z0-9_$-]+"
              : part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"),
          )
          .join("") +
        "$",
      "u",
    ).test(path) ||
    (operation.allowsDevKey === true &&
      (method !== "POST" ||
        operation.path !== "/api/auth/dev-userid" ||
        path !== "/api/auth/dev-userid")) ||
    typeof upstreamPath !== "string" ||
    upstreamPath.replace(/%24/giu, "$") !== path ||
    /%(?!24)/iu.test(upstreamPath) ||
    String(operation.method || "GET").toUpperCase() !== method ||
    (operation.operationClass !==
      classifyGameOperation({ method, path: operation.path }) &&
      !(
        operation.operationClass === "identity_verification" &&
        method === "GET" &&
        operation.path === "/api/me" &&
        path === "/api/me" &&
        search === ""
      )) ||
    ![
      "read",
      "identity_verification",
      "mutation",
      "effect_unknown",
      "auth_issuance",
    ].includes(operation.operationClass) ||
    typeof search !== "string" ||
    search.length > 2048 ||
    (search && (!search.startsWith("?") || /[#\r\n]/u.test(search)))
  )
    throw routeError("game_operation_invalid", 400);
}

function validateGameAuthIssuance({ method, path, headers, body }) {
  if (
    method !== "POST" ||
    path !== "/api/auth/telegram" ||
    headers.get("authorization") !== null ||
    headers.get("content-type")?.split(";")[0] !== "application/json" ||
    typeof body !== "string" ||
    Buffer.byteLength(body) > 16 * 1024
  )
    throw routeError("game_auth_request_invalid", 400);
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw routeError("game_auth_request_invalid", 400);
  }
  const keys =
    payload && typeof payload === "object" && !Array.isArray(payload)
      ? Object.keys(payload)
      : [];
  const launchData = payload?.initData;
  if (
    keys.length !== 1 ||
    keys[0] !== "initData" ||
    typeof launchData !== "string" ||
    Buffer.byteLength(launchData) < 1 ||
    Buffer.byteLength(launchData) > 16 * 1024
  )
    throw routeError("game_auth_request_invalid", 400);
  return launchData;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validateBossAttackRequest({ method, path, headers, body }) {
  const battlePath = /^\/api\/bosses\/battles\/([A-Za-z0-9_-]+)\/attack$/u.exec(
    path,
  );
  const contentType = headers.get("content-type")?.split(";")[0].trim();
  if (
    method !== "POST" ||
    !battlePath ||
    !contentType ||
    contentType.toLowerCase() !== "application/json" ||
    body == null
  )
    throw routeError("game_operation_invalid", 400);

  let payload;
  try {
    const bodyText =
      typeof body === "string"
        ? body
        : body instanceof Uint8Array
          ? new TextDecoder("utf-8", { fatal: true }).decode(body)
          : body instanceof ArrayBuffer
            ? new TextDecoder("utf-8", { fatal: true }).decode(body)
            : null;
    if (bodyText == null) throw new Error("game_operation_invalid");
    payload = JSON.parse(bodyText);
  } catch {
    throw routeError("game_operation_invalid", 400);
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 1 ||
    !uuidPattern.test(payload.operationId || "")
  )
    throw routeError("game_operation_invalid", 400);
}

function bodySize(body) {
  if (body == null) return 0;
  if (typeof body === "string")
    return new TextEncoder().encode(body).byteLength;
  if (body instanceof Uint8Array) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (typeof Blob !== "undefined" && body instanceof Blob) return body.size;
  throw routeError("game_body_invalid", 400);
}

function validatedHeaders(input, operation) {
  const headers = new Headers(input);
  for (const name of headers.keys())
    if (!SAFE_UPSTREAM_HEADERS.has(name.toLowerCase()))
      throw routeError("game_headers_invalid", 400);
  const authorization = headers.get("authorization");
  if (
    authorization &&
    (authorization.length > 16_384 ||
      !/^Bearer [A-Za-z0-9._~-]+$/u.test(authorization))
  )
    throw routeError("game_headers_invalid", 400);
  if (headers.has("x-cargohustle-dev-key") && operation.allowsDevKey !== true)
    throw routeError("game_headers_invalid", 400);
  return headers;
}

/**
 * The only game HTTP dispatch boundary. A bridge route never falls back to the
 * direct transport after policy lookup, device, or tunnel failures.
 */
export function createGameApiClient({
  directTransport,
  bridgeTransport = null,
  resolveRoute,
  admitMutation = async () => null,
  admitAuthIssuance = async () => null,
  admitAuthBootstrap = async () => null,
  allowOperation = () => true,
  maxRequestDeadlineMs = MAX_REQUEST_DEADLINE_MS,
}) {
  if (typeof directTransport !== "function")
    throw new TypeError("game_direct_transport_required");
  if (typeof resolveRoute !== "function")
    throw new TypeError("game_route_resolver_required");
  if (
    !Number.isSafeInteger(maxRequestDeadlineMs) ||
    maxRequestDeadlineMs < 1 ||
    maxRequestDeadlineMs > MAX_REQUEST_DEADLINE_MS
  )
    throw new TypeError("game_api_request_deadline_invalid");

  let draining = false;
  let drainFlight = null;
  const activeDispatches = new Set();

  function ensureRunning() {
    if (draining) throw routeError("game_service_draining", 503);
  }

  function dispatch(transport, ...args) {
    ensureRunning();
    const result = Promise.resolve(transport(...args));
    activeDispatches.add(result);
    const settled = () => activeDispatches.delete(result);
    result.then(settled, settled);
    return result;
  }

  async function dispatchWithDeadline(transport, args, signal) {
    try {
      return await waitForSignal(dispatch(transport, ...args), signal);
    } catch (error) {
      ensureNotAborted(signal);
      throw error;
    }
  }

  function drain({ deadlineInMs = 35_000 } = {}) {
    if (
      !Number.isSafeInteger(deadlineInMs) ||
      deadlineInMs < 1 ||
      deadlineInMs > 35_000
    )
      throw new RangeError("game_api_drain_deadline_invalid");
    if (drainFlight) return drainFlight;
    draining = true;
    const active = [...activeDispatches];
    if (active.length === 0) {
      drainFlight = Promise.resolve(true);
      return drainFlight;
    }
    drainFlight = new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), deadlineInMs);
      Promise.allSettled(active).then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    return drainFlight;
  }

  return {
    drain,
    async request({
      operation,
      path,
      upstreamPath = path,
      search = "",
      method = "GET",
      headers,
      body,
      signal,
      context = {},
    }) {
      ensureRunning();
      ensureNotAborted(signal);
      const deadline = AbortSignal.timeout(maxRequestDeadlineMs);
      const requestSignal = signal
        ? AbortSignal.any([signal, deadline])
        : deadline;
      ensureNotAborted(requestSignal);
      const normalizedMethod = String(method).toUpperCase();
      validateOperation(
        operation,
        normalizedMethod,
        path,
        upstreamPath,
        search,
      );
      const safeHeaders = validatedHeaders(headers, operation);
      if (bodySize(body) > MAX_REQUEST_BODY_BYTES)
        throw routeError("game_body_too_large", 413);
      const transportHeaders = Object.fromEntries(
        [...safeHeaders].map(([name, value]) => [
          CANONICAL_HEADER_NAMES[name],
          value,
        ]),
      );
      const resolveCurrentRoute = async () => {
        try {
          return validateRoute(
            await waitForSignal(
              resolveRoute({
                accountId: context.accountId ?? null,
                authorization: safeHeaders.get("authorization"),
                ownerId: context.ownerId ?? null,
                authBootstrap: context.authBootstrap === true,
                authOperationId: context.authOperationId ?? null,
                consentGeneration: context.consentGeneration ?? null,
                expectedRouteEpoch: context.expectedRouteEpoch ?? null,
                expectedCredentialVersion:
                  context.expectedCredentialVersion ?? null,
                expectedDeviceId: context.expectedDeviceId ?? null,
                operation,
                path,
                signal: requestSignal,
              }),
              requestSignal,
            ),
          );
        } catch (error) {
          ensureNotAborted(requestSignal);
          if (
            typeof error?.code === "string" &&
            error.code.startsWith("game_route_")
          )
            throw error;
          throw routeError("game_route_unavailable");
        }
      };
      const route = await resolveCurrentRoute();
      const ensureRouteCurrent = async () => {
        const current = await resolveCurrentRoute();
        if (
          [
            "policy",
            "routeEpoch",
            "activeDeviceId",
            "playerId",
            "authBootstrap",
            "restoreBootstrap",
            "identityBootstrap",
          ].some((key) => current[key] !== route[key])
        )
          throw routeError("game_route_stale", 409);
      };
      ensureRunning();
      ensureNotAborted(requestSignal);

      const ensureOperationAllowed = () => {
        const allowed = allowOperation({
          accountId: route.playerId ?? context.accountId ?? null,
          operation,
          path,
          method: normalizedMethod,
          route,
        });
        if (allowed === "helper_paused")
          throw routeError("game_helper_paused", 409);
        if (allowed !== true)
          throw routeError("game_restore_confirmation_required", 409);
      };
      ensureOperationAllowed();

      if (
        (context.expectedRouteEpoch !== undefined &&
          context.expectedRouteEpoch !== route.routeEpoch) ||
        (context.expectedDeviceId !== undefined &&
          context.expectedDeviceId !== route.activeDeviceId)
      )
        throw routeError("game_route_stale", 409);
      if (
        route.policy === "bridge_required" &&
        ["read", "identity_verification"].includes(operation.operationClass) &&
        !isReadQueryAllowed(operation.path, search)
      )
        throw routeError("game_operation_invalid", 400);
      if (
        route.policy === "bridge_required" &&
        ["read", "identity_verification"].includes(operation.operationClass) &&
        body != null
      )
        throw routeError("game_operation_invalid", 400);
      if (
        route.policy === "bridge_required" &&
        reviewedReadPath(operation.path) === "/api/players/{playerId}" &&
        (typeof route.playerId !== "string" ||
          !/^[1-9]\d{0,15}$/u.test(route.playerId) ||
          !Number.isSafeInteger(Number(route.playerId)) ||
          path !== `/api/players/${route.playerId}`)
      )
        throw routeError("game_operation_invalid", 400);
      if (
        route.policy === "bridge_required" &&
        operation.operationClass === "mutation"
      )
        validateBossAttackRequest({
          method: normalizedMethod,
          path,
          headers: safeHeaders,
          body,
        });

      const request = {
        operation,
        path,
        upstreamPath,
        search,
        method: normalizedMethod,
        headers: safeHeaders,
        ...(body == null ? {} : { body }),
        signal: requestSignal,
        context: {
          accountId: context.accountId ?? null,
          routeEpoch: route.routeEpoch,
          ...(context.automationAttempt
            ? { automationAttempt: context.automationAttempt }
            : {}),
        },
      };
      if (route.policy === "direct") {
        if (
          context.authBootstrap === true &&
          operation.operationClass === "identity_verification"
        ) {
          if (
            normalizedMethod !== "GET" ||
            path !== "/api/me" ||
            search !== "" ||
            route.authBootstrap !== true ||
            route.routeEpoch !== 0 ||
            context.accountId != null ||
            typeof context.ownerId !== "string" ||
            !/^[1-9][0-9]{0,15}$/u.test(context.ownerId) ||
            !Number.isSafeInteger(Number(context.ownerId)) ||
            !uuidPattern.test(context.authOperationId || "") ||
            !Number.isSafeInteger(context.consentGeneration) ||
            context.consentGeneration < 1 ||
            context.expectedRouteEpoch !== 0 ||
            !Number.isSafeInteger(context.expectedCredentialVersion) ||
            context.expectedCredentialVersion < 0 ||
            context.expectedDeviceId !== undefined
          )
            throw routeError("game_auth_coordinator_required", 409);
          let admission;
          try {
            admission = await waitForSignal(
              admitAuthBootstrap({
                operation,
                route,
                context,
                launchData: null,
              }),
              requestSignal,
            );
          } catch {
            ensureNotAborted(requestSignal);
            throw routeError("game_auth_coordinator_required", 409);
          }
          ensureRunning();
          ensureNotAborted(requestSignal);
          if (!admission)
            throw routeError("game_auth_coordinator_required", 409);
          request.admission = admission;
        }
        if (operation.operationClass === "auth_issuance") {
          const launchData = validateGameAuthIssuance({
            method: normalizedMethod,
            path,
            headers: safeHeaders,
            body,
          });
          if (
            context.authBootstrap !== true ||
            route.authBootstrap !== true ||
            route.routeEpoch !== 0 ||
            context.accountId != null ||
            typeof context.ownerId !== "string" ||
            !/^[1-9][0-9]{0,15}$/u.test(context.ownerId) ||
            !Number.isSafeInteger(Number(context.ownerId)) ||
            !uuidPattern.test(context.authOperationId || "") ||
            !Number.isSafeInteger(context.consentGeneration) ||
            context.consentGeneration < 1 ||
            context.expectedRouteEpoch !== 0 ||
            !Number.isSafeInteger(context.expectedCredentialVersion) ||
            context.expectedCredentialVersion < 0 ||
            context.expectedDeviceId !== undefined
          )
            throw routeError("game_auth_coordinator_required", 409);
          let admission;
          try {
            admission = await waitForSignal(
              admitAuthBootstrap({
                operation,
                route,
                context,
                launchData,
              }),
              requestSignal,
            );
          } catch {
            ensureNotAborted(requestSignal);
            throw routeError("game_auth_coordinator_required", 409);
          }
          ensureRunning();
          ensureNotAborted(requestSignal);
          if (!admission)
            throw routeError("game_auth_coordinator_required", 409);
          request.admission = admission;
        }
        if (
          route.identityBootstrap === true &&
          (normalizedMethod !== "GET" || path !== "/api/me" || search !== "")
        )
          throw routeError("game_identity_required", 401);
        await ensureRouteCurrent();
        ensureRunning();
        ensureNotAborted(requestSignal);
        ensureOperationAllowed();
        return dispatchWithDeadline(
          directTransport,
          [
            `${CARGO_ORIGIN}${upstreamPath}${search}`,
            {
              method: normalizedMethod,
              headers: transportHeaders,
              ...(body == null ? {} : { body }),
              redirect: "manual",
              cache: "no-store",
              signal: requestSignal,
            },
          ],
          requestSignal,
        );
      }

      if (operation.operationClass === "auth_issuance") {
        const launchData = validateGameAuthIssuance({
          method: normalizedMethod,
          path,
          headers: safeHeaders,
          body,
        });
        if (
          !uuidPattern.test(context.authOperationId || "") ||
          typeof context.ownerId !== "string" ||
          !/^[1-9][0-9]{0,15}$/u.test(context.ownerId) ||
          !Number.isSafeInteger(Number(context.ownerId)) ||
          !Number.isSafeInteger(context.consentGeneration) ||
          context.consentGeneration < 1 ||
          !Number.isSafeInteger(context.expectedRouteEpoch) ||
          context.expectedRouteEpoch < 1 ||
          !uuidPattern.test(context.expectedDeviceId || "") ||
          route.policy !== "bridge_required"
        )
          throw routeError("game_auth_coordinator_required", 409);
        let admission;
        try {
          admission = await waitForSignal(
            admitAuthIssuance({
              operation,
              route,
              context,
              launchData,
            }),
            requestSignal,
          );
        } catch {
          ensureNotAborted(requestSignal);
          throw routeError("game_auth_coordinator_required", 409);
        }
        ensureRunning();
        ensureNotAborted(requestSignal);
        if (!admission) throw routeError("game_auth_coordinator_required", 409);
        request.admission = admission;
      }
      if (operation.operationClass === "effect_unknown")
        throw routeError("bridge_effect_policy_unknown", 409);
      if (operation.operationClass === "mutation") {
        let admission;
        try {
          admission = await waitForSignal(
            admitMutation({ operation, route, request }),
            requestSignal,
          );
        } catch {
          ensureNotAborted(requestSignal);
          throw routeError("bridge_mutation_not_admitted", 409);
        }
        ensureRunning();
        ensureNotAborted(requestSignal);
        if (!admission) throw routeError("bridge_mutation_not_admitted", 409);
        request.admission = admission;
      }
      if (typeof bridgeTransport !== "function")
        throw routeError("bridge_device_unavailable", 503);
      await ensureRouteCurrent();
      ensureRunning();
      ensureNotAborted(requestSignal);
      ensureOperationAllowed();
      return dispatchWithDeadline(
        bridgeTransport,
        [{ ...request, route }],
        requestSignal,
      );
    },
  };
}
