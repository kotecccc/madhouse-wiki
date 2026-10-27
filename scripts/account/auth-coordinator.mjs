import { randomUUID } from "node:crypto";

const AUTH_TIMEOUT_MS = 30_000;
const MAX_LAUNCH_DATA_BYTES = 16 * 1024;
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024;
const MAX_PROFILE_BYTES = 256 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const SAFE_REASONS = new Set([
  "auth_required",
  "device_offline",
  "invalid_game_session",
  "game_unavailable",
  "consent_required",
  "route_stale",
  "credential_unavailable",
  "storage_unavailable",
  "unknown_outcome",
]);
const AUTH_RECOVERY_REVISION_FIELDS = [
  "operationId",
  "authGeneration",
  "consentGeneration",
  "routeEpoch",
  "state",
  "expectedCredentialVersion",
  "credentialVersion",
  "updatedAt",
];

function sameAuthRecoveryRevision(current, expected) {
  if (expected == null) return current == null;
  return Boolean(
    current &&
    AUTH_RECOVERY_REVISION_FIELDS.every(
      (field) => current[field] === expected[field],
    ),
  );
}

function authError(code, status = 409) {
  return Object.assign(new Error(code), { code, status });
}

function normalizedOwnerId(value) {
  const ownerId = String(value ?? "");
  if (
    !/^[1-9][0-9]{0,15}$/u.test(ownerId) ||
    !Number.isSafeInteger(Number(ownerId))
  )
    throw authError("invalid_request", 400);
  return ownerId;
}

function positiveInteger(value, code = "invalid_request") {
  if (!Number.isSafeInteger(value) || value < 1) throw authError(code, 400);
  return value;
}

function parseJwtExpiry(accessToken) {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1], "base64url").toString("utf8"),
    );
    return Number.isSafeInteger(payload?.exp) && payload.exp > 0
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

async function boundedJson(response, maxBytes) {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > maxBytes) {
    await response.body?.cancel();
    throw authError("game_unavailable", 502);
  }
  if (!response.body) throw authError("game_unavailable", 502);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw authError("game_unavailable", 502);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === "game_unavailable") throw error;
    throw authError("game_unavailable", 502);
  }
}

function profileIdentity(profile) {
  const telegramId =
    typeof profile?.telegramId === "number" &&
    Number.isSafeInteger(profile.telegramId) &&
    profile.telegramId > 0
      ? String(profile.telegramId)
      : typeof profile?.telegramId === "string" &&
          /^[1-9][0-9]{0,15}$/u.test(profile.telegramId) &&
          Number.isSafeInteger(Number(profile.telegramId))
        ? profile.telegramId
        : null;
  const playerId =
    typeof profile?.playerId === "number" &&
    Number.isSafeInteger(profile.playerId) &&
    profile.playerId > 0
      ? String(profile.playerId)
      : typeof profile?.playerId === "string" &&
          /^[1-9][0-9]{0,15}$/u.test(profile.playerId) &&
          Number.isSafeInteger(Number(profile.playerId))
        ? profile.playerId
        : null;
  return { telegramId, playerId };
}

function publicResult(requestId, operation, record) {
  return {
    requestId,
    operation,
    operationId: record.operationId,
    status: record.state,
    ...(record.reason ? { reason: record.reason } : {}),
  };
}

export function createAuthCoordinator({
  store,
  credentialStore,
  controlGateway,
  issueGameCredential,
  verifyGameCredential,
  adoptGameCredential,
  revokeGameSession,
  isDeviceActive,
  now = Date.now,
  uuid = randomUUID,
} = {}) {
  if (
    typeof store?.readGameAccountBinding !== "function" ||
    typeof store?.readGameAuthRecovery !== "function" ||
    typeof store?.listGameAuthRecoveries !== "function" ||
    typeof store?.startGameAuthRecovery !== "function" ||
    typeof store?.beginGameAuthLogout !== "function" ||
    typeof store?.updateGameAuthRecovery !== "function" ||
    typeof store?.readRoutePolicy !== "function" ||
    typeof credentialStore?.read !== "function" ||
    typeof credentialStore?.compareAndSwap !== "function" ||
    typeof controlGateway?.requestGameLaunch !== "function" ||
    typeof issueGameCredential !== "function" ||
    typeof verifyGameCredential !== "function" ||
    typeof adoptGameCredential !== "function" ||
    typeof revokeGameSession !== "function" ||
    typeof isDeviceActive !== "function" ||
    typeof now !== "function" ||
    typeof uuid !== "function"
  )
    throw new TypeError("game_auth_coordinator_dependencies_required");

  const flights = new Map();
  let closed = false;

  function currentRoute(ownerId, record) {
    let binding;
    let route;
    try {
      binding = store.readGameAccountBinding(ownerId);
      route = binding ? store.readRoutePolicy(binding.playerId) : null;
    } catch {
      throw authError("game_auth_unavailable", 503);
    }
    if (!binding || binding.playerId !== record.playerId)
      throw authError("game_account_binding_required", 409);
    if (
      !route ||
      route.policy !== "bridge_required" ||
      route.routeEpoch !== record.routeEpoch ||
      typeof route.activeDeviceId !== "string" ||
      !UUID_PATTERN.test(route.activeDeviceId)
    )
      throw authError("route_stale", 409);
    let deviceActive;
    try {
      deviceActive = isDeviceActive({
        ownerId,
        playerId: binding.playerId,
        deviceId: route.activeDeviceId,
      });
    } catch {
      throw authError("game_auth_unavailable", 503);
    }
    if (deviceActive !== true) throw authError("route_stale", 409);
    return { binding, route };
  }

  function assertCurrent(context, expectedStates) {
    if (closed || context.controller.signal.aborted)
      throw authError("game_auth_cancelled", 409);
    const current = store.readGameAuthRecovery(context.record.ownerId);
    if (
      !current ||
      current.operationId !== context.record.operationId ||
      current.authGeneration !== context.record.authGeneration ||
      current.consentGeneration !== context.record.consentGeneration ||
      !expectedStates.includes(current.state)
    )
      throw authError("game_auth_operation_stale", 409);
    return currentRoute(context.record.ownerId, context.record);
  }

  function transition(context, state, { reason, credentialVersion } = {}) {
    const current = store.readGameAuthRecovery(context.record.ownerId);
    if (
      !current ||
      current.operationId !== context.record.operationId ||
      current.authGeneration !== context.record.authGeneration
    )
      throw authError("game_auth_operation_stale", 409);
    const updatedAt = Math.max(now(), current.updatedAt);
    const next = {
      ...current,
      state,
      ...(credentialVersion === undefined ? {} : { credentialVersion }),
      ...(reason && SAFE_REASONS.has(reason) ? { reason } : {}),
      updatedAt,
    };
    if (!reason) delete next.reason;
    context.record = store.updateGameAuthRecovery(
      current.ownerId,
      current.operationId,
      next,
    );
    return context.record;
  }

  function terminalFailure(context, reason, { unknown = false } = {}) {
    const current = store.readGameAuthRecovery(context.record.ownerId);
    if (
      !current ||
      current.operationId !== context.record.operationId ||
      ["ready", "failed", "cancelled", "auth_outcome_unknown"].includes(
        current.state,
      )
    )
      return current;
    const target = unknown ? "auth_outcome_unknown" : "failed";
    context.record = store.updateGameAuthRecovery(
      current.ownerId,
      current.operationId,
      {
        ...current,
        state: target,
        reason: SAFE_REASONS.has(reason) ? reason : "unknown_outcome",
        updatedAt: Math.max(now(), current.updatedAt),
      },
    );
    return context.record;
  }

  async function verifyCandidate(
    context,
    accessToken,
    { recovery = false } = {},
  ) {
    assertCurrent(
      context,
      recovery
        ? [
            "verification_pending",
            "credential_stored",
            "auth_outcome_unknown",
            "ready",
          ]
        : ["verification_pending"],
    );
    let response;
    try {
      response = await verifyGameCredential({
        ownerId: context.record.ownerId,
        playerId: context.record.playerId,
        accessToken,
        routeEpoch: context.record.routeEpoch,
        deviceId: context.route.activeDeviceId,
        signal: context.controller.signal,
      });
    } catch {
      throw authError("candidate_verification_unknown", 502);
    }
    if (!response?.ok) throw authError("candidate_verification_unknown", 502);
    const profile = await boundedJson(response, MAX_PROFILE_BYTES);
    const identity = profileIdentity(profile);
    if (
      identity.telegramId !== context.record.ownerId ||
      identity.playerId !== context.record.playerId
    )
      throw authError("game_account_mismatch", 409);
    assertCurrent(
      context,
      recovery
        ? [
            "verification_pending",
            "credential_stored",
            "auth_outcome_unknown",
            "ready",
          ]
        : ["verification_pending"],
    );
    return profile;
  }

  async function adopt(
    context,
    credential,
    profile,
    { alreadyReady = false } = {},
  ) {
    const allowedStates = alreadyReady ? ["ready"] : ["credential_stored"];
    assertCurrent(context, allowedStates);
    await adoptGameCredential({
      ownerId: context.record.ownerId,
      playerId: context.record.playerId,
      authOperationId: context.record.operationId,
      authGeneration: context.record.authGeneration,
      consentGeneration: context.record.consentGeneration,
      routeEpoch: context.record.routeEpoch,
      accessToken: credential.accessToken,
      profile,
      credentialVersion: credential.credentialVersion,
    });
    assertCurrent(context, allowedStates);
    if (!alreadyReady)
      transition(context, "ready", {
        credentialVersion: credential.credentialVersion,
      });
  }

  async function storeCredential(context, accessToken) {
    const current = await credentialStore.read(context.record.ownerId);
    if ((current?.etag ?? null) !== context.credentialEtag)
      throw authError("credential_changed", 409);
    const expiry = parseJwtExpiry(accessToken);
    if (!expiry || expiry <= now())
      throw authError("credential_unavailable", 409);
    const candidate = {
      schemaVersion: 1,
      ownerId: context.record.ownerId,
      playerId: context.record.playerId,
      credentialVersion: context.record.expectedCredentialVersion + 1,
      authOperationId: context.record.operationId,
      authGeneration: context.record.authGeneration,
      consentGeneration: context.record.consentGeneration,
      routeEpoch: context.record.routeEpoch,
      expiresAt: Math.min(expiry, now() + 24 * 60 * 60 * 1000),
      revoked: false,
      accessToken,
    };
    assertCurrent(context, ["verification_pending"]);
    let commit;
    try {
      commit = await credentialStore.compareAndSwap({
        ownerId: context.record.ownerId,
        expectedEtag: context.credentialEtag,
        record: candidate,
      });
    } catch {
      const recovered = await credentialStore
        .read(context.record.ownerId)
        .catch(() => null);
      if (
        recovered?.record.authOperationId === context.record.operationId &&
        recovered.record.credentialVersion === candidate.credentialVersion
      )
        commit = {
          etag: recovered.etag,
          credentialVersion: candidate.credentialVersion,
        };
      else throw authError("credential_commit_unknown", 503);
    }
    const latest = store.readGameAuthRecovery(context.record.ownerId);
    if (
      latest?.operationId !== context.record.operationId ||
      latest.state !== "verification_pending"
    )
      throw authError("consent_changed_after_commit", 409);
    transition(context, "credential_stored", {
      credentialVersion: commit.credentialVersion,
    });
    return { record: candidate, etag: commit.etag };
  }

  async function run(context) {
    let launchData;
    try {
      context.route = currentRoute(
        context.record.ownerId,
        context.record,
      ).route;
      transition(context, "launch_requested");
      const launch = await controlGateway.requestGameLaunch({
        ownerId: context.record.ownerId,
        deviceId: context.route.activeDeviceId,
        operationId: context.record.operationId,
        consentGeneration: context.record.consentGeneration,
        routeEpoch: context.record.routeEpoch,
        signal: context.controller.signal,
        timeoutMs: AUTH_TIMEOUT_MS,
      });
      if (launch?.status === "cancelled") {
        const current = store.readGameAuthRecovery(context.record.ownerId);
        if (current?.operationId === context.record.operationId) {
          const next = {
            ...current,
            state: "cancelled",
            updatedAt: Math.max(now(), current.updatedAt),
          };
          context.record = store.updateGameAuthRecovery(
            current.ownerId,
            current.operationId,
            next,
          );
        }
        return;
      }
      if (
        launch?.status !== "ready" ||
        typeof launch.launchData !== "string" ||
        Buffer.byteLength(launch.launchData) < 1 ||
        Buffer.byteLength(launch.launchData) > MAX_LAUNCH_DATA_BYTES
      ) {
        terminalFailure(context, "device_offline");
        return;
      }
      launchData = launch.launchData;
      assertCurrent(context, ["launch_requested"]);
      transition(context, "exchange_pending");
      let response;
      try {
        response = await issueGameCredential({
          ownerId: context.record.ownerId,
          playerId: context.record.playerId,
          launchData,
          operationId: context.record.operationId,
          consentGeneration: context.record.consentGeneration,
          routeEpoch: context.record.routeEpoch,
          deviceId: context.route.activeDeviceId,
          signal: context.controller.signal,
        });
      } catch (error) {
        if (
          [
            "game_route_stale",
            "game_route_unavailable",
            "game_auth_coordinator_required",
          ].includes(error?.code)
        ) {
          terminalFailure(context, "route_stale");
          return;
        }
        terminalFailure(context, "unknown_outcome", { unknown: true });
        return;
      } finally {
        launchData = undefined;
      }
      if (!response?.ok) {
        if (
          Number.isInteger(response?.status) &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        )
          terminalFailure(context, "invalid_game_session");
        else terminalFailure(context, "unknown_outcome", { unknown: true });
        return;
      }
      let authBody;
      try {
        authBody = await boundedJson(response, MAX_AUTH_RESPONSE_BYTES);
      } catch {
        terminalFailure(context, "unknown_outcome", { unknown: true });
        return;
      }
      const accessToken = authBody?.accessToken;
      if (
        typeof accessToken !== "string" ||
        accessToken.length > 16_384 ||
        !TOKEN_PATTERN.test(accessToken)
      ) {
        terminalFailure(context, "unknown_outcome", { unknown: true });
        return;
      }
      assertCurrent(context, ["exchange_pending"]);
      transition(context, "verification_pending");
      const profile = await verifyCandidate(context, accessToken);
      const credential = await storeCredential(context, accessToken);
      await adopt(context, credential.record, profile);
    } catch (error) {
      const current = store.readGameAuthRecovery(context.record.ownerId);
      if (
        current?.operationId === context.record.operationId &&
        !["ready", "failed", "cancelled", "auth_outcome_unknown"].includes(
          current.state,
        )
      ) {
        if (
          ["exchange_pending", "verification_pending"].includes(current.state)
        )
          terminalFailure(context, "unknown_outcome", { unknown: true });
        else if (current.state === "credential_stored")
          terminalFailure(context, "credential_unavailable", { unknown: true });
        else if (
          current.state === "launch_requested" &&
          error?.code === "game_auth_cancelled"
        ) {
          context.record = store.updateGameAuthRecovery(
            current.ownerId,
            current.operationId,
            {
              ...current,
              state: "cancelled",
              updatedAt: Math.max(now(), current.updatedAt),
            },
          );
        } else terminalFailure(context, "route_stale");
      }
    } finally {
      if (flights.get(context.record.ownerId) === context)
        flights.delete(context.record.ownerId);
    }
  }

  function readOperation(ownerId, operationId) {
    const record = store.readGameAuthRecovery(ownerId);
    if (!record || record.operationId !== operationId)
      throw authError("game_auth_operation_not_found", 404);
    return record;
  }

  async function start(
    { ownerId, consentGeneration, routeEpoch } = {},
    requestId,
  ) {
    if (closed) throw authError("game_auth_unavailable", 503);
    const normalized = normalizedOwnerId(ownerId);
    const requestedConsentGeneration = positiveInteger(consentGeneration);
    positiveInteger(routeEpoch);
    if (flights.has(normalized)) throw authError("game_auth_busy", 409);
    const binding = store.readGameAccountBinding(normalized);
    if (!binding) throw authError("game_account_binding_required", 409);
    const route = store.readRoutePolicy(binding.playerId);
    if (
      route.policy !== "bridge_required" ||
      route.routeEpoch !== routeEpoch ||
      typeof route.activeDeviceId !== "string" ||
      !UUID_PATTERN.test(route.activeDeviceId)
    )
      throw authError("route_stale", 409);
    const previous = store.readGameAuthRecovery(normalized);
    const currentCredential = await credentialStore.read(normalized);
    const latest = store.readGameAuthRecovery(normalized);
    if (!sameAuthRecoveryRevision(latest, previous))
      throw authError("game_auth_operation_stale", 409);
    const latestRoute = currentRoute(normalized, {
      playerId: binding.playerId,
      routeEpoch,
    }).route;
    if (latestRoute.activeDeviceId !== route.activeDeviceId)
      throw authError("route_stale", 409);
    if (
      currentCredential &&
      (currentCredential.record.playerId !== binding.playerId ||
        currentCredential.record.ownerId !== normalized)
    )
      throw authError("game_account_mismatch", 409);
    const nextConsentGeneration = Math.max(
      requestedConsentGeneration,
      (previous?.consentGeneration || 0) + 1,
    );
    if (
      previous?.state === "ready" &&
      currentCredential?.record.credentialVersion !== previous.credentialVersion
    )
      throw authError("credential_unavailable", 409);
    const operationId = uuid();
    if (!UUID_PATTERN.test(operationId))
      throw authError("game_auth_unavailable", 503);
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 1)
      throw authError("game_auth_unavailable", 503);
    const record = {
      schemaVersion: 1,
      ownerId: normalized,
      playerId: binding.playerId,
      operationId,
      authGeneration: (previous?.authGeneration || 0) + 1,
      consentGeneration: nextConsentGeneration,
      routeEpoch,
      state: "created",
      expectedCredentialVersion:
        currentCredential?.record.credentialVersion || 0,
      credentialVersion: null,
      updatedAt: timestamp,
    };
    try {
      store.startGameAuthRecovery(record, {
        replaceUnknown: true,
        expectedCurrent: previous ?? null,
      });
    } catch (error) {
      if (error?.message === "automation_game_auth_operation_pending")
        throw authError("game_auth_busy", 409);
      if (error?.message === "automation_game_auth_recovery_changed")
        throw authError("game_auth_operation_stale", 409);
      if (error?.message === "automation_game_auth_generation_conflict")
        throw authError("game_auth_generation_conflict", 409);
      throw authError("game_auth_unavailable", 503);
    }
    const context = {
      record,
      controller: new AbortController(),
      route,
      credentialEtag: currentCredential?.etag ?? null,
    };
    flights.set(normalized, context);
    void run(context);
    return publicResult(requestId, "game_auth.start", record);
  }

  function status({ ownerId, operationId } = {}, requestId) {
    const record = readOperation(normalizedOwnerId(ownerId), operationId);
    return publicResult(requestId, "game_auth.status", record);
  }

  async function cancel({ ownerId, operationId } = {}, requestId) {
    const normalized = normalizedOwnerId(ownerId);
    const current = readOperation(normalized, operationId);
    const context = flights.get(normalized);
    if (["created", "launch_requested"].includes(current.state)) {
      const next = {
        ...current,
        state: "cancelled",
        updatedAt: Math.max(now(), current.updatedAt),
      };
      store.updateGameAuthRecovery(normalized, operationId, next);
      context?.controller.abort();
      return publicResult(requestId, "game_auth.cancel", next);
    }
    if (
      [
        "exchange_pending",
        "verification_pending",
        "credential_stored",
      ].includes(current.state)
    ) {
      const next = store.updateGameAuthRecovery(normalized, operationId, {
        ...current,
        state: "auth_outcome_unknown",
        reason: "consent_required",
        updatedAt: Math.max(now(), current.updatedAt),
      });
      context?.controller.abort();
      return publicResult(requestId, "game_auth.cancel", next);
    }
    return publicResult(requestId, "game_auth.cancel", current);
  }

  function invalidateContext(context) {
    try {
      const current = store.readGameAuthRecovery(context.record.ownerId);
      if (
        current &&
        current.operationId === context.record.operationId &&
        current.authGeneration === context.record.authGeneration
      ) {
        if (["created", "launch_requested"].includes(current.state)) {
          store.updateGameAuthRecovery(
            context.record.ownerId,
            current.operationId,
            {
              ...current,
              state: "cancelled",
              updatedAt: Math.max(now(), current.updatedAt),
            },
          );
        } else if (
          [
            "exchange_pending",
            "verification_pending",
            "credential_stored",
            "auth_outcome_unknown",
          ].includes(current.state) &&
          current.reason !== "consent_required"
        ) {
          store.updateGameAuthRecovery(
            context.record.ownerId,
            current.operationId,
            {
              ...current,
              state: "auth_outcome_unknown",
              reason: "consent_required",
              updatedAt: Math.max(now(), current.updatedAt),
            },
          );
        }
      }
    } catch {
      // The revoked device and route are checked again after every await.
    } finally {
      context.controller.abort();
    }
  }

  function invalidateDevice(deviceId) {
    if (typeof deviceId !== "string" || !UUID_PATTERN.test(deviceId)) return 0;
    let invalidated = 0;
    for (const context of flights.values()) {
      if (context.route?.activeDeviceId !== deviceId) continue;
      invalidateContext(context);
      invalidated++;
    }
    return invalidated;
  }

  function invalidateRoute({ ownerId, previous, current } = {}) {
    const normalized = String(ownerId ?? "");
    if (
      !/^[1-9][0-9]{0,15}$/u.test(normalized) ||
      !Number.isSafeInteger(previous?.routeEpoch) ||
      !Number.isSafeInteger(current?.routeEpoch) ||
      previous.routeEpoch === current.routeEpoch
    )
      return 0;
    let invalidated = 0;
    for (const context of flights.values()) {
      if (
        context.record.ownerId !== normalized ||
        context.record.routeEpoch !== previous.routeEpoch
      )
        continue;
      invalidateContext(context);
      invalidated++;
    }
    return invalidated;
  }

  function tombstoneMatches(stored, record) {
    return Boolean(
      stored?.record?.revoked === true &&
      stored.record.ownerId === record.ownerId &&
      stored.record.playerId === record.playerId &&
      stored.record.authOperationId === record.operationId &&
      stored.record.authGeneration === record.authGeneration &&
      stored.record.consentGeneration === record.consentGeneration,
    );
  }

  async function finishLogout(record, requestId) {
    const current = store.readGameAuthRecovery(record.ownerId);
    if (
      !current ||
      current.operationId !== record.operationId ||
      current.authGeneration !== record.authGeneration ||
      !["logout_pending", "logged_out"].includes(current.state)
    )
      throw authError("game_auth_operation_stale", 409);

    await revokeGameSession({
      ownerId: record.ownerId,
      playerId: record.playerId,
      operationId: record.operationId,
      authGeneration: record.authGeneration,
      consentGeneration: record.consentGeneration,
    });

    let tombstone = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const stored = await credentialStore.read(record.ownerId);
      if (tombstoneMatches(stored, record)) {
        tombstone = stored;
        break;
      }
      if (
        stored &&
        (stored.record.ownerId !== record.ownerId ||
          stored.record.playerId !== record.playerId)
      )
        throw authError("game_account_mismatch", 409);
      const candidate = {
        schemaVersion: 1,
        ownerId: record.ownerId,
        playerId: record.playerId,
        credentialVersion: (stored?.record.credentialVersion || 0) + 1,
        authOperationId: record.operationId,
        authGeneration: record.authGeneration,
        consentGeneration: record.consentGeneration,
        routeEpoch: record.routeEpoch,
        expiresAt: 0,
        revoked: true,
        accessToken: null,
      };
      try {
        const committed = await credentialStore.compareAndSwap({
          ownerId: record.ownerId,
          expectedEtag: stored?.etag ?? null,
          record: candidate,
        });
        tombstone = {
          record: candidate,
          etag: committed.etag,
        };
        break;
      } catch (error) {
        const recovered = await credentialStore
          .read(record.ownerId)
          .catch(() => null);
        if (tombstoneMatches(recovered, record)) {
          tombstone = recovered;
          break;
        }
        if (error?.code !== "game_credential_conflict")
          throw authError("credential_unavailable", 503);
      }
    }
    if (!tombstone) throw authError("credential_unavailable", 503);

    const latest = store.readGameAuthRecovery(record.ownerId);
    if (
      !latest ||
      latest.operationId !== record.operationId ||
      latest.authGeneration !== record.authGeneration
    )
      throw authError("game_auth_operation_stale", 409);
    if (
      latest.state !== "logged_out" ||
      latest.credentialVersion !== tombstone.record.credentialVersion
    )
      store.updateGameAuthRecovery(record.ownerId, record.operationId, {
        ...latest,
        state: "logged_out",
        credentialVersion: tombstone.record.credentialVersion,
        updatedAt: Math.max(now(), latest.updatedAt),
      });
    const completed = store.readGameAuthRecovery(record.ownerId);
    return publicResult(requestId, "game_auth.logout", completed);
  }

  async function logout({ ownerId } = {}, requestId) {
    if (closed) throw authError("game_auth_unavailable", 503);
    const normalized = normalizedOwnerId(ownerId);
    const binding = store.readGameAccountBinding(normalized);
    if (!binding) throw authError("game_account_binding_required", 409);
    let record = store.readGameAuthRecovery(normalized);
    if (!record || !["logout_pending", "logged_out"].includes(record.state)) {
      const bootstrap = store.readGameAuthBootstrap?.(normalized) || null;
      const previous =
        record || (bootstrap?.state === "ready" ? bootstrap : null);
      const route = store.readRoutePolicy(binding.playerId);
      const operationId = uuid();
      if (
        !UUID_PATTERN.test(operationId) ||
        operationId === record?.operationId
      )
        throw authError("game_auth_unavailable", 503);
      const timestamp = now();
      if (!Number.isSafeInteger(timestamp) || timestamp < 1)
        throw authError("game_auth_unavailable", 503);
      const next = {
        schemaVersion: 1,
        ownerId: normalized,
        playerId: binding.playerId,
        operationId,
        authGeneration: (previous?.authGeneration || 0) + 1,
        consentGeneration: (previous?.consentGeneration || 0) + 1,
        routeEpoch: Math.max(
          previous?.routeEpoch || 0,
          route?.routeEpoch || 0,
          1,
        ),
        state: "logout_pending",
        expectedCredentialVersion:
          previous?.credentialVersion ??
          previous?.expectedCredentialVersion ??
          0,
        credentialVersion: null,
        updatedAt: Math.max(timestamp, previous?.updatedAt || 0),
      };
      try {
        record = store.beginGameAuthLogout(next);
      } catch (error) {
        if (error?.message === "automation_game_auth_operation_pending") {
          const current = store.readGameAuthRecovery(normalized);
          if (current?.state === "logout_pending") record = current;
          else throw authError("game_auth_busy", 409);
        } else if (
          error?.message === "automation_game_auth_generation_conflict"
        )
          throw authError("game_auth_generation_conflict", 409);
        else throw authError("game_auth_unavailable", 503);
      }
      flights.get(normalized)?.controller.abort();
    }
    return finishLogout(record, requestId);
  }

  async function recover() {
    if (closed) throw authError("game_auth_unavailable", 503);
    const results = [];
    for (let record of store.listGameAuthRecoveries()) {
      if (record.state === "logout_pending") {
        await finishLogout(record);
        record = store.readGameAuthRecovery(record.ownerId);
        results.push({ operationId: record.operationId, status: record.state });
        continue;
      }
      if (record.state === "logged_out") {
        await revokeGameSession({
          ownerId: record.ownerId,
          playerId: record.playerId,
          operationId: record.operationId,
          authGeneration: record.authGeneration,
          consentGeneration: record.consentGeneration,
        });
        const stored = await credentialStore.read(record.ownerId);
        if (!tombstoneMatches(stored, record))
          throw authError("credential_unavailable", 503);
        results.push({ operationId: record.operationId, status: record.state });
        continue;
      }
      if (["failed", "cancelled"].includes(record.state)) continue;
      if (
        record.state === "auth_outcome_unknown" &&
        record.reason === "consent_required"
      ) {
        results.push({ operationId: record.operationId, status: record.state });
        continue;
      }
      let stored;
      try {
        stored = await credentialStore.read(record.ownerId);
      } catch {
        stored = null;
      }
      const matches = Boolean(
        stored &&
        !stored.record.revoked &&
        stored.record.ownerId === record.ownerId &&
        stored.record.playerId === record.playerId &&
        stored.record.authOperationId === record.operationId &&
        stored.record.credentialVersion ===
          record.expectedCredentialVersion + 1 &&
        stored.record.expiresAt > now(),
      );
      if (record.state === "ready" && matches) {
        // The ready transition is written only after the actor credential is saved.
        // Avoid a live Cargo request on every Wiki restart.
        results.push({ operationId: record.operationId, status: "ready" });
        continue;
      }
      if (
        matches &&
        [
          "verification_pending",
          "credential_stored",
          "auth_outcome_unknown",
        ].includes(record.state)
      ) {
        const context = {
          record,
          controller: new AbortController(),
          route: null,
          credentialEtag: stored.etag,
        };
        try {
          context.route = currentRoute(record.ownerId, record).route;
          const profile = await verifyCandidate(
            context,
            stored.record.accessToken,
            { recovery: true },
          );
          if (record.state !== "credential_stored" && record.state !== "ready")
            record = store.updateGameAuthRecovery(
              record.ownerId,
              record.operationId,
              {
                ...record,
                state: "credential_stored",
                credentialVersion: stored.record.credentialVersion,
                updatedAt: Math.max(now(), record.updatedAt),
              },
            );
          context.record = record;
          await adopt(context, stored.record, profile);
          results.push({ operationId: record.operationId, status: "ready" });
          continue;
        } catch (error) {
          const current = store.readGameAuthRecovery(record.ownerId);
          if (
            current?.operationId === record.operationId &&
            (current.state !== "auth_outcome_unknown" ||
              (current.reason !== "consent_required" &&
                ["route_stale", "game_auth_cancelled"].includes(error?.code)))
          )
            store.updateGameAuthRecovery(record.ownerId, record.operationId, {
              ...current,
              state: "auth_outcome_unknown",
              reason: ["route_stale", "game_auth_cancelled"].includes(
                error?.code,
              )
                ? "consent_required"
                : "game_unavailable",
              updatedAt: Math.max(now(), current.updatedAt),
            });
          results.push({
            operationId: record.operationId,
            status: "auth_outcome_unknown",
          });
          continue;
        }
      }
      const current = store.readGameAuthRecovery(record.ownerId);
      if (!current || current.operationId !== record.operationId) continue;
      if (current.state === "ready") {
        record = store.updateGameAuthRecovery(
          record.ownerId,
          record.operationId,
          {
            ...current,
            state: "auth_outcome_unknown",
            reason: "credential_unavailable",
            updatedAt: Math.max(now(), current.updatedAt),
          },
        );
      } else if (["created", "launch_requested"].includes(current.state)) {
        record = store.updateGameAuthRecovery(
          record.ownerId,
          record.operationId,
          {
            ...current,
            state: "failed",
            reason: "device_offline",
            updatedAt: Math.max(now(), current.updatedAt),
          },
        );
      } else if (
        [
          "exchange_pending",
          "verification_pending",
          "credential_stored",
        ].includes(current.state)
      ) {
        record = store.updateGameAuthRecovery(
          record.ownerId,
          record.operationId,
          {
            ...current,
            state: "auth_outcome_unknown",
            reason: matches ? "game_unavailable" : "unknown_outcome",
            updatedAt: Math.max(now(), current.updatedAt),
          },
        );
      }
      results.push({ operationId: record.operationId, status: record.state });
    }
    return results;
  }

  function close() {
    closed = true;
    for (const context of flights.values()) context.controller.abort();
  }

  return Object.freeze({
    start,
    status,
    cancel,
    invalidateDevice,
    invalidateRoute,
    logout,
    recover,
    close,
  });
}
