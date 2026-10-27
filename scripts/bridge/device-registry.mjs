import {
  createPublicKey,
  randomBytes,
  randomUUID,
  timingSafeEqual,
  verify as verifySignature,
} from "node:crypto";
import {
  parseInternalRequest,
  parseInternalResponse,
} from "./protocol-v1/internal-api.mjs";
import { encodeDeviceChallenge } from "./protocol-v1/challenge.mjs";
import { PROTOCOL_VERSION } from "./protocol-v1/control.mjs";
import {
  signDeviceSessionCredential,
  verifyDeviceSessionCredential,
} from "./protocol-v1/session-credential.mjs";
import { verifyOwnerProof as verifySignedOwnerProof } from "./protocol-v1/owner-proof.mjs";

export const DEVICE_PAIRING_TTL_MS = 5 * 60_000;
export const DEVICE_PAIRING_RETENTION_MS = 24 * 60 * 60_000;
export const MAX_ACTIVE_DEVICES_PER_OWNER = 1;
export const MAX_REGISTERED_DEVICES_PER_OWNER = 32;
export const MAX_PAIRING_CODE_ATTEMPTS = 5;
export const DEVICE_SESSION_CHALLENGE_TTL_MS = 60_000;
export const DEVICE_SESSION_TTL_MS = 15 * 60_000;
export const MAX_UNEXPIRED_DEVICE_CHALLENGES = 4;

const DEVICE_NAME_CONTROL = /\p{Cc}/u;
const PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PUBLIC_KEY = /^[A-Za-z0-9_-]{43}$/u;
const DER_PUBLIC_KEY_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function failure(code, status = 409) {
  return Object.assign(new Error(code), { code, status });
}

function ownerId(value) {
  const normalized = String(value ?? "");
  if (
    !/^[1-9][0-9]{0,15}$/u.test(normalized) ||
    !Number.isSafeInteger(Number(normalized))
  )
    throw failure("invalid_wiki_identity", 401);
  return normalized;
}

function playerId(value) {
  const normalized = String(value ?? "");
  if (
    !/^[1-9][0-9]{0,15}$/u.test(normalized) ||
    !Number.isSafeInteger(Number(normalized))
  )
    throw failure("invalid_game_session", 401);
  return normalized;
}

function routeForDevice(resolveDeviceRoute, device) {
  if (!resolveDeviceRoute) throw failure("device_route_unavailable", 503);
  let route;
  try {
    route = resolveDeviceRoute(device.ownerId);
  } catch {
    throw failure("device_route_unavailable", 503);
  }
  if (route && typeof route.then === "function")
    throw failure("device_route_unavailable", 503);
  if (
    route?.policy !== "bridge_required" ||
    route.activeDeviceId !== device.deviceId ||
    !Number.isSafeInteger(route.routeEpoch) ||
    route.routeEpoch < 1
  )
    throw failure("device_route_inactive", 409);
  return route;
}

function challengeMessage(record) {
  return encodeDeviceChallenge({
    protocolMajor: record.protocolMajor,
    protocolMinor: record.protocolMinor,
    purpose: record.purpose,
    deviceId: record.deviceId,
    connectionId: record.connectionId,
    nonce: Buffer.from(record.nonce, "base64url"),
    expiresAtMs: record.expiresAtMs,
    deviceGeneration: record.deviceGeneration,
    routeEpoch: record.routeEpoch,
  });
}

function verifyDeviceProof(device, challenge, signatureValue) {
  try {
    const keyBytes = publicKeyBytes(device.publicKey);
    const publicKey = createPublicKey({
      key: Buffer.concat([DER_PUBLIC_KEY_PREFIX, keyBytes]),
      format: "der",
      type: "spki",
    });
    const signature = Buffer.from(signatureValue, "base64url");
    return (
      signature.byteLength === 64 &&
      verifySignature(null, challengeMessage(challenge), publicKey, signature)
    );
  } catch {
    return false;
  }
}

function publicKeyBytes(value) {
  if (!PUBLIC_KEY.test(value)) throw failure("invalid_request", 400);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== value)
    throw failure("invalid_request", 400);
  return bytes;
}

function sameBytes(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

function sameStartRequest(record, request) {
  return (
    record.deviceId === request.deviceId &&
    record.publicKey === request.publicKey &&
    record.deviceName === request.deviceName &&
    record.platform === request.platform
  );
}

function createDisplayCode(random = randomBytes) {
  const bytes = random(6);
  let code = "";
  for (const byte of bytes) code += PAIRING_CODE_ALPHABET[byte & 31];
  bytes.fill(0);
  return code;
}

function validateTime(now) {
  if (!Number.isSafeInteger(now) || now < 1)
    throw new TypeError("bridge_clock_invalid");
}

function pairingStartResponse(request, record) {
  return parseInternalResponse({
    requestId: request.requestId,
    operation: "device.pair.start",
    status: "created",
    pairingId: record.pairingId,
    displayCode: record.displayCode,
    retrievalSecret: record.retrievalSecret,
    expiresAtMs: record.expiresAtMs,
  });
}

function pairingStatusResponse(request, record) {
  const status = record.state === "pending" ? "pending" : record.state;
  return parseInternalResponse({
    requestId: request.requestId,
    operation: "device.pair.status",
    pairingId: record.pairingId,
    status,
    ...(record.state === "approved"
      ? {
          deviceId: record.deviceId,
          deviceGeneration: record.deviceGeneration,
          expectedTelegramOwnerId: record.ownerId,
        }
      : {}),
  });
}

function deviceApprovalResponse(request, record, status) {
  return parseInternalResponse({
    requestId: request.requestId,
    operation: "device.pair.approve",
    status,
    deviceId: record.deviceId,
    deviceGeneration: record.deviceGeneration,
  });
}

function requireMatchingSecret(record, secret) {
  if (!sameBytes(record.retrievalSecret, secret))
    throw failure("pairing_not_found", 404);
}

export function createDeviceRegistry({
  store,
  now = Date.now,
  random = randomBytes,
  uuid = randomUUID,
  maxActiveDevicesPerOwner = MAX_ACTIVE_DEVICES_PER_OWNER,
  ownerProofKey,
  verifyOwnerProof: verifyOwnerProofFn,
  verifyGameAccount: verifyGameAccountFn,
  sessionSigningKey,
  resolveDeviceRoute,
  onDeviceRevoked = () => {},
  onRouteChanging = async () => {},
  onRouteChanged = () => {},
  onGameAccountBound = async () => {},
} = {}) {
  if (typeof store?.withBridgeTransaction !== "function")
    throw new TypeError("bridge_registry_store_required");
  if (
    !Number.isSafeInteger(maxActiveDevicesPerOwner) ||
    maxActiveDevicesPerOwner < 1 ||
    maxActiveDevicesPerOwner > 32
  )
    throw new TypeError("bridge_registry_limit_invalid");
  if (
    typeof onDeviceRevoked !== "function" ||
    typeof onRouteChanging !== "function" ||
    typeof onRouteChanged !== "function" ||
    typeof onGameAccountBound !== "function"
  )
    throw new TypeError("bridge_registry_observer_invalid");

  function notify(observer, ...args) {
    try {
      const result = observer(...args);
      result?.catch?.(() => {});
    } catch {
      // Durable registry state remains authoritative if an ephemeral channel
      // observer is unavailable; authorization is rechecked on every use.
    }
  }

  function currentTime() {
    const value = now();
    validateTime(value);
    return value;
  }

  const proofVerifier =
    typeof verifyOwnerProofFn === "function"
      ? verifyOwnerProofFn
      : ownerProofKey instanceof Uint8Array && ownerProofKey.byteLength === 32
        ? (proof, options) =>
            verifySignedOwnerProof(proof, ownerProofKey, options)
        : null;
  const gameAccountVerifier =
    typeof verifyGameAccountFn === "function" ? verifyGameAccountFn : null;

  async function resolveVerifiedOwnerId(request, expectedOperation, nowMs) {
    if (!proofVerifier) throw failure("owner_proof_unavailable", 503);
    let claims;
    try {
      claims = await proofVerifier(request.ownerProof, {
        expectedOperation,
        nowSeconds: Math.floor(nowMs / 1000),
      });
    } catch {
      throw failure("not_authorized", 401);
    }
    if (claims?.operation !== expectedOperation)
      throw failure("not_authorized", 401);
    return ownerId(claims.subject);
  }

  return Object.freeze({
    isDeviceActive({ ownerId: rawOwnerId, deviceId } = {}) {
      const verifiedOwnerId = ownerId(rawOwnerId);
      if (typeof deviceId !== "string" || !UUID.test(deviceId)) return false;
      return store.withBridgeTransaction((bridge) => {
        const device = bridge.readDevice(deviceId);
        return Boolean(
          device &&
          device.ownerId === verifiedOwnerId &&
          device.status === "active",
        );
      });
    },
    getHelperPaused(rawOwnerId) {
      const verifiedOwnerId = ownerId(rawOwnerId);
      return store.withBridgeTransaction(
        (bridge) => bridge.readHelperControl(verifiedOwnerId).paused,
      );
    },
    setHelperPaused(rawOwnerId, paused) {
      const verifiedOwnerId = ownerId(rawOwnerId);
      if (typeof paused !== "boolean")
        throw failure("invalid_helper_control", 400);
      if (!store.readGameAccountBinding(verifiedOwnerId))
        throw failure("game_account_binding_required", 409);
      const updatedAtMs = currentTime();
      validateTime(updatedAtMs);
      return store.withBridgeTransaction((bridge) =>
        bridge.setHelperPaused(verifiedOwnerId, paused, updatedAtMs),
      );
    },
    async authorizeDeviceSession(value) {
      if (
        !(sessionSigningKey instanceof Uint8Array) ||
        sessionSigningKey.length !== 32
      )
        throw failure("device_session_unavailable", 503);
      const nowMs = currentTime();
      let claims;
      try {
        claims = await verifyDeviceSessionCredential(value, sessionSigningKey, {
          nowMs,
        });
      } catch {
        throw failure("device_session_invalid", 401);
      }
      return store.withBridgeTransaction((bridge) => {
        const device = bridge.readDevice(claims.deviceId);
        if (!device || device.status !== "active")
          throw failure("device_not_found", 404);
        if (device.generation !== claims.deviceGeneration)
          throw failure("device_generation_conflict", 409);
        const route = routeForDevice(resolveDeviceRoute, device);
        if (route.routeEpoch !== claims.routeEpoch)
          throw failure("device_route_inactive", 409);
        return Object.freeze({
          ownerId: device.ownerId,
          deviceId: device.deviceId,
          deviceGeneration: device.generation,
          connectionId: claims.connectionId,
          routeEpoch: route.routeEpoch,
          expiresAtMs: claims.expiresAtMs,
          scopes: claims.scopes,
        });
      });
    },

    startPairing(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "device.pair.start")
        throw failure("invalid_request", 400);
      publicKeyBytes(request.publicKey);
      if (DEVICE_NAME_CONTROL.test(request.deviceName))
        throw failure("invalid_request", 400);
      const createdAtMs = currentTime();
      const expiresAtMs = createdAtMs + DEVICE_PAIRING_TTL_MS;
      if (!Number.isSafeInteger(expiresAtMs))
        throw failure("pairing_clock_exhausted", 503);

      return store.withBridgeTransaction((bridge) => {
        bridge.prunePairingsBefore(
          Math.max(1, createdAtMs - DEVICE_PAIRING_RETENTION_MS),
        );
        const previous = bridge.readPairingByIdempotencyKey(
          request.idempotencyKey,
        );
        if (previous) {
          if (!sameStartRequest(previous, request))
            throw failure("idempotency_conflict");
          return pairingStartResponse(request, previous);
        }

        if (bridge.readDevice(request.deviceId))
          throw failure("device_already_registered");
        const pending = bridge
          .listPairingsByDevice(request.deviceId)
          .filter(
            (record) =>
              record.state === "pending" && record.expiresAtMs > createdAtMs,
          );
        if (pending.length) throw failure("pairing_already_pending");

        const retrievalSecret = random(32).toString("base64url");
        const record = {
          schemaVersion: 1,
          pairingId: uuid(),
          idempotencyKey: request.idempotencyKey,
          deviceId: request.deviceId,
          publicKey: request.publicKey,
          deviceName: request.deviceName,
          platform: request.platform,
          displayCode: createDisplayCode(random),
          retrievalSecret,
          state: "pending",
          ownerId: null,
          createdAtMs,
          expiresAtMs,
          codeAttempts: 0,
          approvedAtMs: null,
          deviceGeneration: null,
        };
        bridge.insertPairing(record);
        return pairingStartResponse(request, record);
      });
    },

    pairingStatus(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "device.pair.status")
        throw failure("invalid_request", 400);
      const checkedAtMs = currentTime();
      return store.withBridgeTransaction((bridge) => {
        const record = bridge.readPairing(request.pairingId);
        if (!record) throw failure("pairing_not_found", 404);
        requireMatchingSecret(record, request.retrievalSecret);
        if (record.state === "pending" && record.expiresAtMs <= checkedAtMs) {
          record.state = "expired";
          bridge.updatePairing(record);
        }
        return pairingStatusResponse(request, record);
      });
    },

    cancelPairing(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "device.pair.cancel")
        throw failure("invalid_request", 400);
      const checkedAtMs = currentTime();
      return store.withBridgeTransaction((bridge) => {
        const record = bridge.readPairing(request.pairingId);
        if (!record) throw failure("pairing_not_found", 404);
        requireMatchingSecret(record, request.retrievalSecret);
        let status;
        if (record.state === "approved") status = "already_approved";
        else if (record.state === "cancelled") status = "already_cancelled";
        else if (
          record.state === "expired" ||
          record.expiresAtMs <= checkedAtMs
        ) {
          if (record.state === "pending") {
            record.state = "expired";
            bridge.updatePairing(record);
          }
          status = "expired";
        } else {
          record.state = "cancelled";
          bridge.updatePairing(record);
          status = "cancelled";
        }
        return parseInternalResponse({
          requestId: request.requestId,
          operation: "device.pair.cancel",
          pairingId: request.pairingId,
          status,
        });
      });
    },

    async approvePairing(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "device.pair.approve")
        throw failure("invalid_request", 400);
      const approvedAtMs = currentTime();
      const verifiedOwnerId = await resolveVerifiedOwnerId(
        request,
        "device.pair.approve",
        approvedAtMs,
      );
      const result = store.withBridgeTransaction((bridge) => {
        const pairing = bridge.readPairing(request.pairingId);
        if (!pairing) throw failure("pairing_not_found", 404);
        if (pairing.state === "approved") {
          if (pairing.ownerId !== verifiedOwnerId)
            throw failure("pairing_not_found", 404);
          return {
            response: deviceApprovalResponse(
              request,
              pairing,
              "already_approved",
            ),
          };
        }
        if (
          pairing.state !== "pending" ||
          pairing.expiresAtMs <= approvedAtMs
        ) {
          if (pairing.state === "pending") {
            pairing.state = "expired";
            bridge.updatePairing(pairing);
          }
          throw failure("pairing_expired", 409);
        }

        if (
          !sameBytes(
            pairing.displayCode,
            Buffer.from(request.matchingCode, "ascii"),
          )
        ) {
          pairing.codeAttempts += 1;
          if (pairing.codeAttempts >= MAX_PAIRING_CODE_ATTEMPTS)
            pairing.state = "expired";
          bridge.updatePairing(pairing);
          return { error: "pairing_code_invalid" };
        }

        const existingDevice = bridge.readDevice(pairing.deviceId);
        if (existingDevice) throw failure("device_already_registered");
        const ownedDevices = bridge.listDevicesByOwner(verifiedOwnerId);
        const activeDevices = ownedDevices.filter(
          (device) => device.status === "active",
        );
        if (activeDevices.length >= maxActiveDevicesPerOwner)
          throw failure("device_limit_reached", 429);
        if (ownedDevices.length >= MAX_REGISTERED_DEVICES_PER_OWNER)
          throw failure("device_history_limit_reached", 429);

        const device = {
          schemaVersion: 1,
          deviceId: pairing.deviceId,
          ownerId: verifiedOwnerId,
          publicKey: pairing.publicKey,
          deviceName: pairing.deviceName,
          platform: pairing.platform,
          status: "active",
          generation: 1,
          createdAtMs: pairing.createdAtMs,
          approvedAtMs,
          revokedAtMs: null,
        };
        pairing.state = "approved";
        pairing.ownerId = verifiedOwnerId;
        pairing.approvedAtMs = approvedAtMs;
        pairing.deviceGeneration = device.generation;
        bridge.insertDevice(device);
        bridge.updatePairing(pairing);
        return {
          response: deviceApprovalResponse(request, pairing, "approved"),
        };
      });
      if (result.error) throw failure(result.error, 401);
      return result.response;
    },

    async revokeDevice(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "device.revoke")
        throw failure("invalid_request", 400);
      const revokedAtMs = currentTime();
      const verifiedOwnerId = await resolveVerifiedOwnerId(
        request,
        "device.revoke",
        revokedAtMs,
      );
      const response = store.withBridgeTransaction((bridge) => {
        const device = bridge.readDevice(request.deviceId);
        if (!device || device.ownerId !== verifiedOwnerId)
          throw failure("device_not_found", 404);
        let status;
        if (device.status === "revoked") {
          if (request.expectedGeneration !== device.generation - 1)
            throw failure("device_generation_conflict");
          status = "already_revoked";
        } else {
          if (device.generation !== request.expectedGeneration)
            throw failure("device_generation_conflict");
          if (device.generation === Number.MAX_SAFE_INTEGER)
            throw failure("device_generation_exhausted", 503);
          device.status = "revoked";
          device.generation += 1;
          device.revokedAtMs = revokedAtMs;
          bridge.updateDevice(device);
          status = "revoked";
        }
        return parseInternalResponse({
          requestId: request.requestId,
          operation: "device.revoke",
          status,
          deviceId: device.deviceId,
          deviceGeneration: device.generation,
        });
      });
      notify(onDeviceRevoked, response.deviceId, response.deviceGeneration);
      return response;
    },

    async selectRoute(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "route.select")
        throw failure("invalid_request", 400);
      const selectedAtMs = currentTime();
      const verifiedOwnerId = await resolveVerifiedOwnerId(
        request,
        "route.select",
        selectedAtMs,
      );
      const binding = store.readGameAccountBinding(verifiedOwnerId);
      if (!binding) throw failure("game_account_binding_required", 409);

      if (request.policy === "bridge_required") {
        const device = store.withBridgeTransaction((bridge) =>
          bridge.readDevice(request.activeDeviceId),
        );
        if (
          !device ||
          device.ownerId !== verifiedOwnerId ||
          device.status !== "active"
        )
          throw failure("device_not_found", 404);
      }

      const current = store.readRoutePolicy(binding.playerId);
      if (current.routeEpoch !== request.expectedRouteEpoch)
        throw failure("route_epoch_conflict");
      const changesRoute =
        current.policy !== request.policy ||
        current.activeDeviceId !== request.activeDeviceId;
      if (changesRoute) {
        try {
          await onRouteChanging({
            ownerId: verifiedOwnerId,
            playerId: binding.playerId,
            previous: current,
            next: {
              policy: request.policy,
              activeDeviceId: request.activeDeviceId,
              routeEpoch: current.routeEpoch + 1,
            },
          });
        } catch {
          throw failure("route_selection_pause_failed", 503);
        }
      }
      let selected;
      try {
        selected = store.selectRoutePolicy(binding.playerId, {
          policy: request.policy,
          activeDeviceId: request.activeDeviceId,
          expectedRouteEpoch: request.expectedRouteEpoch,
          updatedAt: selectedAtMs,
        });
      } catch (error) {
        if (error?.message === "automation_route_epoch_conflict")
          throw failure("route_epoch_conflict");
        throw failure("bridge_unavailable", 503);
      }
      if (selected.routeEpoch !== current.routeEpoch)
        notify(onRouteChanged, {
          ownerId: verifiedOwnerId,
          playerId: binding.playerId,
          previous: current,
          current: selected,
        });
      return parseInternalResponse({
        requestId: request.requestId,
        operation: "route.select",
        status:
          selected.routeEpoch === request.expectedRouteEpoch
            ? "unchanged"
            : "selected",
        routeEpoch: selected.routeEpoch,
        policy: selected.policy,
      });
    },

    async bindGameAccount(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "game_account.bind")
        throw failure("invalid_request", 400);
      const verifiedAtMs = currentTime();
      const verifiedOwnerId = await resolveVerifiedOwnerId(
        request,
        "game_account.bind",
        verifiedAtMs,
      );
      if (!gameAccountVerifier)
        throw failure("game_account_binding_unavailable", 503);

      let identity;
      try {
        identity = await gameAccountVerifier(request.authorization);
      } catch (error) {
        if (error?.code === "game_account_binding_unavailable")
          throw failure("game_account_binding_unavailable", 503);
        throw failure("invalid_game_session", 401);
      }
      let verifiedGameOwner;
      try {
        verifiedGameOwner = ownerId(identity?.telegramId);
      } catch {
        throw failure("invalid_game_session", 401);
      }
      if (verifiedGameOwner !== verifiedOwnerId)
        throw failure("game_account_mismatch", 403);

      const verifiedPlayerId = playerId(identity?.playerId);
      const previous = store.readGameAccountBinding(verifiedOwnerId);
      try {
        store.bindVerifiedGameAccount(
          verifiedOwnerId,
          verifiedPlayerId,
          verifiedAtMs,
        );
      } catch (error) {
        if (error?.message === "automation_owner_binding_conflict")
          throw failure("game_account_binding_conflict", 409);
        if (error?.message === "automation_game_account_already_bound")
          throw failure("game_account_already_bound", 409);
        throw failure("game_account_binding_unavailable", 503);
      }
      try {
        await onGameAccountBound({
          ownerId: verifiedOwnerId,
          playerId: verifiedPlayerId,
          authorization: request.authorization,
          verifiedAt: verifiedAtMs,
        });
      } catch {
        throw failure("game_account_binding_unavailable", 503);
      }
      return parseInternalResponse({
        requestId: request.requestId,
        operation: "game_account.bind",
        status: previous ? "already_bound" : "bound",
      });
    },

    issueDeviceSessionChallenge(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "device.session.challenge")
        throw failure("invalid_request", 400);
      if (
        !(sessionSigningKey instanceof Uint8Array) ||
        sessionSigningKey.length !== 32
      )
        throw failure("device_session_unavailable", 503);
      const issuedAtMs = currentTime();
      const expiresAtMs = issuedAtMs + DEVICE_SESSION_CHALLENGE_TTL_MS;
      if (!Number.isSafeInteger(expiresAtMs))
        throw failure("device_challenge_clock_exhausted", 503);
      const nonceBytes = Buffer.from(random(32));
      if (nonceBytes.byteLength !== 32)
        throw failure("device_challenge_unavailable", 503);
      const nonce = nonceBytes.toString("base64url");
      nonceBytes.fill(0);
      return store.withBridgeTransaction((bridge) => {
        bridge.pruneChallengesBefore(issuedAtMs);
        const device = bridge.readDevice(request.deviceId);
        if (!device) throw failure("device_not_found", 404);
        if (device.status === "revoked") throw failure("device_revoked", 410);
        if (device.status !== "active") throw failure("device_not_found", 404);
        const route = routeForDevice(resolveDeviceRoute, device);
        const outstanding = bridge
          .listChallengesByDevice(device.deviceId)
          .filter((challenge) => challenge.expiresAtMs > issuedAtMs);
        if (outstanding.length >= MAX_UNEXPIRED_DEVICE_CHALLENGES)
          throw failure("device_challenge_limit", 429);
        const challenge = {
          schemaVersion: 1,
          challengeId: uuid(),
          deviceId: device.deviceId,
          connectionId: uuid(),
          protocolMajor: PROTOCOL_VERSION.major,
          protocolMinor: PROTOCOL_VERSION.minor,
          purpose: "gateway-session",
          nonce,
          issuedAtMs,
          expiresAtMs,
          deviceGeneration: device.generation,
          routeEpoch: route.routeEpoch,
          consumedAtMs: null,
        };
        bridge.insertChallenge(challenge);
        return parseInternalResponse({
          requestId: request.requestId,
          operation: "device.session.challenge",
          challengeId: challenge.challengeId,
          protocolMajor: challenge.protocolMajor,
          protocolMinor: challenge.protocolMinor,
          purpose: challenge.purpose,
          deviceId: challenge.deviceId,
          connectionId: challenge.connectionId,
          nonce: challenge.nonce,
          expiresAtMs: challenge.expiresAtMs,
          deviceGeneration: challenge.deviceGeneration,
          routeEpoch: challenge.routeEpoch,
        });
      });
    },

    async proveDeviceSession(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "device.session.prove")
        throw failure("invalid_request", 400);
      if (
        !(sessionSigningKey instanceof Uint8Array) ||
        sessionSigningKey.length !== 32
      )
        throw failure("device_session_unavailable", 503);
      const checkedAtMs = currentTime();
      const initial = store.withBridgeTransaction((bridge) => {
        const challenge = bridge.readChallenge(request.challengeId);
        const device = bridge.readDevice(request.deviceId);
        if (!challenge || challenge.deviceId !== request.deviceId || !device)
          throw failure("device_challenge_not_found", 404);
        if (challenge.consumedAtMs !== null)
          throw failure("device_challenge_replayed", 409);
        if (challenge.expiresAtMs <= checkedAtMs)
          throw failure("device_challenge_expired", 409);
        if (device.status === "revoked") throw failure("device_revoked", 410);
        if (device.status !== "active") throw failure("device_not_found", 404);
        if (device.generation !== challenge.deviceGeneration)
          throw failure("device_generation_conflict", 409);
        const route = routeForDevice(resolveDeviceRoute, device);
        if (route.routeEpoch !== challenge.routeEpoch)
          throw failure("device_route_inactive", 409);
        return { challenge, device };
      });
      if (
        !verifyDeviceProof(initial.device, initial.challenge, request.signature)
      )
        throw failure("device_proof_invalid", 401);

      const expiresAtMs = checkedAtMs + DEVICE_SESSION_TTL_MS;
      if (!Number.isSafeInteger(expiresAtMs))
        throw failure("device_session_clock_exhausted", 503);
      const claims = {
        protocolMajor: initial.challenge.protocolMajor,
        protocolMinor: initial.challenge.protocolMinor,
        purpose: "device-session",
        deviceId: initial.device.deviceId,
        deviceGeneration: initial.device.generation,
        connectionId: initial.challenge.connectionId,
        routeEpoch: initial.challenge.routeEpoch,
        issuedAtMs: checkedAtMs,
        expiresAtMs,
        scopes: ["control", "data"],
      };
      const sessionCredential = await signDeviceSessionCredential(
        claims,
        sessionSigningKey,
      );
      const consumedAtMs = currentTime();
      return store.withBridgeTransaction((bridge) => {
        const challenge = bridge.readChallenge(request.challengeId);
        const device = bridge.readDevice(request.deviceId);
        if (!challenge || challenge.deviceId !== request.deviceId || !device)
          throw failure("device_challenge_not_found", 404);
        if (challenge.consumedAtMs !== null)
          throw failure("device_challenge_replayed", 409);
        if (challenge.expiresAtMs <= consumedAtMs)
          throw failure("device_challenge_expired", 409);
        if (device.status === "revoked") throw failure("device_revoked", 410);
        if (
          device.status !== "active" ||
          device.generation !== challenge.deviceGeneration
        )
          throw failure("device_generation_conflict", 409);
        const route = routeForDevice(resolveDeviceRoute, device);
        if (route.routeEpoch !== challenge.routeEpoch)
          throw failure("device_route_inactive", 409);
        challenge.consumedAtMs = consumedAtMs;
        bridge.updateChallenge(challenge);
        return parseInternalResponse({
          requestId: request.requestId,
          operation: "device.session.prove",
          status: "issued",
          deviceId: device.deviceId,
          connectionId: challenge.connectionId,
          deviceGeneration: device.generation,
          routeEpoch: challenge.routeEpoch,
          expiresAtMs,
          sessionCredential,
        });
      });
    },

    async listOwnedDevices(rawRequest) {
      const request = parseInternalRequest(rawRequest);
      if (request.operation !== "device.list")
        throw failure("invalid_request", 400);
      const listedAtMs = currentTime();
      const verifiedOwnerId = await resolveVerifiedOwnerId(
        request,
        "device.list",
        listedAtMs,
      );
      const devices = store.withBridgeTransaction((bridge) =>
        bridge.listDevicesByOwner(verifiedOwnerId).map((device) => ({
          deviceId: device.deviceId,
          deviceName: device.deviceName,
          platform: device.platform,
          status: device.status,
          generation: device.generation,
          createdAtMs: device.createdAtMs,
          approvedAtMs: device.approvedAtMs,
          revokedAtMs: device.revokedAtMs,
        })),
      );
      const binding = store.readGameAccountBinding(verifiedOwnerId);
      const route = binding ? store.readRoutePolicy(binding.playerId) : null;
      return parseInternalResponse({
        requestId: request.requestId,
        operation: "device.list",
        devices,
        routePolicy: route
          ? {
              policy: route.policy,
              activeDeviceId: route.activeDeviceId,
              routeEpoch: route.routeEpoch,
            }
          : null,
      });
    },
  });
}
