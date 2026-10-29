import { validateTelegramInitData } from "../telegram/telegram-init-data.mjs";
import { resolveBridgeBrowserSession } from "./browser-session.mjs";

const MAX_BYTES = 8192;
const headers = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers });

async function readBody(request) {
  if (
    !/^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") || "",
    )
  )
    throw new Error("invalid_request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("invalid_request");
    }
    chunks.push(value);
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
  );
}

/** Not exposed by default. Caller must provide a trusted peer IP and limiter. */
export function createBridgeDeviceHttp({
  service,
  accountService,
  browserSessions,
  accounts,
  botToken,
  origin,
  consume,
  now = Date.now,
} = {}) {
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    throw new TypeError("invalid_bridge_origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== origin ||
    !botToken ||
    typeof consume !== "function" ||
    !service
  )
    throw new TypeError("invalid_bridge_http_dependencies");
  return async (request, clientIp) => {
    if (request.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    const path = new URL(request.url).pathname;
    if (!new Set(["/api/bridge/device", "/api/bridge/redeem"]).has(path))
      return json(404, { error: "not_found" });
    if (typeof clientIp !== "string" || !clientIp)
      return json(429, { error: "rate_limited" });
    try {
      if ((await consume(clientIp, path)) !== true)
        return json(429, { error: "rate_limited" });
    } catch {
      return json(503, { error: "bridge_unavailable" });
    }
    let body;
    try {
      body = await readBody(request);
    } catch {
      return json(400, { error: "invalid_request" });
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      return json(400, { error: "invalid_request" });
    try {
      if (path === "/api/bridge/redeem") {
        if (Object.keys(body).sort().join(",") !== "invitation")
          return json(400, { error: "invalid_request" });
        return json(200, service.redeemInvitation(body.invitation));
      }
      if (request.headers.get("origin") !== origin)
        return json(403, { error: "forbidden" });
      if (
        body.operation === "renew" &&
        Object.keys(body).sort().join(",") === "operation"
      ) {
        if (!browserSessions || !accounts)
          return json(503, { error: "bridge_unavailable" });
        const authorization = request.headers.get("authorization") || "";
        if (!authorization.startsWith("Bearer "))
          return json(401, { error: "not_authorized" });
        const token = authorization.slice(7);
        const verified = browserSessions.verify(token);
        const binding = resolveBridgeBrowserSession(token, {
          sessions: browserSessions,
          accounts,
          devices: service,
        });
        if (!verified || !binding)
          return json(401, { error: "not_authorized" });
        const device = service.listDevice(binding.owner);
        return json(200, {
          session: browserSessions.issue(
            binding.owner,
            binding.revision,
            device,
            verified.until,
          ),
        });
      }
      const owner = validateTelegramInitData(body.initData, botToken, {
        now: now(),
        maxAgeSeconds: 300,
      });
      if (!owner) return json(401, { error: "not_authorized" });
      if (
        body.operation === "invite" &&
        Object.keys(body).sort().join(",") === "initData,operation"
      )
        return json(200, service.issueInvitation(owner.id));
      if (
        body.operation === "list" &&
        Object.keys(body).sort().join(",") === "initData,operation"
      )
        return json(200, { device: service.listDevice(owner.id) });
      if (
        body.operation === "status" &&
        Object.keys(body).sort().join(",") === "initData,operation"
      ) {
        if (
          typeof service.status !== "function" ||
          typeof accountService?.status !== "function"
        )
          return json(503, { error: "bridge_unavailable" });
        return json(200, {
          device: await service.status(owner.id),
          account: accountService.status(owner.id),
        });
      }
      if (
        body.operation === "session" &&
        Object.keys(body).sort().join(",") === "initData,operation"
      ) {
        if (!browserSessions || !accounts)
          return json(503, { error: "bridge_unavailable" });
        const device = service.listDevice(owner.id);
        const revision = accounts.getRevision(owner.id);
        if (!device || revision < 1)
          return json(409, { error: "account_not_configured" });
        return json(200, {
          session: browserSessions.issue(owner.id, revision, device),
        });
      }
      if (
        body.operation === "profile" &&
        Object.keys(body).sort().join(",") === "initData,operation"
      ) {
        if (typeof accountService?.profile !== "function")
          return json(503, { error: "bridge_unavailable" });
        return json(200, await accountService.profile(owner.id));
      }
      if (
        body.operation === "bind" &&
        Object.keys(body).sort().join(",") === "accessToken,initData,operation"
      ) {
        if (typeof accountService?.bind !== "function")
          return json(503, { error: "bridge_unavailable" });
        if (
          typeof body.accessToken !== "string" ||
          !/^[A-Za-z0-9._~-]+$/.test(body.accessToken)
        )
          return json(400, { error: "invalid_game_token" });
        return json(
          200,
          await accountService.bind(owner.id, `Bearer ${body.accessToken}`),
        );
      }
      if (
        body.operation === "revoke" &&
        Object.keys(body).sort().join(",") === "deviceId,initData,operation"
      )
        return json(200, { revoked: service.revoke(owner.id, body.deviceId) });
      return json(400, { error: "invalid_request" });
    } catch (error) {
      const allowed = new Set([
        "invalid_invitation",
        "device_already_active",
        "invalid_device",
        "invalid_game_token",
        "account_not_configured",
        "device_unavailable",
        "device_offline",
        "device_changed",
        "account_mismatch",
        "account_already_bound",
        "direct_requests_in_flight",
        "binding_changed",
        "profile_invalid",
        "profile_unavailable",
      ]);
      return allowed.has(error?.code)
        ? json(409, { error: error.code })
        : json(503, { error: "bridge_unavailable" });
    }
  };
}
