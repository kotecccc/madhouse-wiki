import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import {
  parseInternalRequest,
  parseInternalResponse,
} from "./protocol-v1/internal-api.mjs";
import { signOwnerProof } from "./protocol-v1/owner-proof.mjs";
import { validateTelegramInitData } from "../telegram/telegram-init-data.mjs";

const MAX_BODY_BYTES = 20 * 1024;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const OWNER_OPERATIONS = new Set([
  "device.pair.approve",
  "device.list",
  "device.revoke",
  "route.select",
  "game_account.bind",
  "game_auth.start",
  "game_auth.status",
  "game_auth.cancel",
  "game_auth.logout",
  "game_auth.bootstrap",
  "game_auth.bootstrap.status",
  "restore.confirm",
  "restore.challenge",
  "restore.exchange",
  "restore.status",
  "restore.review",
  "restore.resume",
  "restore.cancel_prepared",
  "restore.ack_unknown",
]);
const PUBLIC_ERRORS = new Set([
  "invalid_request",
  "not_authorized",
  "pairing_not_found",
  "pairing_expired",
  "pairing_already_pending",
  "idempotency_conflict",
  "device_already_registered",
  "device_limit_reached",
  "device_history_limit_reached",
  "pairing_code_invalid",
  "device_generation_conflict",
  "device_generation_exhausted",
  "owner_proof_unavailable",
  "game_account_binding_required",
  "route_epoch_conflict",
  "route_selection_unavailable",
  "route_selection_pause_failed",
  "device_not_found",
  "device_revoked",
  "invalid_game_session",
  "game_account_mismatch",
  "game_account_binding_conflict",
  "game_account_already_bound",
  "game_account_binding_unavailable",
  "game_auth_busy",
  "game_auth_generation_conflict",
  "game_auth_operation_not_found",
  "game_auth_operation_stale",
  "game_auth_unavailable",
  "game_auth_credential_invalid",
  "route_stale",
  "credential_unavailable",
  "device_route_unavailable",
  "device_route_inactive",
  "device_challenge_clock_exhausted",
  "device_challenge_unavailable",
  "device_challenge_limit",
  "device_session_unavailable",
  "device_challenge_not_found",
  "device_challenge_replayed",
  "device_challenge_expired",
  "device_proof_invalid",
  "device_session_clock_exhausted",
]);
const RATE_LIMITS = Object.freeze({
  "device.pair.start": [6, 10 * 60_000],
  "device.pair.status": [90, 60_000],
  "device.pair.cancel": [6, 10 * 60_000],
  "device.pair.approve": [20, 10 * 60_000],
  "device.list": [120, 60_000],
  "device.revoke": [10, 10 * 60_000],
  "route.select": [20, 10 * 60_000],
  "game_account.bind": [6, 10 * 60_000],
  "game_auth.start": [6, 10 * 60_000],
  "game_auth.status": [90, 60_000],
  "game_auth.cancel": [6, 10 * 60_000],
  "game_auth.logout": [6, 10 * 60_000],
  "game_auth.bootstrap": [6, 10 * 60_000],
  "game_auth.bootstrap.status": [90, 60_000],
  "restore.confirm": [6, 10 * 60_000],
  "restore.challenge": [6, 10 * 60_000],
  "restore.exchange": [6, 10 * 60_000],
  "restore.status": [90, 60_000],
  "restore.review": [6, 10 * 60_000],
  "restore.resume": [6, 10 * 60_000],
  "restore.cancel_prepared": [6, 10 * 60_000],
  "restore.ack_unknown": [6, 10 * 60_000],
  "device.session.challenge": [20, 10 * 60_000],
  "device.session.prove": [20, 10 * 60_000],
});

function json(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: PRIVATE_HEADERS,
  });
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function makeRateLimiter(now, maxKeys = 4096) {
  const buckets = new Map();
  return Object.freeze({
    consume(key, limit, windowMs) {
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 1) return false;
      let bucket = buckets.get(key);
      if (!bucket || timestamp - bucket.start >= windowMs) {
        if (!bucket && buckets.size >= maxKeys) {
          for (const [candidate, value] of buckets) {
            if (timestamp - value.start >= value.windowMs)
              buckets.delete(candidate);
          }
          if (buckets.size >= maxKeys)
            buckets.delete(buckets.keys().next().value);
        }
        bucket = { start: timestamp, count: 0, windowMs };
        buckets.set(key, bucket);
      }
      bucket.count += 1;
      return bucket.count <= limit;
    },
  });
}

function normalizeOrigin(value, { allowLocalHttp = false } = {}) {
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
      allowLocalHttp &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)
    )
      return url.origin;
    return null;
  } catch {
    return null;
  }
}

async function readJsonBody(request) {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json")
    return { error: "json_required", status: 415 };
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_BODY_BYTES)
    return { error: "body_too_large", status: 413 };
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES)
    return { error: "body_too_large", status: 413 };
  try {
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    return isRecord(value)
      ? { value }
      : { error: "invalid_request", status: 400 };
  } catch {
    return { error: "invalid_json", status: 400 };
  }
}

function rateKey(clientIp, operation, ownerId = "") {
  const normalizedIp =
    typeof clientIp === "string" &&
    clientIp.length > 0 &&
    clientIp.length <= 128
      ? clientIp
      : "unknown";
  return `${operation}:${ownerId}:${normalizedIp}`;
}

function statusFor(error) {
  if (
    Number.isInteger(error?.status) &&
    error.status >= 400 &&
    error.status <= 599
  )
    return error.status;
  if (error?.code === "invalid_message") return 400;
  return 503;
}

function publicError(error) {
  const code = error?.code;
  if (code === "invalid_message") return "invalid_request";
  if (PUBLIC_ERRORS.has(code)) return code;
  return "bridge_unavailable";
}

export function ownerProofKeyFromEnvironment(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value)
    return null;
  return bytes;
}

export function sessionCredentialKeyFromEnvironment(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value))
    return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value)
    return null;
  return bytes;
}

export function createRestoredDirectSelectionGuard(store) {
  return ({ ownerId, policy, activeDeviceId, expectedRouteEpoch }) => {
    if (
      !store.isRestoreGuardActive() ||
      policy !== "direct" ||
      activeDeviceId !== null ||
      expectedRouteEpoch !== 0
    )
      return false;
    const binding = store.readGameAccountBinding(ownerId);
    return Boolean(
      binding &&
      store.isRestoreAccountReauthorized(binding.playerId) &&
      !store.hasExplicitRoutePolicy(binding.playerId),
    );
  };
}

export function createBridgeHttp({
  registry,
  botToken,
  ownerProofKey,
  origin = "https://madhouse-wiki.ru",
  devOrigin = null,
  routeSelectionEnabled = false,
  allowRestoredDirectSelection = null,
  authCoordinator = null,
  bootstrapCoordinator = null,
  confirmRestoreOwner = null,
  issueRestoreOwnerChallenge = null,
  readRestoreOwnerStatus = null,
  confirmRestoreReview = null,
  now = Date.now,
} = {}) {
  if (
    !registry ||
    typeof registry.startPairing !== "function" ||
    typeof registry.pairingStatus !== "function" ||
    typeof registry.cancelPairing !== "function"
  )
    throw new TypeError("bridge_registry_required");
  const allowedOrigin = normalizeOrigin(origin);
  if (!allowedOrigin) throw new TypeError("bridge_origin_invalid");
  const allowedOrigins = new Set([allowedOrigin]);
  if (devOrigin) {
    const normalizedDevOrigin = normalizeOrigin(devOrigin, {
      allowLocalHttp: true,
    });
    if (!normalizedDevOrigin) throw new TypeError("bridge_dev_origin_invalid");
    allowedOrigins.add(normalizedDevOrigin);
  }
  const limiter = makeRateLimiter(now);

  return async function handleBridgeRequest(request, { clientIp } = {}) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/bridge" || url.search)
      return json(404, { error: "unknown_bridge_route" });
    if (request.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    const bodyResult = await readJsonBody(request);
    if (bodyResult.error)
      return json(bodyResult.status, { error: bodyResult.error });

    const body = bodyResult.value;
    if (typeof body.operation !== "string" || !RATE_LIMITS[body.operation])
      return json(400, { error: "invalid_request" });
    const operation = body.operation;
    const originHeader = request.headers.get("origin");
    if (
      (OWNER_OPERATIONS.has(operation) &&
        !allowedOrigins.has(originHeader || "")) ||
      (originHeader && !allowedOrigins.has(originHeader))
    )
      return json(403, { error: "origin_rejected" });
    if (
      operation === "route.select" &&
      !routeSelectionEnabled &&
      !(
        body.policy === "direct" &&
        typeof allowRestoredDirectSelection === "function"
      )
    )
      return json(409, { error: "route_selection_unavailable" });

    try {
      if (OWNER_OPERATIONS.has(operation)) {
        const requestKeys =
          operation === "restore.ack_unknown"
            ? ["operation", "requestId", "challenge", "initData"]
            : operation === "restore.cancel_prepared"
              ? ["operation", "requestId", "initData"]
              : operation === "restore.resume"
                ? ["operation", "requestId", "initData"]
                : operation === "restore.review"
                  ? ["operation", "requestId", "challenge", "initData"]
                  : operation === "restore.status"
                    ? ["operation", "requestId", "initData"]
                    : operation === "restore.exchange"
                      ? [
                          "operation",
                          "requestId",
                          "cargoLaunchData",
                          "initData",
                        ]
                      : operation === "restore.challenge"
                        ? ["operation", "requestId", "initData"]
                        : operation === "restore.confirm"
                          ? [
                              "operation",
                              "requestId",
                              "routePolicy",
                              "challenge",
                              "initData",
                            ]
                          : operation === "device.pair.approve"
                            ? [
                                "operation",
                                "requestId",
                                "pairingId",
                                "matchingCode",
                                "initData",
                              ]
                            : operation === "device.list"
                              ? ["operation", "requestId", "initData"]
                              : operation === "route.select"
                                ? [
                                    "operation",
                                    "requestId",
                                    "policy",
                                    "activeDeviceId",
                                    "expectedRouteEpoch",
                                    "initData",
                                  ]
                                : operation === "game_account.bind"
                                  ? ["operation", "requestId", "initData"]
                                  : operation === "game_auth.start"
                                    ? [
                                        "operation",
                                        "requestId",
                                        "consentGeneration",
                                        "routeEpoch",
                                        "initData",
                                      ]
                                    : operation === "game_auth.status" ||
                                        operation === "game_auth.cancel"
                                      ? [
                                          "operation",
                                          "requestId",
                                          "operationId",
                                          "initData",
                                        ]
                                      : operation === "game_auth.bootstrap"
                                        ? [
                                            "operation",
                                            "requestId",
                                            "cargoLaunchData",
                                            "initData",
                                          ]
                                        : operation ===
                                            "game_auth.bootstrap.status"
                                          ? [
                                              "operation",
                                              "requestId",
                                              "initData",
                                            ]
                                          : operation === "game_auth.logout"
                                            ? [
                                                "operation",
                                                "requestId",
                                                "initData",
                                              ]
                                            : [
                                                "operation",
                                                "requestId",
                                                "deviceId",
                                                "expectedGeneration",
                                                "initData",
                                              ];
        if (!exactKeys(body, requestKeys))
          return json(400, { error: "invalid_request" });
        const timestamp = now();
        if (!Number.isSafeInteger(timestamp) || timestamp < 1)
          return json(503, { error: "bridge_unavailable" });
        const user = validateTelegramInitData(body.initData, botToken, {
          now: timestamp,
          maxAgeSeconds: 5 * 60,
        });
        if (!user) return json(401, { error: "telegram_session_required" });
        if (operation === "route.select" && !routeSelectionEnabled) {
          let allowed = false;
          try {
            allowed = await allowRestoredDirectSelection({
              ownerId: user.id,
              policy: body.policy,
              activeDeviceId: body.activeDeviceId,
              expectedRouteEpoch: body.expectedRouteEpoch,
            });
          } catch {
            allowed = false;
          }
          if (allowed !== true)
            return json(409, { error: "route_selection_unavailable" });
        }
        const [limit, windowMs] = RATE_LIMITS[operation];
        if (
          !limiter.consume(
            rateKey(clientIp, operation, user.id),
            limit,
            windowMs,
          )
        )
          return json(429, { error: "rate_limited" });
        if (operation === "restore.ack_unknown") {
          if (
            typeof body.requestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              body.requestId,
            ) ||
            typeof body.challenge !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/u.test(body.challenge)
          )
            return json(400, { error: "invalid_request" });
          if (
            typeof bootstrapCoordinator?.acknowledgeUnknownRestore !==
            "function"
          )
            return json(503, { error: "game_auth_unavailable" });
          const result = await bootstrapCoordinator.acknowledgeUnknownRestore({
            ownerId: user.id,
            challenge: body.challenge,
            confirmedAt: timestamp,
            identityIssuedAt:
              Number(new URLSearchParams(body.initData).get("auth_date")) *
              1000,
          });
          if (result.status !== "reauthorization_required")
            return json(503, { error: "game_auth_unavailable" });
          return json(200, {
            operation,
            requestId: body.requestId,
            status: result.status,
          });
        }
        if (operation === "restore.cancel_prepared") {
          if (
            typeof body.requestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              body.requestId,
            )
          )
            return json(400, { error: "invalid_request" });
          if (typeof bootstrapCoordinator?.cancelPreparedRestore !== "function")
            return json(503, { error: "game_auth_unavailable" });
          const result = bootstrapCoordinator.cancelPreparedRestore({
            ownerId: user.id,
          });
          if (result.status !== "cancelled")
            return json(503, { error: "game_auth_unavailable" });
          return json(200, {
            operation,
            requestId: body.requestId,
            status: "cancelled",
          });
        }
        if (operation === "restore.resume") {
          if (
            typeof body.requestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              body.requestId,
            )
          )
            return json(400, { error: "invalid_request" });
          if (typeof bootstrapCoordinator?.resumeRestore !== "function")
            return json(503, { error: "game_auth_unavailable" });
          const result = await bootstrapCoordinator.resumeRestore({
            ownerId: user.id,
          });
          if (result.status !== "ready")
            return json(503, { error: "game_auth_unavailable" });
          return json(200, {
            operation,
            requestId: body.requestId,
            status: "review_required",
          });
        }
        if (operation === "restore.review") {
          if (
            typeof body.requestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              body.requestId,
            ) ||
            typeof body.challenge !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/u.test(body.challenge)
          )
            return json(400, { error: "invalid_request" });
          if (typeof confirmRestoreReview !== "function")
            return json(503, { error: "bridge_unavailable" });
          let result;
          try {
            result = await confirmRestoreReview({
              ownerId: user.id,
              initData: body.initData,
              challenge: body.challenge,
              confirmedAt: timestamp,
              identityIssuedAt:
                Number(new URLSearchParams(body.initData).get("auth_date")) *
                1000,
            });
          } catch {
            return json(409, { error: "restore_confirmation_unavailable" });
          }
          if (!["ready", "reconciliation_required"].includes(result?.status))
            return json(503, { error: "bridge_unavailable" });
          return json(200, {
            operation,
            requestId: body.requestId,
            status: result.status,
          });
        }
        if (operation === "restore.status") {
          if (
            typeof body.requestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              body.requestId,
            )
          )
            return json(400, { error: "invalid_request" });
          if (typeof readRestoreOwnerStatus !== "function")
            return json(503, { error: "bridge_unavailable" });
          let status;
          try {
            status = (await readRestoreOwnerStatus(user.id))?.status;
          } catch {
            return json(503, { error: "bridge_unavailable" });
          }
          if (
            ![
              "not_required",
              "reauthorization_required",
              "auth_pending",
              "auth_prepared",
              "auth_ready_to_resume",
              "auth_check_saved",
              "auth_outcome_unknown",
              "auth_failed",
              "review_required",
              "reconciliation_required",
              "ready",
            ].includes(status)
          )
            return json(503, { error: "bridge_unavailable" });
          return json(200, { operation, requestId: body.requestId, status });
        }
        if (operation === "restore.exchange") {
          if (
            typeof body.requestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              body.requestId,
            ) ||
            typeof body.cargoLaunchData !== "string" ||
            Buffer.byteLength(body.cargoLaunchData) < 1 ||
            Buffer.byteLength(body.cargoLaunchData) > 8192
          )
            return json(400, { error: "invalid_request" });
          if (
            !bootstrapCoordinator ||
            typeof bootstrapCoordinator.prepareRestore !== "function" ||
            typeof bootstrapCoordinator.exchangeRestore !== "function" ||
            typeof bootstrapCoordinator.stageRestore !== "function" ||
            typeof bootstrapCoordinator.authorizeRestoreReads !== "function" ||
            typeof bootstrapCoordinator.bootstrapStatus !== "function"
          )
            return json(503, { error: "game_auth_unavailable" });
          const request = {
            ownerId: user.id,
            cargoLaunchData: body.cargoLaunchData,
          };
          const prepared = await bootstrapCoordinator.prepareRestore(
            request,
            body.requestId,
          );
          const exchange =
            prepared.status === "prepared"
              ? await bootstrapCoordinator.exchangeRestore(
                  request,
                  body.requestId,
                )
              : prepared;
          if (exchange.status === "credential_stored") {
            await bootstrapCoordinator.stageRestore(
              { ownerId: user.id },
              body.requestId,
            );
            await bootstrapCoordinator.authorizeRestoreReads(
              { ownerId: user.id },
              body.requestId,
            );
            return json(200, {
              operation,
              requestId: body.requestId,
              status: "review_required",
            });
          }
          if (exchange.status === "ready") {
            const current = await bootstrapCoordinator.bootstrapStatus(
              { ownerId: user.id },
              body.requestId,
            );
            if (current.status !== "ready")
              return json(409, { error: "game_auth_operation_stale" });
            return json(200, {
              operation,
              requestId: body.requestId,
              status: "review_required",
            });
          }
          if (
            ![
              "exchange_pending",
              "verification_pending",
              "auth_outcome_unknown",
              "failed",
            ].includes(exchange.status)
          )
            return json(503, { error: "game_auth_unavailable" });
          return json(200, {
            operation,
            requestId: body.requestId,
            status: exchange.status,
          });
        }
        if (
          operation === "restore.confirm" ||
          operation === "restore.challenge"
        ) {
          if (
            typeof body.requestId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
              body.requestId,
            ) ||
            (operation === "restore.confirm" &&
              (body.routePolicy !== "direct" ||
                typeof body.challenge !== "string" ||
                !/^[A-Za-z0-9_-]{43}$/u.test(body.challenge)))
          )
            return json(400, { error: "invalid_request" });
          if (
            typeof (operation === "restore.confirm"
              ? confirmRestoreOwner
              : issueRestoreOwnerChallenge) !== "function"
          )
            return json(503, { error: "bridge_unavailable" });
          try {
            const identityIssuedAt =
              Number(new URLSearchParams(body.initData).get("auth_date")) *
              1000;
            if (operation === "restore.challenge") {
              const result = await issueRestoreOwnerChallenge({
                ownerId: user.id,
                issuedAt: timestamp,
                identityIssuedAt,
              });
              return json(200, {
                operation,
                requestId: body.requestId,
                ...result,
              });
            }
            await confirmRestoreOwner({
              ownerId: user.id,
              requestId: body.requestId,
              routePolicy: body.routePolicy,
              confirmedAt: timestamp,
              identityIssuedAt,
              challenge: body.challenge,
            });
          } catch {
            return json(409, { error: "restore_confirmation_unavailable" });
          }
          return json(200, {
            operation,
            requestId: body.requestId,
            status: "confirmed",
          });
        }
        if (
          !(ownerProofKey instanceof Uint8Array) ||
          ownerProofKey.length !== 32
        )
          return json(503, { error: "bridge_owner_auth_unavailable" });
        const issuedAtSeconds = Math.floor(timestamp / 1000);
        const ownerProof = await signOwnerProof(
          {
            issuer: "madhouse-wiki",
            audience: "madhouse-wiki-bridge-internal",
            subject: user.id,
            operation,
            issuedAtSeconds,
            expiresAtSeconds: issuedAtSeconds + 30,
            jti: randomUUID(),
            identityGeneration: 1,
          },
          ownerProofKey,
        );
        const internalRequest = { ...body, ownerProof };
        delete internalRequest.initData;
        if (operation === "game_account.bind") {
          const authorization = request.headers.get("authorization") || "";
          if (
            authorization.length > 16_384 ||
            !/^Bearer [A-Za-z0-9._~-]+$/u.test(authorization)
          )
            return json(401, { error: "invalid_game_session" });
          internalRequest.authorization = authorization;
        }
        if (operation.startsWith("game_auth.")) {
          const bootstrapOperation =
            operation === "game_auth.bootstrap" ||
            operation === "game_auth.bootstrap.status";
          if (bootstrapOperation && !bootstrapCoordinator)
            throw Object.assign(new Error("game_auth_unavailable"), {
              code: "game_auth_unavailable",
              status: 503,
            });
          if (!bootstrapOperation && !authCoordinator)
            throw Object.assign(new Error("game_auth_unavailable"), {
              code: "game_auth_unavailable",
              status: 503,
            });
          const parsed = parseInternalRequest(internalRequest);
          let authResult;
          if (operation === "game_auth.start")
            authResult = await authCoordinator.start(
              {
                ownerId: user.id,
                consentGeneration: parsed.consentGeneration,
                routeEpoch: parsed.routeEpoch,
              },
              parsed.requestId,
            );
          else if (operation === "game_auth.status")
            authResult = authCoordinator.status(
              { ownerId: user.id, operationId: parsed.operationId },
              parsed.requestId,
            );
          else if (operation === "game_auth.cancel")
            authResult = await authCoordinator.cancel(
              { ownerId: user.id, operationId: parsed.operationId },
              parsed.requestId,
            );
          else if (operation === "game_auth.bootstrap")
            authResult = await bootstrapCoordinator.bootstrap(
              {
                ownerId: user.id,
                cargoLaunchData: parsed.cargoLaunchData,
              },
              parsed.requestId,
            );
          else if (operation === "game_auth.bootstrap.status")
            authResult = await bootstrapCoordinator.bootstrapStatus(
              { ownerId: user.id },
              parsed.requestId,
            );
          else
            authResult = await authCoordinator.logout(
              { ownerId: user.id },
              parsed.requestId,
            );
          return json(200, parseInternalResponse(authResult));
        }
        const response =
          operation === "device.pair.approve"
            ? await registry.approvePairing(
                parseInternalRequest(internalRequest),
              )
            : operation === "device.list"
              ? await registry.listOwnedDevices(
                  parseInternalRequest(internalRequest),
                )
              : operation === "device.revoke"
                ? await registry.revokeDevice(
                    parseInternalRequest(internalRequest),
                  )
                : operation === "route.select"
                  ? await registry.selectRoute(
                      parseInternalRequest(internalRequest),
                    )
                  : await registry.bindGameAccount(
                      parseInternalRequest(internalRequest),
                    );
        return json(200, parseInternalResponse(response));
      }

      if (operation === "device.pair.start") {
        if (
          !exactKeys(body, [
            "operation",
            "requestId",
            "idempotencyKey",
            "deviceId",
            "publicKey",
            "deviceName",
            "platform",
          ])
        )
          return json(400, { error: "invalid_request" });
      } else if (operation === "device.session.challenge") {
        if (!exactKeys(body, ["operation", "requestId", "deviceId"]))
          return json(400, { error: "invalid_request" });
      } else if (operation === "device.session.prove") {
        if (
          !exactKeys(body, [
            "operation",
            "requestId",
            "deviceId",
            "challengeId",
            "signature",
          ])
        )
          return json(400, { error: "invalid_request" });
      } else if (
        operation === "device.pair.status" ||
        operation === "device.pair.cancel"
      ) {
        if (
          !exactKeys(body, [
            "operation",
            "requestId",
            "pairingId",
            "retrievalSecret",
          ])
        )
          return json(400, { error: "invalid_request" });
      } else return json(400, { error: "invalid_request" });

      const parsed = parseInternalRequest(body);
      const [limit, windowMs] = RATE_LIMITS[operation];
      if (!limiter.consume(rateKey(clientIp, operation), limit, windowMs))
        return json(429, { error: "rate_limited" });
      const response =
        operation === "device.pair.start"
          ? registry.startPairing(parsed)
          : operation === "device.pair.status"
            ? registry.pairingStatus(parsed)
            : operation === "device.pair.cancel"
              ? registry.cancelPairing(parsed)
              : operation === "device.session.challenge"
                ? registry.issueDeviceSessionChallenge(parsed)
                : await registry.proveDeviceSession(parsed);
      return json(200, parseInternalResponse(response));
    } catch (error) {
      return json(statusFor(error), { error: publicError(error) });
    }
  };
}

export function nodeBridgeHandler(handle, { origin } = {}) {
  return async (request, response) => {
    let result;
    try {
      const method = request.method || "GET";
      let body;
      if (!new Set(["GET", "HEAD"]).has(method)) {
        const chunks = [];
        let size = 0;
        for await (const chunk of request) {
          const bytes = Buffer.from(chunk);
          size += bytes.byteLength;
          if (size > MAX_BODY_BYTES) {
            request.resume?.();
            response.writeHead(413, PRIVATE_HEADERS);
            response.end(JSON.stringify({ error: "body_too_large" }));
            return;
          }
          chunks.push(bytes);
        }
        body = chunks.length ? Buffer.concat(chunks, size) : undefined;
      }
      const headers = new Headers();
      for (const name of [
        "content-type",
        "content-length",
        "origin",
        "authorization",
      ])
        if (typeof request.headers?.[name] === "string")
          headers.set(name, request.headers[name]);
      const remoteAddress = request.socket?.remoteAddress || "unknown";
      const trustedProxyRequest = new Set([
        "127.0.0.1",
        "::1",
        "::ffff:127.0.0.1",
      ]).has(remoteAddress);
      const forwardedAddress = request.headers?.["x-real-ip"];
      const clientIp =
        trustedProxyRequest &&
        typeof forwardedAddress === "string" &&
        isIP(forwardedAddress)
          ? forwardedAddress
          : remoteAddress;
      result = await handle(
        new Request(
          `${origin || `http://${request.headers.host}`}${request.url}`,
          {
            method,
            headers,
            ...(body?.byteLength ? { body } : {}),
          },
        ),
        { clientIp },
      );
    } catch {
      result = json(503, { error: "bridge_unavailable" });
    }
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}
