import { randomUUID } from "node:crypto";
import {
  readGameOverBridge,
  readProfileOverBridge,
  sendFriendResponseOverBridge,
  sendWorkTaskOverBridge,
} from "./profile-client.mjs";

// In-process proof checked synchronously before a profile snapshot commits.
export const bridgeProfileCurrent = Symbol("bridge-profile-current");
export const bridgeReadCurrent = Symbol("bridge-read-current");

function failure(code) {
  return Object.assign(new Error(code), { code });
}
function validateDispatch(current, canDispatch, claim = () => true) {
  if (!current()) return false;
  if (!canDispatch) return claim();
  return Promise.resolve()
    .then(canDispatch)
    .then((allowed) => allowed === true && current() && claim());
}
export function bridgeFailureCategory(error) {
  const allowed = new Set([
    "bridge_offline",
    "bridge_timeout",
    "tls_failed",
    "tls_timeout",
    "tls_closed_before_ready",
    "invalid_tunnel",
    "data_channel_closed",
    "invalid_data_channel_frame",
    "data_frame_too_large",
    "backpressure_limit",
    "bridge_cancelled",
    "DIRECT_REQUEST_DEADLINE",
    "DIRECT_REQUEST_CANCELLED",
    "DIRECT_REQUEST_QUEUE_FULL",
    "unresolved_bridge_attempt",
    "unresolved_bridge_transport",
    "profile_incomplete",
    "profile_timeout",
    "profile_too_large",
    "ECONNRESET",
    "EPIPE",
    "ETIMEDOUT",
    "ABORT_ERR",
    "ERR_STREAM_PREMATURE_CLOSE",
    "ERR_HTTP_CONTENT_LENGTH_MISMATCH",
  ]);
  for (const candidate of [error?.code, error?.message, error?.cause?.code])
    if (allowed.has(candidate)) return candidate;
  return "other";
}
function logBridgeFailure(error) {
  console.warn("madhouse-bridge-transport", bridgeFailureCategory(error));
}
const secret =
  /token|jwt|authorization|password|session|credential|initdata|secret/i;
function sanitize(value, depth = 0) {
  if (depth > 32) throw failure("profile_invalid");
  if (Array.isArray(value))
    return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !secret.test(key) &&
            !["__proto__", "constructor", "prototype"].includes(key),
        )
        .map(([key, item]) => [key, sanitize(item, depth + 1)]),
    );
  return value;
}

/** Verified owner only; credentials remain on the server. */
export function createBridgeAccountService({
  accounts,
  devices,
  registry,
  readProfile = readProfileOverBridge,
  readGame = readGameOverBridge,
  sendAction = sendFriendResponseOverBridge,
  sendWork = sendWorkTaskOverBridge,
  queueActionGate = null,
  coordinate = ({ execute }) => execute(),
  coordinateVerified = () => {},
} = {}) {
  if (
    !accounts ||
    !devices ||
    !registry ||
    typeof readProfile !== "function" ||
    typeof readGame !== "function"
  )
    throw new TypeError("account_service_dependencies_required");

  let onVerifiedProfile = () => {};
  async function fetchProfile(
    verifiedOwner,
    authorization,
    signal,
    revision,
    playerId,
    canDispatch,
  ) {
    const device = devices.listDevice(verifiedOwner);
    if (!device) throw failure("device_unavailable");
    const identity = {
      owner: registry.ownerKey(verifiedOwner),
      device: device.deviceId,
      generation: device.generation,
    };
    let result;
    try {
      result = await coordinate({
        authorization,
        playerId,
        deviceId: device.deviceId,
        signal,
        method: "GET",
        path: "/api/me",
        execute: () =>
          readProfile({
            authorization,
            signal,
            openTunnel: () => devices.open(verifiedOwner, { signal }),
            validateTunnel: () =>
              validateDispatch(
                () =>
                  !signal?.aborted &&
                  registry.isActive(identity) &&
                  accounts.getRevision(verifiedOwner) === revision,
                canDispatch,
              ),
          }),
      });
    } catch (error) {
      logBridgeFailure(error);
      throw failure(
        error?.code === "bridge_offline"
          ? "device_offline"
          : "bridge_unavailable",
      );
    }
    if (result.status === 401 || result.status === 403)
      throw failure("invalid_game_token");
    if (result.status !== 200 || !Buffer.isBuffer(result.body))
      throw failure("profile_unavailable");
    let profile;
    try {
      profile = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.body),
      );
    } catch {
      throw failure("profile_invalid");
    }
    if (!Number.isSafeInteger(profile?.playerId) || profile.playerId <= 0)
      throw failure("profile_invalid");
    const telegramId =
      typeof profile.telegramId === "number" &&
      Number.isSafeInteger(profile.telegramId) &&
      profile.telegramId > 0
        ? String(profile.telegramId)
        : typeof profile.telegramId === "string" &&
            /^[1-9][0-9]{0,15}$/.test(profile.telegramId) &&
            Number.isSafeInteger(Number(profile.telegramId))
          ? profile.telegramId
          : null;
    if (telegramId !== verifiedOwner) throw failure("account_mismatch");
    if (!registry.isActive(identity)) throw failure("device_changed");
    return { profile, device, identity };
  }

  async function bind(verifiedOwner, authorization) {
    if (
      typeof authorization !== "string" ||
      authorization.length > 8192 ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      throw failure("invalid_game_token");
    const revision = accounts.getRevision(verifiedOwner);
    const { profile, device } = await fetchProfile(
      verifiedOwner,
      authorization,
      undefined,
      revision,
    );
    accounts.saveVerified({
      owner: verifiedOwner,
      playerId: String(profile.playerId),
      authorization,
      expectedRevision: revision,
      deviceId: device.deviceId,
      generation: device.generation,
    });
    coordinateVerified(authorization, profile.playerId);
    onVerifiedProfile(authorization, sanitize(profile));
    return { status: "connected" };
  }

  async function profile(verifiedOwner, { signal, canDispatch } = {}) {
    const account = accounts.read(verifiedOwner);
    if (!account) throw failure("account_not_configured");
    const result = await fetchProfile(
      verifiedOwner,
      account.authorization,
      signal,
      account.revision,
      account.playerId,
      canDispatch,
    );
    if (accounts.getRevision(verifiedOwner) !== account.revision)
      throw failure("binding_changed");
    if (String(result.profile.playerId) !== account.playerId)
      throw failure("account_mismatch");
    const output = { profile: sanitize(result.profile) };
    Object.defineProperty(output, bridgeProfileCurrent, {
      value: () =>
        registry.isActive(result.identity) &&
        accounts.getRevision(verifiedOwner) === account.revision,
    });
    return output;
  }

  async function read(
    verifiedOwner,
    path,
    { signal, method, body, canDispatch } = {},
  ) {
    const account = accounts.read(verifiedOwner);
    if (!account) throw failure("account_not_configured");
    const device = devices.listDevice(verifiedOwner);
    if (!device) throw failure("device_unavailable");
    const identity = {
      owner: registry.ownerKey(verifiedOwner),
      device: device.deviceId,
      generation: device.generation,
    };
    const recoveryPermit =
      queueActionGate?.battleRecoveryPermit?.({
        authorization: account.authorization,
        method: method || "GET",
        path,
      }) ?? null;
    let result;
    try {
      result = await coordinate({
        authorization: account.authorization,
        playerId: account.playerId,
        deviceId: device.deviceId,
        signal,
        method,
        path,
        recoveryPermit,
        bindingRevision: account.revision,
        deviceGeneration: device.generation,
        execute: () =>
          readGame({
            authorization: account.authorization,
            path,
            method,
            body,
            signal,
            openTunnel: () => devices.open(verifiedOwner, { signal }),
            validateTunnel: () =>
              validateDispatch(
                () =>
                  !signal?.aborted &&
                  registry.isActive(identity) &&
                  accounts.getRevision(verifiedOwner) === account.revision &&
                  (!recoveryPermit || recoveryPermit.validate(path)),
                canDispatch,
              ),
          }),
      });
    } catch (error) {
      logBridgeFailure(error);
      throw failure("bridge_unavailable");
    }
    if (!registry.isActive(identity)) throw failure("device_changed");
    if (accounts.getRevision(verifiedOwner) !== account.revision)
      throw failure("binding_changed");
    if (
      !Number.isInteger(result?.status) ||
      result.status < 200 ||
      result.status > 599 ||
      !Buffer.isBuffer(result.body)
    )
      throw failure("bridge_unavailable");
    const output = { ...result };
    Object.defineProperty(output, bridgeReadCurrent, {
      value: () =>
        registry.isActive(identity) &&
        accounts.getRevision(verifiedOwner) === account.revision,
    });
    return output;
  }

  async function send(
    verifiedOwner,
    method,
    path,
    {
      signal,
      body,
      callerAuthorization,
      validateCaller,
      canDispatch,
      beforeDispatch,
    } = {},
  ) {
    const account = accounts.read(verifiedOwner);
    if (!account || !queueActionGate) throw failure("bridge_unavailable");
    const device = devices.listDevice(verifiedOwner);
    if (!device) throw failure("device_unavailable");
    const identity = {
      owner: registry.ownerKey(verifiedOwner),
      device: device.deviceId,
      generation: device.generation,
    };
    let result;
    try {
      const sender =
        path === "/api/works/tasks/perform" ? sendWork : sendAction;
      const inContext = queueActionGate.capture();
      let checkpointOperationId = null;
      try {
        const value = typeof body === "string" ? JSON.parse(body) : null;
        if (/^[A-Za-z0-9_-]{8,120}$/.test(value?.operationId || ""))
          checkpointOperationId = value.operationId;
      } catch {
        // The action gate remains responsible for validating the body.
      }
      if (
        checkpointOperationId !==
        queueActionGate.battleCheckpointOperationId?.(
          callerAuthorization ?? account.authorization,
        )
      )
        checkpointOperationId = null;
      const operationId =
        queueActionGate.operationId?.() ||
        checkpointOperationId ||
        randomUUID();
      result = await coordinate({
        authorization: account.authorization,
        playerId: account.playerId,
        deviceId: device.deviceId,
        signal,
        method,
        path,
        kind: "mutation",
        operationId,
        checkpointOperationId,
        bindingRevision: account.revision,
        deviceGeneration: device.generation,
        execute: (onTransportStopped) =>
          inContext(() =>
            sender({
              authorization: account.authorization,
              method,
              path,
              body,
              signal,
              onTransportStopped,
              openTunnel: () => devices.open(verifiedOwner, { signal }),
              validateTunnel: () =>
                validateDispatch(
                  () =>
                    !signal?.aborted &&
                    registry.isActive(identity) &&
                    accounts.getRevision(verifiedOwner) === account.revision &&
                    (validateCaller ? validateCaller() === true : true),
                  canDispatch,
                  () => {
                    if (
                      !queueActionGate.claim({
                        authorization:
                          callerAuthorization ?? account.authorization,
                        method,
                        path,
                        body,
                      })
                    )
                      return false;
                    // The shared snapshot barrier is persisted after the
                    // live gate check, before the TLS socket reaches HTTP.
                    return (
                      !beforeDispatch ||
                      beforeDispatch({
                        authorization: account.authorization,
                        playerId: account.playerId,
                      }) === true
                    );
                  },
                ),
            }),
          ),
      });
    } catch (error) {
      logBridgeFailure(error);
      const unavailable = failure("bridge_unavailable");
      if (error?.notDispatched === true) unavailable.notDispatched = true;
      if (Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0)
        unavailable.retryAfterMs = error.retryAfterMs;
      throw unavailable;
    }
    if (
      !registry.isActive(identity) ||
      accounts.getRevision(verifiedOwner) !== account.revision ||
      !Number.isInteger(result?.status) ||
      result.status < 200 ||
      result.status > 599 ||
      !Buffer.isBuffer(result.body)
    )
      throw failure("bridge_unavailable");
    return result;
  }

  function status(verifiedOwner) {
    return accounts.getRevision(verifiedOwner) > 0 ? "saved" : "not_configured";
  }
  return Object.freeze({
    bind,
    profile,
    read,
    send,
    status,
    setProfileObserver(observer) {
      onVerifiedProfile = observer;
    },
  });
}
