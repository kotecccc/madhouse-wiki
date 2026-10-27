import { createHash, randomUUID } from "node:crypto";

const MAX_LAUNCH_DATA_BYTES = 8 * 1024;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_PROFILE_BYTES = 256 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SAFE_REASONS = new Set([
  "invalid_game_session",
  "game_unavailable",
  "credential_unavailable",
  "storage_unavailable",
  "unknown_outcome",
]);

function authError(code, status = 409) {
  return Object.assign(new Error(code), { code, status });
}

function normalizeOwnerId(value) {
  const ownerId = String(value ?? "");
  if (
    !/^[1-9][0-9]{0,15}$/u.test(ownerId) ||
    !Number.isSafeInteger(Number(ownerId))
  )
    throw authError("invalid_request", 400);
  return ownerId;
}

function requestLaunchOwner(launchData) {
  if (
    typeof launchData !== "string" ||
    Buffer.byteLength(launchData) < 1 ||
    Buffer.byteLength(launchData) > MAX_LAUNCH_DATA_BYTES
  )
    throw authError("invalid_game_session", 400);
  try {
    const params = new URLSearchParams(launchData);
    const fields = [...params.keys()];
    if (
      new Set(fields).size !== fields.length ||
      !/^[a-f0-9]{64}$/iu.test(params.get("hash") || "") ||
      !/^\d{1,12}$/u.test(params.get("auth_date") || "")
    )
      throw new Error();
    const user = JSON.parse(params.get("user") || "null");
    if (
      !Number.isSafeInteger(user?.id) ||
      user.id < 1 ||
      String(user.id).length > 16
    )
      throw new Error();
    return String(user.id);
  } catch {
    throw authError("invalid_game_session", 400);
  }
}

function jwtExpiry(token) {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1], "base64url").toString("utf8"),
    );
    return Number.isSafeInteger(payload?.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

async function boundedJson(response, maxBytes) {
  const length = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw authError("game_unavailable", 502);
  }
  if (!response?.body) throw authError("game_unavailable", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let value = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw authError("game_unavailable", 502);
      }
      value += decoder.decode(chunk.value, { stream: true });
    }
    value += decoder.decode();
    return JSON.parse(value);
  } catch (error) {
    if (error?.code) throw error;
    throw authError("game_unavailable", 502);
  }
}

function profileIdentity(profile) {
  const numberId = (value) => {
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
      return String(value);
    if (
      typeof value === "string" &&
      /^[1-9][0-9]{0,15}$/u.test(value) &&
      Number.isSafeInteger(Number(value))
    )
      return value;
    return null;
  };
  return {
    ownerId: numberId(profile?.telegramId),
    playerId: numberId(profile?.playerId),
  };
}

function publicResult(requestId, operation, record) {
  return {
    requestId,
    operation,
    operationId: record.operationId,
    status: record.state,
    ...(record.reason
      ? {
          reason:
            record.reason === "unknown_acknowledged"
              ? "unknown_outcome"
              : record.reason,
        }
      : {}),
  };
}

const launchDigest = (value) =>
  createHash("sha256").update(value).digest("hex");

export function createBootstrapAuthCoordinator({
  store,
  credentialStore,
  issueGameCredential,
  verifyGameCredential,
  adoptGameCredential,
  now = Date.now,
  uuid = randomUUID,
} = {}) {
  if (
    typeof store?.readGameAccountBinding !== "function" ||
    typeof store?.readGameAuthRecovery !== "function" ||
    typeof store?.readGameAuthBootstrap !== "function" ||
    typeof store?.listGameAuthBootstraps !== "function" ||
    typeof store?.startGameAuthBootstrap !== "function" ||
    typeof store?.updateGameAuthBootstrap !== "function" ||
    typeof store?.bindVerifiedGameAccount !== "function" ||
    typeof credentialStore?.read !== "function" ||
    typeof credentialStore?.compareAndSwap !== "function" ||
    typeof issueGameCredential !== "function" ||
    typeof verifyGameCredential !== "function" ||
    typeof adoptGameCredential !== "function" ||
    typeof now !== "function" ||
    typeof uuid !== "function"
  )
    throw new TypeError("game_auth_bootstrap_dependencies_required");

  const flights = new Map();

  function transition(
    record,
    state,
    { reason, playerId, credentialVersion } = {},
  ) {
    const next = {
      ...record,
      state,
      updatedAt: Math.max(now(), record.updatedAt),
      ...(playerId === undefined ? {} : { playerId }),
      ...(credentialVersion === undefined ? {} : { credentialVersion }),
      ...(reason && SAFE_REASONS.has(reason) ? { reason } : {}),
    };
    if (!reason) delete next.reason;
    return store.updateGameAuthBootstrap(
      record.ownerId,
      record.operationId,
      next,
    );
  }

  function assertUnbound(ownerId, allowedPlayerId = null) {
    let binding;
    let recovery;
    try {
      if (store.isRestoreGuardActive?.())
        throw authError("game_auth_busy", 409);
      binding = store.readGameAccountBinding(ownerId);
      recovery = store.readGameAuthRecovery(ownerId);
    } catch (error) {
      if (error?.code === "game_auth_busy") throw error;
      throw authError("game_auth_unavailable", 503);
    }
    if (
      (binding && binding.playerId !== allowedPlayerId) ||
      (binding && allowedPlayerId === null) ||
      (recovery && recovery.state !== "logged_out")
    )
      throw authError("game_auth_busy", 409);
  }

  function response(requestId, operation, record) {
    return publicResult(requestId, operation, record);
  }

  async function verify(
    ownerId,
    operationId,
    consentGeneration,
    expectedVersion,
    accessToken,
  ) {
    let result;
    try {
      result = await verifyGameCredential({
        ownerId,
        operationId,
        consentGeneration,
        expectedCredentialVersion: expectedVersion,
        accessToken,
      });
      if (!result?.ok) throw authError("unknown_outcome", 502);
      return await boundedJson(result, MAX_PROFILE_BYTES);
    } catch {
      throw authError("unknown_outcome", 502);
    }
  }

  async function adoptStored(record, credential) {
    assertUnbound(record.ownerId, record.playerId);
    if (
      credential?.ownerId !== record.ownerId ||
      credential.authOperationId !== record.operationId ||
      credential.authGeneration !== record.authGeneration ||
      credential.consentGeneration !== record.consentGeneration ||
      credential.routeEpoch !== 0 ||
      credential.credentialVersion !== record.expectedCredentialVersion + 1 ||
      credential.revoked !== false ||
      !TOKEN_PATTERN.test(credential.accessToken || "") ||
      credential.expiresAt <= now()
    )
      throw authError("unknown_outcome", 409);

    let current = store.readGameAuthBootstrap(record.ownerId);
    if (current?.operationId !== record.operationId)
      throw authError("game_auth_operation_stale", 409);
    if (current.state === "exchange_pending")
      transition(current, "verification_pending");

    const profile = await verify(
      record.ownerId,
      record.operationId,
      record.consentGeneration,
      record.expectedCredentialVersion,
      credential.accessToken,
    );
    const identity = profileIdentity(profile);
    if (
      identity.ownerId !== record.ownerId ||
      !identity.playerId ||
      (record.playerId && identity.playerId !== record.playerId)
    )
      throw authError("unknown_outcome", 409);

    current = store.readGameAuthBootstrap(record.ownerId);
    if (current?.operationId !== record.operationId)
      throw authError("game_auth_operation_stale", 409);
    if (current.state === "verification_pending")
      transition(current, "credential_stored", {
        playerId: identity.playerId,
        credentialVersion: credential.credentialVersion,
      });
    else if (
      !["credential_stored", "ready"].includes(current.state) ||
      current.playerId !== identity.playerId ||
      current.credentialVersion !== credential.credentialVersion
    )
      throw authError("game_auth_operation_stale", 409);

    store.bindVerifiedGameAccount(record.ownerId, identity.playerId, now());
    await adoptGameCredential({
      ownerId: record.ownerId,
      playerId: identity.playerId,
      bootstrapOperationId: record.operationId,
      authGeneration: record.authGeneration,
      consentGeneration: record.consentGeneration,
      routeEpoch: 0,
      credentialVersion: credential.credentialVersion,
      accessToken: credential.accessToken,
      profile,
    });
    current = store.readGameAuthBootstrap(record.ownerId);
    if (current.state !== "ready") current = transition(current, "ready");
    return current;
  }

  async function run(ownerId, requestId, cargoLaunchData, digest, existing) {
    let record = existing;
    let privateCredential = null;
    if (!record) {
      const binding = store.readGameAccountBinding(ownerId);
      const recovery = store.readGameAuthRecovery(ownerId);
      const previous = store.readGameAuthBootstrap(ownerId);
      const rebootstrapAfterLogout = Boolean(
        recovery?.state === "logged_out" && previous?.state === "ready",
      );
      assertUnbound(ownerId, rebootstrapAfterLogout ? binding?.playerId : null);
      if (rebootstrapAfterLogout && !binding)
        throw authError("game_auth_busy", 409);
      try {
        privateCredential = await credentialStore.read(ownerId);
      } catch {
        throw authError("credential_unavailable", 503);
      }
      if (rebootstrapAfterLogout) {
        const tombstone = privateCredential?.record;
        if (
          !tombstone ||
          tombstone.ownerId !== ownerId ||
          tombstone.playerId !== binding.playerId ||
          tombstone.revoked !== true ||
          tombstone.authOperationId !== recovery.operationId ||
          tombstone.authGeneration !== recovery.authGeneration ||
          tombstone.consentGeneration !== recovery.consentGeneration ||
          tombstone.credentialVersion !== recovery.credentialVersion
        )
          throw authError("game_auth_busy", 409);
      } else if (privateCredential) throw authError("game_auth_busy", 409);
      const explicitUnknownRetry = Boolean(
        previous?.state === "auth_outcome_unknown" &&
        previous.playerId === null &&
        previous.credentialVersion === null &&
        !binding &&
        !recovery &&
        !privateCredential,
      );
      if (
        (previous &&
          [
            "prepared",
            "exchange_pending",
            "verification_pending",
            "credential_stored",
          ].includes(previous.state)) ||
        (previous?.state === "auth_outcome_unknown" && !explicitUnknownRetry)
      )
        throw authError("game_auth_busy", 409);
      if (previous?.state === "ready" && !rebootstrapAfterLogout)
        throw authError("game_auth_operation_stale", 409);
      const generation =
        Math.max(previous?.authGeneration || 0, recovery?.authGeneration || 0) +
        1;
      const consentGeneration =
        Math.max(
          previous?.consentGeneration || 0,
          recovery?.consentGeneration || 0,
        ) + 1;
      const timestamp = now();
      record = store.startGameAuthBootstrap(
        {
          schemaVersion: 1,
          ownerId,
          requestId,
          operationId: uuid(),
          authGeneration: generation,
          consentGeneration,
          routeEpoch: 0,
          launchDataDigest: digest,
          state: "prepared",
          expectedCredentialVersion:
            privateCredential?.record.credentialVersion ??
            previous?.credentialVersion ??
            0,
          credentialVersion: null,
          playerId: binding?.playerId ?? null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        { expectedCurrent: previous },
      );
    }

    if (record.state === "ready")
      return response(requestId, "game_auth.bootstrap", record);
    if (record.state === "credential_stored") {
      const saved = await credentialStore.read(ownerId);
      if (!saved) throw authError("credential_unavailable", 503);
      const completed = await adoptStored(record, saved.record);
      return response(requestId, "game_auth.bootstrap", completed);
    }
    if (record.state !== "prepared")
      return response(requestId, "game_auth.bootstrap", record);

    record = transition(record, "exchange_pending");
    let exchange;
    try {
      exchange = await issueGameCredential({
        ownerId,
        launchData: cargoLaunchData,
        operationId: record.operationId,
        consentGeneration: record.consentGeneration,
        expectedCredentialVersion: record.expectedCredentialVersion,
      });
    } catch {
      record = transition(record, "auth_outcome_unknown", {
        reason: "unknown_outcome",
      });
      return response(requestId, "game_auth.bootstrap", record);
    }
    if (!exchange?.ok) {
      if ([400, 401, 403].includes(exchange?.status)) {
        record = transition(record, "failed", {
          reason: "invalid_game_session",
        });
      } else {
        record = transition(record, "auth_outcome_unknown", {
          reason:
            exchange?.status === 429 ? "game_unavailable" : "unknown_outcome",
        });
      }
      return response(requestId, "game_auth.bootstrap", record);
    }

    let exchangeBody;
    try {
      exchangeBody = await boundedJson(exchange, MAX_AUTH_RESPONSE_BYTES);
    } catch {
      record = transition(record, "auth_outcome_unknown", {
        reason: "unknown_outcome",
      });
      return response(requestId, "game_auth.bootstrap", record);
    }
    const accessToken = exchangeBody?.accessToken;
    const expiry =
      typeof accessToken === "string" ? jwtExpiry(accessToken) : null;
    if (
      typeof accessToken !== "string" ||
      accessToken.length > 16_384 ||
      !TOKEN_PATTERN.test(accessToken) ||
      !expiry ||
      expiry <= now()
    ) {
      record = transition(record, "auth_outcome_unknown", {
        reason: "unknown_outcome",
      });
      return response(requestId, "game_auth.bootstrap", record);
    }

    record = transition(record, "verification_pending");
    let profile;
    try {
      profile = await verify(
        ownerId,
        record.operationId,
        record.consentGeneration,
        record.expectedCredentialVersion,
        accessToken,
      );
    } catch {
      record = transition(record, "auth_outcome_unknown", {
        reason: "unknown_outcome",
      });
      return response(requestId, "game_auth.bootstrap", record);
    }
    const identity = profileIdentity(profile);
    if (identity.ownerId !== ownerId || !identity.playerId) {
      record = transition(record, "failed", {
        reason: "invalid_game_session",
      });
      return response(requestId, "game_auth.bootstrap", record);
    }

    // Restore or a concurrent binding change may occur while the profile read
    // is in flight. Recheck before writing the separate credential boundary.
    assertUnbound(ownerId, record.playerId);

    const credentialVersion = record.expectedCredentialVersion + 1;
    const credential = {
      schemaVersion: 1,
      ownerId,
      playerId: identity.playerId,
      credentialVersion,
      authOperationId: record.operationId,
      authGeneration: record.authGeneration,
      consentGeneration: record.consentGeneration,
      routeEpoch: 0,
      expiresAt: Math.min(expiry, now() + 24 * 60 * 60_000),
      revoked: false,
      accessToken,
    };
    try {
      await credentialStore.compareAndSwap({
        ownerId,
        expectedEtag: privateCredential?.etag ?? null,
        record: credential,
      });
    } catch {
      // A restore can invalidate the journal while a storage operation is in
      // flight. Its result must not be adopted or presented as current.
      if (store.isRestoreGuardActive?.())
        throw authError("game_auth_busy", 409);
      let storedCandidate = false;
      try {
        const currentCredential = await credentialStore.read(ownerId);
        storedCandidate =
          currentCredential?.record?.authOperationId === record.operationId &&
          currentCredential.record.credentialVersion === credentialVersion;
      } catch {
        /* Preserve verification_pending until private storage can be inspected. */
      }
      if (!storedCandidate) {
        try {
          record = transition(record, "auth_outcome_unknown", {
            reason: "storage_unavailable",
          });
        } catch {
          /* Preserve the first durable failure without logging credential data. */
        }
        return response(requestId, "game_auth.bootstrap", record);
      }
    }
    assertUnbound(ownerId, record.playerId);
    try {
      record = transition(record, "credential_stored", {
        playerId: identity.playerId,
        credentialVersion,
      });
    } catch {
      // Keep verification_pending. Startup recovery can match the CAS record and
      // complete the journal transition without ever issuing another token.
      return response(requestId, "game_auth.bootstrap", record);
    }

    try {
      record = await adoptStored(record, credential);
    } catch {
      const current = store.readGameAuthBootstrap(ownerId);
      if (current?.operationId === record.operationId) record = current;
    }
    return response(requestId, "game_auth.bootstrap", record);
  }

  async function bootstrap(
    { ownerId: rawOwnerId, cargoLaunchData } = {},
    requestId,
  ) {
    const ownerId = normalizeOwnerId(rawOwnerId);
    if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId))
      throw authError("invalid_request", 400);
    if (store.isRestoreGuardActive?.()) throw authError("game_auth_busy", 409);
    if (requestLaunchOwner(cargoLaunchData) !== ownerId)
      throw authError("game_account_mismatch", 409);
    const digest = launchDigest(cargoLaunchData);
    const current = store.readGameAuthBootstrap(ownerId);
    if (current?.requestId === requestId) {
      if (current.launchDataDigest !== digest)
        throw authError("game_auth_generation_conflict", 409);
      const active = flights.get(ownerId);
      if (active?.requestId === requestId) return active.promise;
      if (!["prepared", "credential_stored"].includes(current.state))
        return response(requestId, "game_auth.bootstrap", current);
    }
    if (flights.has(ownerId)) throw authError("game_auth_busy", 409);
    const promise = run(
      ownerId,
      requestId,
      cargoLaunchData,
      digest,
      current?.requestId === requestId ? current : null,
    );
    flights.set(ownerId, { requestId, promise });
    try {
      return await promise;
    } finally {
      if (flights.get(ownerId)?.promise === promise) flights.delete(ownerId);
    }
  }

  async function prepareRestore(
    { ownerId: rawOwnerId, cargoLaunchData } = {},
    requestId,
  ) {
    const ownerId = normalizeOwnerId(rawOwnerId);
    if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId))
      throw authError("invalid_request", 400);
    if (requestLaunchOwner(cargoLaunchData) !== ownerId)
      throw authError("game_account_mismatch", 409);
    if (
      !store.isRestoreGuardActive?.() ||
      typeof store.readRestoreOwnerConsent !== "function" ||
      typeof store.startRestoreGameAuthBootstrap !== "function"
    )
      throw authError("game_auth_busy", 409);
    const consent = store.readRestoreOwnerConsent(ownerId);
    if (
      !consent ||
      consent.requestId !== requestId ||
      consent.routePolicy !== "direct"
    )
      throw authError("game_auth_busy", 409);
    const digest = launchDigest(cargoLaunchData);
    const current = store.readGameAuthBootstrap(ownerId);
    if (
      current &&
      current.state !== "cancelled" &&
      !(current.state === "failed" && current.reason === "unknown_acknowledged")
    ) {
      if (
        current.requestId !== requestId ||
        current.launchDataDigest !== digest ||
        current.routeEpoch !== 1
      )
        throw authError("game_auth_generation_conflict", 409);
      return response(requestId, "game_auth.bootstrap", current);
    }
    if (flights.has(ownerId)) throw authError("game_auth_busy", 409);
    const promise = (async () => {
      let previous;
      try {
        previous = await credentialStore.read(ownerId);
      } catch {
        throw authError("credential_unavailable", 503);
      }
      const credential = previous?.record;
      if (
        credential &&
        (credential.ownerId !== ownerId ||
          !Number.isSafeInteger(credential.credentialVersion) ||
          credential.credentialVersion < 1 ||
          !Number.isSafeInteger(credential.authGeneration) ||
          credential.authGeneration < 1 ||
          !Number.isSafeInteger(credential.consentGeneration) ||
          credential.consentGeneration < 1)
      )
        throw authError("credential_unavailable", 503);
      const authGeneration =
        Math.max(
          credential?.authGeneration ?? 0,
          current?.authGeneration ?? 0,
        ) + 1;
      const consentGeneration =
        Math.max(
          credential?.consentGeneration ?? 0,
          current?.consentGeneration ?? 0,
        ) + 1;
      const expectedCredentialVersion = credential?.credentialVersion ?? 0;
      if (
        !Number.isSafeInteger(authGeneration) ||
        !Number.isSafeInteger(consentGeneration) ||
        !Number.isSafeInteger(expectedCredentialVersion + 1)
      )
        throw authError("credential_unavailable", 503);
      const timestamp = now();
      let record;
      try {
        record = store.startRestoreGameAuthBootstrap({
          schemaVersion: 1,
          ownerId,
          requestId,
          operationId: uuid(),
          authGeneration,
          consentGeneration,
          routeEpoch: 1,
          launchDataDigest: digest,
          state: "prepared",
          expectedCredentialVersion,
          credentialVersion: null,
          playerId: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
      } catch {
        throw authError("game_auth_busy", 409);
      }
      return response(requestId, "game_auth.bootstrap", record);
    })();
    flights.set(ownerId, { requestId, promise });
    try {
      return await promise;
    } finally {
      if (flights.get(ownerId)?.promise === promise) flights.delete(ownerId);
    }
  }

  async function exchangeRestore(
    { ownerId: rawOwnerId, cargoLaunchData } = {},
    requestId,
  ) {
    const ownerId = normalizeOwnerId(rawOwnerId);
    if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId))
      throw authError("invalid_request", 400);
    if (requestLaunchOwner(cargoLaunchData) !== ownerId)
      throw authError("game_account_mismatch", 409);
    const assertCurrent = (expected) => {
      const consent = store.readRestoreOwnerConsent?.(ownerId);
      const current = store.readGameAuthBootstrap(ownerId);
      if (
        !store.isRestoreGuardActive?.() ||
        !consent ||
        consent.requestId !== requestId ||
        consent.routePolicy !== "direct" ||
        current?.operationId !== expected.operationId ||
        current.requestId !== requestId ||
        current.routeEpoch !== 1 ||
        current.launchDataDigest !== launchDigest(cargoLaunchData) ||
        current.state !== expected.state
      )
        throw authError("game_auth_operation_stale", 409);
      return current;
    };
    const initial = store.readGameAuthBootstrap(ownerId);
    if (!initial) throw authError("game_auth_operation_not_found", 404);
    assertCurrent(initial);
    if (initial.state !== "prepared")
      return response(requestId, "game_auth.bootstrap", initial);
    if (flights.has(ownerId)) throw authError("game_auth_busy", 409);
    const promise = (async () => {
      let previous;
      try {
        previous = await credentialStore.read(ownerId);
      } catch {
        throw authError("credential_unavailable", 503);
      }
      assertCurrent(initial);
      const old = previous?.record;
      if (
        (old?.credentialVersion ?? 0) !== initial.expectedCredentialVersion ||
        (old?.authGeneration ?? 0) >= initial.authGeneration ||
        (old?.consentGeneration ?? 0) >= initial.consentGeneration ||
        (old && old.ownerId !== ownerId)
      )
        throw authError("game_auth_generation_conflict", 409);
      let record = transition(initial, "exchange_pending");
      let exchange;
      try {
        exchange = await issueGameCredential({
          ownerId,
          launchData: cargoLaunchData,
          operationId: record.operationId,
          consentGeneration: record.consentGeneration,
          expectedCredentialVersion: record.expectedCredentialVersion,
        });
      } catch {
        assertCurrent(record);
        record = transition(record, "auth_outcome_unknown", {
          reason: "unknown_outcome",
        });
        return response(requestId, "game_auth.bootstrap", record);
      }
      assertCurrent(record);
      if (!exchange?.ok) {
        record = transition(
          record,
          [400, 401, 403].includes(exchange?.status)
            ? "failed"
            : "auth_outcome_unknown",
          {
            reason: [400, 401, 403].includes(exchange?.status)
              ? "invalid_game_session"
              : "unknown_outcome",
          },
        );
        return response(requestId, "game_auth.bootstrap", record);
      }
      let body;
      try {
        body = await boundedJson(exchange, MAX_AUTH_RESPONSE_BYTES);
      } catch {
        body = null;
      }
      assertCurrent(record);
      const accessToken = body?.accessToken;
      const expiry =
        typeof accessToken === "string" ? jwtExpiry(accessToken) : null;
      if (
        typeof accessToken !== "string" ||
        accessToken.length > 16_384 ||
        !TOKEN_PATTERN.test(accessToken) ||
        !expiry ||
        expiry <= now()
      ) {
        record = transition(record, "auth_outcome_unknown", {
          reason: "unknown_outcome",
        });
        return response(requestId, "game_auth.bootstrap", record);
      }
      record = transition(record, "verification_pending");
      let profile;
      try {
        profile = await verify(
          ownerId,
          record.operationId,
          record.consentGeneration,
          record.expectedCredentialVersion,
          accessToken,
        );
      } catch {
        assertCurrent(record);
        record = transition(record, "auth_outcome_unknown", {
          reason: "unknown_outcome",
        });
        return response(requestId, "game_auth.bootstrap", record);
      }
      assertCurrent(record);
      const identity = profileIdentity(profile);
      if (identity.ownerId !== ownerId || !identity.playerId) {
        record = transition(record, "failed", {
          reason: "invalid_game_session",
        });
        return response(requestId, "game_auth.bootstrap", record);
      }
      const credential = {
        schemaVersion: 1,
        ownerId,
        playerId: identity.playerId,
        credentialVersion: record.expectedCredentialVersion + 1,
        authOperationId: record.operationId,
        authGeneration: record.authGeneration,
        consentGeneration: record.consentGeneration,
        routeEpoch: record.routeEpoch,
        expiresAt: Math.min(expiry, now() + 24 * 60 * 60_000),
        revoked: false,
        accessToken,
      };
      try {
        await credentialStore.compareAndSwap({
          ownerId,
          expectedEtag: previous?.etag ?? null,
          record: credential,
        });
      } catch {
        assertCurrent(record);
        let saved;
        try {
          saved = await credentialStore.read(ownerId);
        } catch {
          saved = null;
        }
        assertCurrent(record);
        const fields = [
          "schemaVersion",
          "ownerId",
          "playerId",
          "credentialVersion",
          "authOperationId",
          "authGeneration",
          "consentGeneration",
          "routeEpoch",
          "expiresAt",
          "revoked",
          "accessToken",
        ];
        if (
          !saved?.record ||
          !fields.every((field) => saved.record[field] === credential[field])
        ) {
          record = transition(record, "auth_outcome_unknown", {
            reason: "storage_unavailable",
          });
          return response(requestId, "game_auth.bootstrap", record);
        }
      }
      assertCurrent(record);
      record = transition(record, "credential_stored", {
        playerId: identity.playerId,
        credentialVersion: credential.credentialVersion,
      });
      return response(requestId, "game_auth.bootstrap", record);
    })();
    flights.set(ownerId, { requestId, promise });
    try {
      return await promise;
    } finally {
      if (flights.get(ownerId)?.promise === promise) flights.delete(ownerId);
    }
  }

  async function stageRestore({ ownerId: rawOwnerId } = {}, requestId) {
    const ownerId = normalizeOwnerId(rawOwnerId);
    if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId))
      throw authError("invalid_request", 400);
    if (typeof store.stageRestoredGameAccount !== "function")
      throw authError("game_auth_unavailable", 503);
    const assertJournal = (expectedOperationId = null) => {
      const consent = store.readRestoreOwnerConsent?.(ownerId);
      const journal = store.readGameAuthBootstrap(ownerId);
      if (
        !store.isRestoreGuardActive?.() ||
        !consent ||
        consent.requestId !== requestId ||
        consent.routePolicy !== "direct" ||
        journal?.requestId !== requestId ||
        journal.state !== "credential_stored" ||
        journal.routeEpoch !== 1 ||
        (expectedOperationId && journal.operationId !== expectedOperationId)
      )
        throw authError("game_auth_operation_stale", 409);
      return journal;
    };
    const journal = assertJournal();
    let saved;
    try {
      saved = await credentialStore.read(ownerId);
    } catch {
      throw authError("credential_unavailable", 503);
    }
    assertJournal(journal.operationId);
    const credential = saved?.record;
    if (
      !credential ||
      credential.ownerId !== ownerId ||
      credential.playerId !== journal.playerId ||
      credential.authOperationId !== journal.operationId ||
      credential.authGeneration !== journal.authGeneration ||
      credential.consentGeneration !== journal.consentGeneration ||
      credential.credentialVersion !== journal.credentialVersion ||
      credential.routeEpoch !== journal.routeEpoch ||
      credential.revoked !== false ||
      !Number.isSafeInteger(credential.expiresAt) ||
      credential.expiresAt <= now() ||
      !TOKEN_PATTERN.test(credential.accessToken || "")
    )
      throw authError("credential_unavailable", 503);
    const profile = await verify(
      ownerId,
      journal.operationId,
      journal.consentGeneration,
      journal.expectedCredentialVersion,
      credential.accessToken,
    );
    assertJournal(journal.operationId);
    const identity = profileIdentity(profile);
    if (identity.ownerId !== ownerId || identity.playerId !== journal.playerId)
      throw authError("game_account_mismatch", 409);
    try {
      store.stageRestoredGameAccount({
        ownerId,
        playerId: journal.playerId,
        operationId: journal.operationId,
        verifiedAt: now(),
      });
    } catch {
      throw authError("game_auth_operation_stale", 409);
    }
    await adoptGameCredential({
      ownerId,
      playerId: journal.playerId,
      bootstrapOperationId: journal.operationId,
      authOperationId: journal.operationId,
      authGeneration: journal.authGeneration,
      consentGeneration: journal.consentGeneration,
      routeEpoch: journal.routeEpoch,
      credentialVersion: journal.credentialVersion,
      accessToken: credential.accessToken,
      profile,
      restored: true,
    });
    assertJournal(journal.operationId);
    return response(requestId, "game_auth.bootstrap", journal);
  }

  async function authorizeRestoreReads(
    { ownerId: rawOwnerId } = {},
    requestId,
  ) {
    const ownerId = normalizeOwnerId(rawOwnerId);
    if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId))
      throw authError("invalid_request", 400);
    if (typeof store.authorizeRestoredAccountReads !== "function")
      throw authError("game_auth_unavailable", 503);
    const check = () => {
      const consent = store.readRestoreOwnerConsent?.(ownerId);
      const journal = store.readGameAuthBootstrap(ownerId);
      if (
        !store.isRestoreGuardActive?.() ||
        consent?.requestId !== requestId ||
        consent.routePolicy !== "direct" ||
        journal?.requestId !== requestId ||
        journal.state !== "credential_stored" ||
        journal.routeEpoch !== 1
      )
        throw authError("game_auth_operation_stale", 409);
      return journal;
    };
    const journal = check();
    let saved;
    try {
      saved = await credentialStore.read(ownerId);
    } catch {
      throw authError("credential_unavailable", 503);
    }
    if (check().operationId !== journal.operationId)
      throw authError("game_auth_operation_stale", 409);
    const credential = saved?.record;
    if (
      !credential ||
      credential.ownerId !== ownerId ||
      credential.playerId !== journal.playerId ||
      credential.authOperationId !== journal.operationId ||
      credential.authGeneration !== journal.authGeneration ||
      credential.consentGeneration !== journal.consentGeneration ||
      credential.credentialVersion !== journal.credentialVersion ||
      credential.routeEpoch !== journal.routeEpoch ||
      credential.revoked !== false ||
      !Number.isSafeInteger(credential.expiresAt) ||
      credential.expiresAt <= now() ||
      !TOKEN_PATTERN.test(credential.accessToken || "")
    )
      throw authError("credential_unavailable", 503);
    try {
      store.authorizeRestoredAccountReads({
        ownerId,
        playerId: journal.playerId,
        operationId: journal.operationId,
        accessToken: credential.accessToken,
        verifiedAt: now(),
      });
    } catch {
      throw authError("game_auth_operation_stale", 409);
    }
    return response(
      requestId,
      "game_auth.bootstrap",
      store.readGameAuthBootstrap(ownerId),
    );
  }

  async function resumeRestore({ ownerId: rawOwnerId } = {}) {
    const ownerId = normalizeOwnerId(rawOwnerId);
    const consent = store.readRestoreOwnerConsent?.(ownerId);
    const journal = store.readGameAuthBootstrap(ownerId);
    if (
      !store.isRestoreGuardActive?.() ||
      !consent ||
      !journal ||
      journal.requestId !== consent.requestId ||
      journal.routeEpoch !== 1 ||
      consent.routePolicy !== "direct"
    )
      throw authError("game_auth_operation_stale", 409);
    if (flights.has(ownerId)) throw authError("game_auth_busy", 409);
    if (
      ![
        "credential_stored",
        "verification_pending",
        "auth_outcome_unknown",
      ].includes(journal.state)
    )
      throw authError("game_auth_busy", 409);
    const promise = (async () => {
      if (
        ["verification_pending", "auth_outcome_unknown"].includes(journal.state)
      ) {
        let saved;
        try {
          saved = await credentialStore.read(ownerId);
        } catch {
          throw authError("credential_unavailable", 503);
        }
        const candidate = saved?.record;
        const matches = () => {
          const current = store.readGameAuthBootstrap(ownerId);
          const latestConsent = store.readRestoreOwnerConsent(ownerId);
          return (
            store.isRestoreGuardActive() &&
            latestConsent?.requestId === consent.requestId &&
            latestConsent.routePolicy === "direct" &&
            current?.operationId === journal.operationId &&
            current.requestId === consent.requestId &&
            current.state === journal.state &&
            current.routeEpoch === 1
          );
        };
        if (!matches()) throw authError("game_auth_operation_stale", 409);
        if (
          !candidate ||
          candidate.ownerId !== ownerId ||
          candidate.authOperationId !== journal.operationId ||
          candidate.authGeneration !== journal.authGeneration ||
          candidate.consentGeneration !== journal.consentGeneration ||
          candidate.credentialVersion !==
            journal.expectedCredentialVersion + 1 ||
          candidate.routeEpoch !== journal.routeEpoch ||
          candidate.revoked !== false ||
          !Number.isSafeInteger(candidate.expiresAt) ||
          candidate.expiresAt <= now() ||
          !TOKEN_PATTERN.test(candidate.accessToken || "")
        )
          throw authError("credential_unavailable", 503);
        const profile = await verify(
          ownerId,
          journal.operationId,
          journal.consentGeneration,
          journal.expectedCredentialVersion,
          candidate.accessToken,
        );
        if (!matches()) throw authError("game_auth_operation_stale", 409);
        const identity = profileIdentity(profile);
        if (
          identity.ownerId !== ownerId ||
          identity.playerId !== candidate.playerId
        )
          throw authError("game_account_mismatch", 409);
        transition(journal, "credential_stored", {
          playerId: identity.playerId,
          credentialVersion: candidate.credentialVersion,
        });
      }
      await stageRestore({ ownerId }, consent.requestId);
      return authorizeRestoreReads({ ownerId }, consent.requestId);
    })();
    flights.set(ownerId, { requestId: consent.requestId, promise });
    try {
      return await promise;
    } finally {
      if (flights.get(ownerId)?.promise === promise) flights.delete(ownerId);
    }
  }

  function cancelPreparedRestore({ ownerId: rawOwnerId } = {}) {
    const ownerId = normalizeOwnerId(rawOwnerId);
    const consent = store.readRestoreOwnerConsent?.(ownerId);
    const journal = store.readGameAuthBootstrap(ownerId);
    if (
      !store.isRestoreGuardActive?.() ||
      !consent ||
      !journal ||
      journal.requestId !== consent.requestId ||
      journal.routeEpoch !== 1 ||
      consent.routePolicy !== "direct" ||
      journal.state !== "prepared" ||
      flights.has(ownerId)
    )
      throw authError("game_auth_busy", 409);
    try {
      transition(journal, "cancelled");
    } catch {
      throw authError("game_auth_operation_stale", 409);
    }
    return { status: "cancelled" };
  }

  async function acknowledgeUnknownRestore({
    ownerId: rawOwnerId,
    challenge,
    confirmedAt,
    identityIssuedAt,
  } = {}) {
    const ownerId = normalizeOwnerId(rawOwnerId);
    const consent = store.readRestoreOwnerConsent?.(ownerId);
    const journal = store.readGameAuthBootstrap(ownerId);
    if (
      !store.isRestoreGuardActive?.() ||
      !consent ||
      !journal ||
      journal.requestId !== consent.requestId ||
      !["auth_outcome_unknown", "exchange_pending"].includes(journal.state) ||
      journal.routeEpoch !== 1 ||
      flights.has(ownerId) ||
      typeof store.acknowledgeUnknownRestore !== "function"
    )
      throw authError("game_auth_busy", 409);
    let saved;
    try {
      saved = await credentialStore.read(ownerId);
    } catch {
      throw authError("credential_unavailable", 503);
    }
    const current = store.readGameAuthBootstrap(ownerId);
    if (
      flights.has(ownerId) ||
      current?.operationId !== journal.operationId ||
      current.state !== journal.state
    )
      throw authError("game_auth_operation_stale", 409);
    if (
      saved?.record?.authOperationId === journal.operationId ||
      (saved?.record?.credentialVersion ?? 0) !==
        journal.expectedCredentialVersion
    )
      throw authError("credential_unavailable", 503);
    try {
      return store.acknowledgeUnknownRestore({
        ownerId,
        operationId: journal.operationId,
        challenge,
        confirmedAt,
        identityIssuedAt,
      });
    } catch {
      throw authError("game_auth_operation_stale", 409);
    }
  }

  async function bootstrapStatus({ ownerId: rawOwnerId } = {}, requestId) {
    const ownerId = normalizeOwnerId(rawOwnerId);
    if (typeof requestId !== "string" || !UUID_PATTERN.test(requestId))
      throw authError("invalid_request", 400);
    const recovery = store.readGameAuthRecovery(ownerId);
    const bootstrap = store.readGameAuthBootstrap(ownerId);
    const bootstrapAfterLogout = Boolean(
      recovery?.state === "logged_out" &&
      bootstrap?.authGeneration > recovery.authGeneration &&
      bootstrap?.consentGeneration > recovery.consentGeneration,
    );
    const record =
      recovery && recovery.state !== "ready" && !bootstrapAfterLogout
        ? recovery
        : bootstrapAfterLogout
          ? bootstrap
          : recovery?.state === "ready"
            ? recovery
            : bootstrap;
    if (!record) throw authError("game_auth_operation_not_found", 404);

    if (record.state === "ready") {
      let binding;
      let saved;
      let route;
      try {
        binding = store.readGameAccountBinding(ownerId);
        saved = await credentialStore.read(ownerId);
        route = binding && store.readRoutePolicy(binding.playerId);
      } catch {
        throw authError("credential_unavailable", 503);
      }
      const credential = saved?.record;
      if (
        !binding ||
        binding.playerId !== record.playerId ||
        !route ||
        route.routeEpoch !== record.routeEpoch ||
        !credential ||
        credential.ownerId !== ownerId ||
        credential.playerId !== record.playerId ||
        credential.authOperationId !== record.operationId ||
        credential.authGeneration !== record.authGeneration ||
        credential.consentGeneration !== record.consentGeneration ||
        credential.routeEpoch !== record.routeEpoch ||
        credential.credentialVersion !== record.credentialVersion ||
        credential.revoked !== false ||
        credential.expiresAt <= now() ||
        !TOKEN_PATTERN.test(credential.accessToken || "")
      )
        throw authError("game_auth_operation_not_found", 404);
    }
    return response(requestId, "game_auth.bootstrap.status", record);
  }

  async function recover() {
    for (const stored of store.listGameAuthBootstraps()) {
      let record = store.readGameAuthBootstrap(stored.ownerId);
      if (!record) continue;
      if (record.state === "prepared") {
        transition(record, "failed", { reason: "credential_unavailable" });
        continue;
      }
      if (record.state === "credential_stored") {
        try {
          const saved = await credentialStore.read(record.ownerId);
          if (saved) await adoptStored(record, saved.record);
          else
            transition(record, "auth_outcome_unknown", {
              reason: "credential_unavailable",
            });
        } catch {
          // Keep credential_stored durable; the next runtime can retry adoption.
        }
        continue;
      }
      if (["exchange_pending", "verification_pending"].includes(record.state)) {
        let saved;
        try {
          saved = await credentialStore.read(record.ownerId);
        } catch {
          continue;
        }
        if (
          saved?.record?.authOperationId === record.operationId &&
          saved.record.credentialVersion ===
            record.expectedCredentialVersion + 1
        ) {
          try {
            await adoptStored(record, saved.record);
            continue;
          } catch {
            /* Fall through to unknown; never replay an issuance. */
          }
        }
        try {
          transition(record, "auth_outcome_unknown", {
            reason: "unknown_outcome",
          });
        } catch {
          /* Leave the existing pending record fail-closed if storage is down. */
        }
      }
    }
  }

  return Object.freeze({
    bootstrap,
    prepareRestore,
    exchangeRestore,
    stageRestore,
    authorizeRestoreReads,
    resumeRestore,
    cancelPreparedRestore,
    acknowledgeUnknownRestore,
    bootstrapStatus,
    recover,
  });
}
