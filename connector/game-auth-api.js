import { normalizeActiveBossBattle } from "../shared/active-boss-battle.js";
import { createHash } from "node:crypto";

const UPSTREAM = "https://cargohustle.online";
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
    if (bytes > 16384) {
      await reader.cancel();
      throw new Error();
    }
    body += decoder.decode(value, { stream: true });
  }
  return JSON.parse(body + decoder.decode());
}

export function createConnectorApi({
  appParams,
  wikiOrigins,
  fetcher = fetch,
  accountSessions,
  withGameSessionLease,
}) {
  if (
    withGameSessionLease !== undefined &&
    typeof withGameSessionLease !== "function"
  )
    throw new TypeError("invalid_connector_session_guard");
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
      return json({
        apiId: Number(apiId),
        apiHash,
        wikiOrigins,
        ...(withGameSessionLease ? { bridgePolicyRequired: true } : {}),
      });
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
          !Object.keys(data).every((key) =>
            [
              "wikiInitData",
              "wikiProof",
              "action",
              "ticket",
              "accessToken",
              "playerLevel",
              "currentExp",
              "expToNextLevel",
            ].includes(key),
          )
        )
          throw new Error();
        if (!accountSessions)
          return json({ error: "session_store_unavailable" }, 503);
        try {
          return json(await accountSessions(data));
        } catch (error) {
          const allowed = [
            "invalid_wiki_identity",
            "invalid_request",
            "invalid_game_session",
            "game_account_mismatch",
            "session_changed",
            "game_unavailable",
            "bridge_route_required",
          ];
          const code = allowed.includes(error?.message)
            ? error.message
            : "session_store_unavailable";
          return json(
            { error: code },
            code === "game_unavailable"
              ? 502
              : code === "session_store_unavailable"
                ? 503
                : code === "invalid_wiki_identity"
                  ? 401
                  : 409,
          );
        }
      }
      if (
        !data ||
        (withGameSessionLease
          ? Object.keys(data).sort().join(",") !== "initData,wikiInitData" ||
            typeof data.wikiInitData !== "string" ||
            !data.wikiInitData
          : Object.keys(data).length !== 1) ||
        typeof data.initData !== "string"
      )
        throw new Error();
      const params = new URLSearchParams(data.initData);
      if (
        !/^[a-f0-9]{64}$/i.test(params.get("hash") || "") ||
        !params.get("user") ||
        !params.get("auth_date")
      )
        throw new Error();
    } catch {
      return json({ error: "invalid_request" }, 400);
    }
    const exchange = async (registerVerified, leaseContext) => {
      let authResponseReceived = false;
      try {
        const result = await fetcher(UPSTREAM + "/api/auth/telegram", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({ initData: data.initData }),
          credentials: "omit",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          ...(leaseContext
            ? {
                gameBootstrap: {
                  owner: leaseContext.owner,
                  leaseId: leaseContext.leaseId,
                  step: "telegram_auth",
                  attempt: 1,
                  credentialDigest: null,
                },
              }
            : {}),
        });
        authResponseReceived = true;
        if (result.status >= 500) {
          await result.body?.cancel();
          return json({ error: "game_result_unknown" }, 502);
        }
        if (!result.ok) {
          await result.body?.cancel();
          return json(
            {
              error: result.status === 429 ? "try_later" : "game_auth_rejected",
            },
            result.status === 429 ? 429 : 401,
          );
        }
        const body = await result.json();
        if (
          typeof body.accessToken !== "string" ||
          body.accessToken.length > 16384 ||
          !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
            body.accessToken,
          )
        )
          return json({ error: "invalid_game_response" }, 502);
        if (registerVerified) {
          if (body.accessToken.length > 8185)
            return json({ error: "invalid_game_response" }, 502);
          const credentialDigest = createHash("sha256")
            .update(`Bearer ${body.accessToken}`)
            .digest("hex");
          if (leaseContext) await leaseContext.bindCredential(credentialDigest);
          const me = await fetcher(UPSTREAM + "/api/me", {
            method: "GET",
            headers: {
              Accept: "application/json",
              Authorization: `Bearer ${body.accessToken}`,
            },
            credentials: "omit",
            redirect: "error",
            signal: AbortSignal.timeout(15000),
            ...(leaseContext
              ? {
                  gameBootstrap: {
                    owner: leaseContext.owner,
                    leaseId: leaseContext.leaseId,
                    step: "profile",
                    attempt: 1,
                    credentialDigest,
                  },
                }
              : {}),
          });
          if (!me.ok) {
            await me.body?.cancel();
            leaseContext?.markKnownProfileFailure();
            return json({ error: "game_unavailable" }, 502);
          }
          const profile = await me.json();
          const launchUser = JSON.parse(
            new URLSearchParams(data.initData).get("user"),
          );
          const owner =
            typeof profile?.telegramId === "number" &&
            Number.isSafeInteger(profile.telegramId)
              ? String(profile.telegramId)
              : typeof profile?.telegramId === "string" &&
                  /^[1-9][0-9]{0,15}$/.test(profile.telegramId)
                ? profile.telegramId
                : null;
          if (
            !Number.isSafeInteger(launchUser?.id) ||
            String(launchUser.id) !== owner ||
            !Number.isSafeInteger(profile?.playerId) ||
            profile.playerId <= 0
          )
            return json({ error: "game_unavailable" }, 502);
          await registerVerified(String(profile.playerId), credentialDigest);
        }
        const playerLevel = body.exp?.level;
        const currentExp = body.exp?.currentExp;
        const expToNextLevel = body.exp?.expToNextLevel;
        const activeBossBattle = normalizeActiveBossBattle(
          body.activeBossBattle,
        );
        const experience =
          Number.isSafeInteger(currentExp) &&
          currentExp >= 0 &&
          Number.isSafeInteger(expToNextLevel) &&
          expToNextLevel > 0
            ? { currentExp, expToNextLevel }
            : {};
        // Only the token, level progress, and minimal active-battle reference
        // needed by the Wiki leave this handler. Other profile data stays private.
        return json({
          accessToken: body.accessToken,
          ...(Number.isSafeInteger(playerLevel) && playerLevel > 0
            ? { playerLevel }
            : {}),
          ...experience,
          ...(activeBossBattle ? { activeBossBattle } : {}),
        });
      } catch (error) {
        // The internal response may have been lost after the auth POST reached
        // the game. A fresh launch must not automatically repeat that POST.
        return json(
          {
            error:
              error?.notDispatched && !authResponseReceived
                ? "game_unavailable"
                : "game_result_unknown",
          },
          502,
        );
      }
    };
    if (!withGameSessionLease) return exchange();
    try {
      return await withGameSessionLease(
        data.wikiInitData,
        data.initData,
        exchange,
      );
    } catch (error) {
      if (error?.code === "bridge_route_required")
        return json({ error: "bridge_route_required" }, 409);
      if (
        ["invalid_wiki_identity", "invalid_game_identity"].includes(
          error?.message,
        )
      )
        return json({ error: "invalid_wiki_identity" }, 401);
      return json({ error: "game_unavailable" }, 503);
    }
  };
}
