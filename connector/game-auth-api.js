const MAX_BODY_BYTES = 20 * 1024;
const responseHeaders = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: responseHeaders });

async function limitedJson(request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    throw new Error();
  const reader = request.body?.getReader();
  if (!reader) throw new Error();
  const decoder = new TextDecoder();
  let bytes = 0,
    body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error();
    }
    body += decoder.decode(value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}

async function limitedResponseJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("invalid_wiki_response");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let body = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_BODY_BYTES) {
      await reader.cancel();
      throw new Error("invalid_wiki_response");
    }
    body += decoder.decode(value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}

function normalizeWikiOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.username ||
      url.password
    )
      return null;
    if (url.protocol === "https:") return url.origin;
    if (
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
      return url.origin;
    return null;
  } catch {
    return null;
  }
}

function hexBytes(value) {
  return Uint8Array.from(value.match(/.{2}/gu) || [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

async function verifyWikiLaunchIdentity(initData, verificationKey) {
  if (
    typeof verificationKey !== "string" ||
    !/^[a-f0-9]{64}$/iu.test(verificationKey)
  )
    return { error: "wiki_identity_unavailable" };
  if (
    typeof initData !== "string" ||
    initData.length < 1 ||
    initData.length > 8192
  )
    return { error: "invalid_wiki_identity" };
  try {
    const params = new URLSearchParams(initData);
    const fields = [...params.keys()];
    if (new Set(fields).size !== fields.length)
      return { error: "invalid_wiki_identity" };
    const hash = params.get("hash");
    const issuedAt = Number(params.get("auth_date"));
    const now = Date.now();
    if (
      !/^[a-f0-9]{64}$/iu.test(hash || "") ||
      !Number.isInteger(issuedAt) ||
      issuedAt * 1000 > now + 30_000 ||
      now - issuedAt * 1000 > 300_000
    )
      return { error: "invalid_wiki_identity" };
    params.delete("hash");
    const check = [...params.entries()]
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, value]) => `${key}=${value}`)
      .join("\n");
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      hexBytes(verificationKey),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    if (
      !(await globalThis.crypto.subtle.verify(
        "HMAC",
        key,
        hexBytes(hash),
        new TextEncoder().encode(check),
      ))
    )
      return { error: "invalid_wiki_identity" };
    const user = JSON.parse(params.get("user") || "null");
    if (!Number.isSafeInteger(user?.id) || user.id <= 0)
      return { error: "invalid_wiki_identity" };
    return { ownerId: String(user.id) };
  } catch {
    return { error: "invalid_wiki_identity" };
  }
}

async function ownerRoutePolicy({ wikiInitData, wikiOrigins, wikiFetcher }) {
  const wikiOrigin = wikiOrigins.map(normalizeWikiOrigin).find(Boolean);
  if (!wikiOrigin) return { error: "bridge_route_unavailable" };
  const requestId = globalThis.crypto.randomUUID();
  let response;
  try {
    response = await wikiFetcher(`${wikiOrigin}/api/bridge`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: wikiOrigin,
      },
      body: JSON.stringify({
        operation: "device.list",
        requestId,
        initData: wikiInitData,
      }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { error: "bridge_route_unavailable" };
  }
  if (response.status === 401) return { error: "invalid_wiki_identity" };
  if (response.status === 429) return { error: "try_later" };
  if (!response.ok) return { error: "bridge_route_unavailable" };
  try {
    const result = await limitedResponseJson(response);
    if (
      result.requestId !== requestId ||
      result.operation !== "device.list" ||
      !Array.isArray(result.devices) ||
      (result.routePolicy !== null &&
        (!result.routePolicy ||
          !["direct", "bridge_required"].includes(result.routePolicy.policy) ||
          !Number.isSafeInteger(result.routePolicy.routeEpoch) ||
          result.routePolicy.routeEpoch < 0))
    )
      return { error: "bridge_route_unavailable" };
    return { routePolicy: result.routePolicy };
  } catch {
    return { error: "bridge_route_unavailable" };
  }
}

async function wikiBootstrapRequest({
  operation,
  wikiInitData,
  cargoLaunchData,
  wikiOrigins,
  wikiFetcher,
}) {
  const wikiOrigin = wikiOrigins.map(normalizeWikiOrigin).find(Boolean);
  if (!wikiOrigin) throw new Error("bridge_route_unavailable");
  if (
    ![
      "game_auth.bootstrap",
      "game_auth.bootstrap.status",
      "game_auth.logout",
    ].includes(operation)
  )
    throw new Error("bridge_route_unavailable");
  const requestId = globalThis.crypto.randomUUID();
  let response;
  try {
    response = await wikiFetcher(`${wikiOrigin}/api/bridge`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: wikiOrigin,
      },
      body: JSON.stringify({
        operation,
        requestId,
        ...(operation === "game_auth.bootstrap" ? { cargoLaunchData } : {}),
        initData: wikiInitData,
      }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(
        ["game_auth.bootstrap", "game_auth.logout"].includes(operation)
          ? 30_000
          : 5000,
      ),
    });
  } catch {
    throw new Error("bridge_route_unavailable");
  }
  let result;
  try {
    result = await limitedResponseJson(response);
  } catch {
    throw new Error("bridge_route_unavailable");
  }
  if (response.status === 401) throw new Error("invalid_wiki_identity");
  if (response.status === 429) throw new Error("try_later");
  if (!response.ok) {
    const allowed = new Set([
      "game_account_mismatch",
      "game_auth_busy",
      "game_auth_generation_conflict",
      "game_auth_operation_not_found",
      "game_auth_operation_stale",
      "game_auth_generation_conflict",
      "game_auth_unavailable",
      "game_account_binding_required",
      "credential_unavailable",
    ]);
    if (!allowed.has(result?.error))
      throw new Error("bridge_route_unavailable");
    const error = new Error(result.error);
    error.status = response.status;
    throw error;
  }
  const bootstrapStatuses = [
    "created",
    "launch_requested",
    "prepared",
    "exchange_pending",
    "verification_pending",
    "credential_stored",
    "ready",
    "auth_outcome_unknown",
    "failed",
    "cancelled",
  ];
  const validStatuses =
    operation === "game_auth.logout"
      ? ["logout_pending", "logged_out"]
      : operation === "game_auth.bootstrap.status"
        ? [...bootstrapStatuses, "logout_pending", "logged_out"]
        : bootstrapStatuses;
  if (
    result.requestId !== requestId ||
    result.operation !== operation ||
    typeof result.operationId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      result.operationId,
    ) ||
    !validStatuses.includes(result.status) ||
    Object.hasOwn(result, "accessToken")
  )
    throw new Error("bridge_route_unavailable");
  if (operation === "game_auth.logout") {
    if (result.status !== "logged_out")
      throw new Error("game_logout_unavailable");
    return { status: "disconnected", serverManaged: true };
  }
  if (result.status === "ready")
    return { status: "connected", serverManaged: true };
  if (operation === "game_auth.bootstrap.status") {
    if (
      [
        "created",
        "launch_requested",
        "prepared",
        "exchange_pending",
        "verification_pending",
        "credential_stored",
      ].includes(result.status)
    )
      return { status: "pending" };
    if (["failed", "cancelled", "logged_out"].includes(result.status))
      return { status: "login-required" };
    if (result.status === "auth_outcome_unknown")
      return { status: "login-required", consentRequired: true };
  }
  if (result.status === "failed" && result.reason === "invalid_game_session")
    throw new Error("game_auth_rejected");
  if (result.status === "auth_outcome_unknown")
    throw new Error("game_auth_unknown");
  throw new Error("game_unavailable");
}

async function wikiRestoreExchange({
  wikiInitData,
  cargoLaunchData,
  restoreRequestId,
  wikiOrigins,
  wikiFetcher,
}) {
  const wikiOrigin = wikiOrigins.map(normalizeWikiOrigin).find(Boolean);
  if (!wikiOrigin) throw new Error("bridge_route_unavailable");
  let response;
  try {
    response = await wikiFetcher(`${wikiOrigin}/api/bridge`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: wikiOrigin,
      },
      body: JSON.stringify({
        operation: "restore.exchange",
        requestId: restoreRequestId,
        cargoLaunchData,
        initData: wikiInitData,
      }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new Error("game_auth_unknown");
  }
  let result;
  try {
    result = await limitedResponseJson(response);
  } catch {
    throw new Error("game_auth_unknown");
  }
  if (response.status === 401) throw new Error("invalid_wiki_identity");
  if (response.status === 429) throw new Error("try_later");
  if (!response.ok) {
    const error = new Error(
      [
        "game_auth_busy",
        "game_auth_generation_conflict",
        "game_auth_operation_stale",
        "credential_unavailable",
        "game_account_mismatch",
      ].includes(result?.error)
        ? result.error
        : "game_auth_unknown",
    );
    error.status = response.status;
    throw error;
  }
  if (
    !result ||
    Object.keys(result).length !== 3 ||
    result.operation !== "restore.exchange" ||
    result.requestId !== restoreRequestId ||
    ![
      "review_required",
      "exchange_pending",
      "verification_pending",
      "auth_outcome_unknown",
      "failed",
    ].includes(result.status)
  )
    throw new Error("game_auth_unknown");
  if (result.status === "review_required")
    return { status: "connected", serverManaged: true };
  if (result.status === "auth_outcome_unknown")
    throw new Error("game_auth_unknown");
  if (result.status === "failed") throw new Error("game_auth_rejected");
  return { status: "pending" };
}

export function createConnectorApi({
  appParams,
  wikiOrigins = [],
  wikiVerificationKey = "",
  wikiFetcher = fetch,
  accountSessions,
}) {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/config" && request.method === "GET") {
      const { apiId, apiHash } = await appParams();
      if (
        !Number.isSafeInteger(Number(apiId)) ||
        Number(apiId) <= 0 ||
        Number(apiId) === 17349 ||
        !/^[a-f0-9]{32}$/i.test(apiHash || "")
      )
        return json({ error: "connection_unavailable" }, 503);
      // Application parameters are necessarily visible to the browser client.
      // Never configure production with keys approved only for local research.
      return json({ apiId: Number(apiId), apiHash, wikiOrigins });
    }
    if (!["/api/game-session", "/api/account-session"].includes(url.pathname))
      return json({ error: "unknown_route" }, 404);
    if (request.method !== "POST")
      return json({ error: "method_not_allowed" }, 405);
    if (request.headers.get("origin") !== url.origin || url.search)
      return json({ error: "origin_rejected" }, 403);
    let data;
    try {
      data = await limitedJson(request);
      if (url.pathname === "/api/account-session") {
        if (
          !data ||
          typeof data !== "object" ||
          Array.isArray(data) ||
          !["restore", "save", "logout"].includes(data.action)
        )
          throw new Error();
        // Legacy records are never restored or saved as game sessions. Only a
        // proof-verified logout reaches the old store to replace its record
        // with a tokenless tombstone. New game auth lives in Wiki storage.
        if (data.action === "restore")
          return json({ status: "login-required" });
        if (data.action === "save")
          return json({ error: "game_auth_server_managed_required" }, 409);
        if (
          !Object.keys(data).every((key) =>
            ["wikiInitData", "wikiProof", "action"].includes(key),
          )
        )
          throw new Error();
        if (!accountSessions)
          return json({ error: "session_store_unavailable" }, 503);
        if (
          (Object.hasOwn(data, "wikiInitData") &&
            (typeof data.wikiInitData !== "string" ||
              data.wikiInitData.length < 1 ||
              data.wikiInitData.length > 8192)) ||
          (Object.hasOwn(data, "wikiProof") &&
            (typeof data.wikiProof !== "string" ||
              data.wikiProof.length < 1 ||
              data.wikiProof.length > 8192)) ||
          (!data.wikiInitData && !data.wikiProof)
        )
          return json({ error: "invalid_wiki_identity" }, 401);
        try {
          return json(await accountSessions(data));
        } catch (error) {
          const code =
            error?.message === "invalid_wiki_identity"
              ? "invalid_wiki_identity"
              : "session_store_unavailable";
          return json(
            { error: code },
            code === "invalid_wiki_identity" ? 401 : 503,
          );
        }
      }
      if (
        !data ||
        Object.keys(data).some(
          (key) =>
            ![
              "action",
              "initData",
              "wikiInitData",
              "restoreRequestId",
            ].includes(key),
        ) ||
        (data.action !== undefined &&
          !["status", "logout", "restore"].includes(data.action)) ||
        (data.action === "restore"
          ? typeof data.restoreRequestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              data.restoreRequestId,
            )
          : Object.hasOwn(data, "restoreRequestId")) ||
        (!["status", "logout"].includes(data.action) &&
          typeof data.initData !== "string")
      )
        throw new Error();
      if (
        typeof data.wikiInitData !== "string" ||
        data.wikiInitData.length < 1 ||
        data.wikiInitData.length > 8192
      )
        return json({ error: "invalid_wiki_identity" }, 401);
      if (!["status", "logout"].includes(data.action)) {
        if (
          typeof data.initData !== "string" ||
          data.initData.length < 1 ||
          data.initData.length > 8192
        )
          throw new Error();
        const params = new URLSearchParams(data.initData);
        const cargoFields = [...params.keys()];
        if (
          new Set(cargoFields).size !== cargoFields.length ||
          !/^[a-f0-9]{64}$/i.test(params.get("hash") || "") ||
          !params.get("user") ||
          !params.get("auth_date")
        )
          throw new Error();
        const user = JSON.parse(params.get("user"));
        if (!Number.isSafeInteger(user?.id) || user.id <= 0) throw new Error();
      }
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const wikiIdentity = await verifyWikiLaunchIdentity(
      data.wikiInitData,
      wikiVerificationKey,
    );
    if (wikiIdentity.error)
      return json(
        {
          error:
            wikiIdentity.error === "wiki_identity_unavailable"
              ? "bridge_route_unavailable"
              : wikiIdentity.error,
        },
        wikiIdentity.error === "wiki_identity_unavailable" ? 503 : 401,
      );
    if (
      !["status", "logout"].includes(data.action) &&
      String(
        JSON.parse(new URLSearchParams(data.initData).get("user") || "null")
          ?.id,
      ) !== wikiIdentity.ownerId
    )
      return json({ error: "game_account_mismatch" }, 409);
    if (data.action === "status") {
      try {
        return json(
          await wikiBootstrapRequest({
            operation: "game_auth.bootstrap.status",
            wikiInitData: data.wikiInitData,
            wikiOrigins,
            wikiFetcher,
          }),
        );
      } catch (error) {
        if (error?.message === "game_auth_operation_not_found")
          return json({ status: "login-required" });
        return json(
          { error: error?.message || "bridge_route_unavailable" },
          error?.status ||
            (error?.message === "invalid_wiki_identity"
              ? 401
              : error?.message === "try_later"
                ? 429
                : 503),
        );
      }
    }
    if (data.action === "logout") {
      try {
        return json(
          await wikiBootstrapRequest({
            operation: "game_auth.logout",
            wikiInitData: data.wikiInitData,
            wikiOrigins,
            wikiFetcher,
          }),
        );
      } catch (error) {
        return json(
          {
            error:
              error?.message === "game_auth_unknown"
                ? "game_auth_unknown"
                : error?.message || "bridge_route_unavailable",
          },
          error?.status ||
            (error?.message === "invalid_wiki_identity"
              ? 401
              : error?.message === "try_later"
                ? 429
                : error?.message === "game_auth_unknown"
                  ? 409
                  : 503),
        );
      }
    }
    if (data.action === "restore") {
      try {
        return json(
          await wikiRestoreExchange({
            wikiInitData: data.wikiInitData,
            cargoLaunchData: data.initData,
            restoreRequestId: data.restoreRequestId,
            wikiOrigins,
            wikiFetcher,
          }),
        );
      } catch (error) {
        return json(
          { error: error?.message || "game_auth_unknown" },
          error?.status ||
            (error?.message === "invalid_wiki_identity"
              ? 401
              : error?.message === "try_later"
                ? 429
                : 503),
        );
      }
    }
    const route = await ownerRoutePolicy({
      wikiInitData: data.wikiInitData,
      wikiOrigins,
      wikiFetcher,
    });
    if (route.error)
      return json(
        { error: route.error },
        route.error === "invalid_wiki_identity"
          ? 401
          : route.error === "try_later"
            ? 429
            : 503,
      );
    if (route.routePolicy?.policy === "bridge_required")
      return json({ error: "bridge_auth_required" }, 409);
    try {
      return json(
        await wikiBootstrapRequest({
          operation: "game_auth.bootstrap",
          wikiInitData: data.wikiInitData,
          cargoLaunchData: data.initData,
          wikiOrigins,
          wikiFetcher,
        }),
      );
    } catch (error) {
      return json(
        {
          error:
            error?.message === "game_auth_unknown"
              ? "game_auth_unknown"
              : error?.message || "bridge_route_unavailable",
        },
        error?.status ||
          (error?.message === "invalid_wiki_identity"
            ? 401
            : error?.message === "try_later"
              ? 429
              : error?.message === "game_auth_rejected"
                ? 401
                : error?.message === "game_auth_unknown"
                  ? 409
                  : 503),
      );
    }
  };
}
