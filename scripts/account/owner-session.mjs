import { validateTelegramInitData } from "../telegram/telegram-init-data.mjs";

function ownerSessionError(code, status = 401) {
  return Object.assign(new Error(code), { code, status });
}

export function createVerifiedOwnerGameSessionResolver({
  store,
  credentialStore,
  now = Date.now,
} = {}) {
  if (
    typeof store?.readGameAccountBinding !== "function" ||
    typeof store?.readGameAuthRecovery !== "function" ||
    typeof store?.readRoutePolicy !== "function" ||
    typeof credentialStore?.read !== "function" ||
    typeof now !== "function"
  )
    throw new TypeError("owner_game_session_dependencies_required");

  return async function resolveVerifiedOwnerGameSession(ownerId) {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 1)
      throw ownerSessionError("owner_session_unavailable", 503);
    if (
      typeof ownerId !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(ownerId) ||
      !Number.isSafeInteger(Number(ownerId))
    )
      throw ownerSessionError("owner_session_required", 401);

    let binding;
    let recovery;
    let bootstrap;
    try {
      binding = store.readGameAccountBinding(ownerId);
      recovery = store.readGameAuthRecovery(ownerId);
      bootstrap = store.readGameAuthBootstrap?.(ownerId) || null;
    } catch {
      throw ownerSessionError("owner_session_unavailable", 503);
    }
    if (!binding) throw ownerSessionError("game_session_required", 401);
    const bootstrapAfterLogout = Boolean(
      recovery?.state === "logged_out" &&
      bootstrap?.state === "ready" &&
      bootstrap.authGeneration > recovery.authGeneration &&
      bootstrap.consentGeneration > recovery.consentGeneration,
    );
    if (
      (bootstrap && bootstrap.state !== "ready") ||
      (recovery && recovery.state !== "ready" && !bootstrapAfterLogout)
    )
      throw ownerSessionError("game_session_required", 401);

    let saved;
    let route;
    try {
      saved = await credentialStore.read(ownerId);
      route = store.readRoutePolicy(binding.playerId);
    } catch {
      throw ownerSessionError("owner_session_unavailable", 503);
    }
    const credential = saved?.record;
    if (
      !credential ||
      credential.revoked ||
      credential.ownerId !== ownerId ||
      credential.playerId !== binding.playerId ||
      credential.expiresAt <= timestamp ||
      !route ||
      credential.routeEpoch !== route.routeEpoch ||
      (bootstrap && bootstrap.playerId !== binding.playerId) ||
      (bootstrap &&
        (credential.authOperationId !== bootstrap.operationId ||
          credential.authGeneration !== bootstrap.authGeneration ||
          credential.consentGeneration !== bootstrap.consentGeneration ||
          credential.credentialVersion !== bootstrap.credentialVersion)) ||
      (recovery?.state === "ready" &&
        (credential.authOperationId !== recovery.operationId ||
          credential.authGeneration !== recovery.authGeneration ||
          credential.consentGeneration !== recovery.consentGeneration ||
          credential.credentialVersion !== recovery.credentialVersion ||
          credential.routeEpoch !== recovery.routeEpoch)) ||
      (route.policy === "bridge_required" &&
        (!recovery || recovery.state !== "ready"))
    )
      throw ownerSessionError("game_session_required", 401);

    return Object.freeze({
      ownerId,
      playerId: binding.playerId,
      authorization: `Bearer ${credential.accessToken}`,
      credentialVersion: credential.credentialVersion,
      routeEpoch: route.routeEpoch,
      routePolicy: route.policy,
    });
  };
}

export function createOwnerGameSessionResolver({
  store,
  credentialStore,
  botToken,
  now = Date.now,
  maxAgeSeconds = 24 * 60 * 60,
} = {}) {
  if (
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > 24 * 60 * 60
  )
    throw new TypeError("owner_game_session_dependencies_required");
  const resolveVerified = createVerifiedOwnerGameSessionResolver({
    store,
    credentialStore,
    now,
  });
  return async function resolveOwnerGameSession(initData) {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 1)
      throw ownerSessionError("owner_session_unavailable", 503);
    const owner = validateTelegramInitData(initData, botToken, {
      now: timestamp,
      maxAgeSeconds,
    });
    if (!owner) throw ownerSessionError("owner_session_required", 401);
    return resolveVerified(owner.id);
  };
}
