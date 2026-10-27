import { createBossCardsHttp } from "../account/boss-cards.mjs";
import { createPlayerProgressReader } from "../account/player-progress.mjs";
import { createAccountSnapshots } from "../account/snapshots.mjs";
import {
  createGameCredentialStore,
  gameCredentialKeyFromEnvironment,
} from "../account/game-credential-store.mjs";
import { createAuthCoordinator } from "../account/auth-coordinator.mjs";
import { createBootstrapAuthCoordinator } from "../account/bootstrap-auth-coordinator.mjs";
import { createOwnerGameSessionResolver } from "../account/owner-session.mjs";
import { createProxy, isGameApiPath } from "../../api/[...path].js";
import { createAutomationStateStore } from "./state-store.mjs";
import { createAutomationService } from "./service.mjs";
import { createAutomationHttp, nodeAutomationHandler } from "./http.mjs";
import {
  createBridgeHttp,
  createRestoredDirectSelectionGuard,
  nodeBridgeHandler,
  ownerProofKeyFromEnvironment,
  sessionCredentialKeyFromEnvironment,
} from "../bridge/bridge-http.mjs";
import { createDeviceRegistry } from "../bridge/device-registry.mjs";
import { createBridgeControlGateway } from "../bridge/control-gateway.mjs";
import { createGameApiTunnelTransport } from "../bridge/game-api-transport.mjs";
import { readKnowledgeBase } from "../catalogue/query.mjs";
import { createBlobSessionStore } from "../../connector/blob-session-store.js";
import { createBridgeCompatibility } from "../deploy/release-compatibility.mjs";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function createRestoreOperationGuard(store) {
  return ({ accountId, operation, route }) => {
    if (!accountId)
      return (
        !(route?.authBootstrap === true && store.isRestoreGuardActive()) ||
        (route?.restoreBootstrap === true &&
          ["auth_issuance", "identity_verification"].includes(
            operation.operationClass,
          ))
      );
    return store.isGameHelperPaused(accountId)
      ? "helper_paused"
      : !store.isRestoreRequired(accountId) ||
          (["read", "identity_verification"].includes(
            operation.operationClass,
          ) &&
            store.isRestoreAccountReauthorized(accountId) &&
            store.hasExplicitRoutePolicy(accountId));
  };
}

export async function createAutomationRuntime({
  root = process.cwd(),
  env = process.env,
  fetcher = fetch,
} = {}) {
  const enabled = env.MADHOUSE_AUTOMATION_GAME_ENABLED !== "0";
  const bridgeCompatibility = createBridgeCompatibility({
    sourceCommit: env.MADHOUSE_RELEASE_SHA,
    env,
  });
  const stateDirectory =
    env.MADHOUSE_AUTOMATION_STATE_DIR || resolve(root, "local-data/automation");
  const restoreMarkerPath = join(stateDirectory, "restore-required");
  const restoreMarkerPresent = (() => {
    try {
      lstatSync(restoreMarkerPath);
      return true;
    } catch (error) {
      return error?.code === "ENOENT" ? false : null;
    }
  })();
  if (restoreMarkerPresent === null)
    throw new Error("automation_restore_package_incomplete");
  let restoreMarker;
  if (restoreMarkerPresent) {
    try {
      const markerStat = lstatSync(restoreMarkerPath);
      const keyStat = lstatSync(join(stateDirectory, "encryption.key"));
      const databaseStat = lstatSync(join(stateDirectory, "automation.sqlite"));
      restoreMarker = JSON.parse(readFileSync(restoreMarkerPath, "utf8"));
      const key = readFileSync(join(stateDirectory, "encryption.key"));
      if (
        !markerStat.isFile() ||
        markerStat.isSymbolicLink() ||
        (markerStat.mode & 0o077) !== 0 ||
        restoreMarker?.schemaVersion !== 1 ||
        !Number.isSafeInteger(restoreMarker.createdAt) ||
        restoreMarker.createdAt < 1 ||
        !keyStat.isFile() ||
        keyStat.isSymbolicLink() ||
        (keyStat.mode & 0o077) !== 0 ||
        !databaseStat.isFile() ||
        databaseStat.isSymbolicLink() ||
        databaseStat.size < 1 ||
        key.byteLength !== 32
      )
        throw new Error("automation_restore_package_incomplete");
    } catch {
      throw new Error("automation_restore_package_incomplete");
    }
  }
  const store = createAutomationStateStore({
    directory: stateDirectory,
  });
  if (restoreMarkerPresent)
    store.armRestoreGuardForMarker({ createdAt: restoreMarker.createdAt });
  const ownerProofKey = ownerProofKeyFromEnvironment(
    env.MADHOUSE_BRIDGE_OWNER_PROOF_KEY,
  );
  const sessionSigningKey = sessionCredentialKeyFromEnvironment(
    env.MADHOUSE_BRIDGE_SESSION_SIGNING_KEY,
  );
  const gameCredentialKey = gameCredentialKeyFromEnvironment(
    env.MADHOUSE_GAME_CREDENTIAL_KEY,
  );
  const credentialStore = gameCredentialKey
    ? createGameCredentialStore({
        store: createBlobSessionStore(),
        encryptionKey: gameCredentialKey,
      })
    : null;
  const resolveOwnerSession = credentialStore
    ? createOwnerGameSessionResolver({
        store,
        credentialStore,
        botToken: env.TELEGRAM_BOT_TOKEN,
      })
    : null;
  let bridgeControlGateway;
  let authCoordinator;
  let bootstrapCoordinator;
  let service;
  let runtimeDrainFlight = null;
  let runtimeClosed = false;
  const bridgeTransport = createGameApiTunnelTransport({
    openStream: ({ route, signal }) => {
      if (!bridgeControlGateway)
        throw Object.assign(new Error("bridge_offline"), {
          code: "bridge_offline",
        });
      const binding = store.readGameAccountOwner(route.playerId);
      if (!binding?.ownerId)
        throw Object.assign(new Error("game_account_binding_required"), {
          code: "game_account_binding_required",
        });
      return bridgeControlGateway.openStream({
        ownerId: binding.ownerId,
        deviceId: route.activeDeviceId,
        routeEpoch: route.routeEpoch,
        signal,
      });
    },
    bindMutationConnection: ({ admission, connectionId, route }) =>
      service?.bindGameMutationConnection({
        admission,
        connectionId,
        route,
      }) ?? false,
  });
  const snapshots = createAccountSnapshots({
    store,
    fetcher,
    refreshProfileProgress: createPlayerProgressReader({
      fetcher: (url, init) => snapshots.liveFetch(url, init),
    }),
    bridgeTransport,
    admitMutation: (admission) => service?.admitGameMutation(admission) ?? null,
    allowOperation: createRestoreOperationGuard(store),
    resolveOwnerSession,
  });
  // The proxy validates the public OpenAPI surface, then delegates to the
  // snapshot client, which owns identity resolution, route policy and Cargo
  // dispatch. A second route decision here would stop bridge reads before
  // they reach the configured tunnel.
  const proxy = createProxy(snapshots.fetch, {
    routePolicyDelegatedToFetcher: true,
  });
  let catalogue;
  const getCatalogue = () => (catalogue ??= readKnowledgeBase(root));
  service = createAutomationService({
    store,
    fetcher: snapshots.liveFetch,
    snapshotFetch: snapshots.fetch,
    accountHealth: snapshots.health,
    identifyPlayer: async (authorization) => {
      const response = await snapshots.verifyIdentity(authorization);
      if (!response.ok) {
        const error = new Error("game_identity_unavailable");
        error.status = response.status;
        throw error;
      }
      return response.json();
    },
    getBoss: (id) => {
      return (
        getCatalogue().bosses.find(
          (boss) => Number(boss.numericId ?? boss.apiId) === id,
        ) || {
          numericId: id,
          name: `Босс №${id}`,
        }
      );
    },
    getBusinessCatalogue: getCatalogue,
  });
  const automationHandle = createAutomationHttp({
    service,
    enabled,
    origin: env.WIKI_PUBLIC_ORIGIN || null,
    resolveOwnerSession,
  });
  const bridgeRegistry = createDeviceRegistry({
    store,
    ownerProofKey,
    verifyGameAccount: async (authorization) => {
      const response = await snapshots.verifyIdentity(authorization);
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500)
          throw Object.assign(new Error("game_account_binding_unavailable"), {
            code: "game_account_binding_unavailable",
          });
        throw new Error("invalid_game_session");
      }
      const profile = await response.json().catch(() => null);
      if (!profile || typeof profile !== "object")
        throw new Error("invalid_game_session");
      return {
        telegramId: profile.telegramId,
        playerId: profile.playerId,
      };
    },
    sessionSigningKey,
    resolveDeviceRoute: (verifiedOwnerId) => {
      const binding = store.readGameAccountBinding(verifiedOwnerId);
      return binding ? store.readRoutePolicy(binding.playerId) : null;
    },
    onDeviceRevoked: (deviceId, generation) => {
      bridgeControlGateway?.closeDevice(deviceId, generation);
      authCoordinator?.invalidateDevice(deviceId);
    },
    onRouteChanging: (change) => service.pauseForRouteChange(change),
    onRouteChanged: ({ ownerId, previous, current }) => {
      authCoordinator?.invalidateRoute({ ownerId, previous, current });
      for (const deviceId of new Set([
        previous.activeDeviceId,
        current.activeDeviceId,
      ]))
        if (deviceId)
          bridgeControlGateway?.closeDevice(
            deviceId,
            undefined,
            "route_changed",
          );
    },
    onGameAccountBound: (binding) => service.confirmRestoredAccount(binding),
  });
  bridgeControlGateway = createBridgeControlGateway({
    registry: bridgeRegistry,
    sessionSigningKey,
    origin: env.WIKI_PUBLIC_ORIGIN || "https://madhouse-wiki.ru",
    // Use the same protected release, rollback and host gate as route selection.
    enabled: bridgeCompatibility.routeSelection.enabled,
  });
  authCoordinator = credentialStore
    ? createAuthCoordinator({
        store,
        credentialStore,
        controlGateway: bridgeControlGateway,
        issueGameCredential: snapshots.issueGameCredential,
        verifyGameCredential: snapshots.verifyGameCredential,
        adoptGameCredential: async (candidate) => {
          snapshots.registerVerifiedCredential(
            `Bearer ${candidate.accessToken}`,
            candidate.playerId,
          );
          return service.adoptGameCredential(candidate);
        },
        revokeGameSession: (request) => service.logoutGameSession(request),
        isDeviceActive: ({ ownerId, deviceId }) =>
          bridgeRegistry.isDeviceActive({ ownerId, deviceId }),
      })
    : null;
  bootstrapCoordinator = credentialStore
    ? createBootstrapAuthCoordinator({
        store,
        credentialStore,
        issueGameCredential: snapshots.issueBootstrapGameCredential,
        verifyGameCredential: snapshots.verifyBootstrapGameCredential,
        adoptGameCredential: async (candidate) => {
          snapshots.registerVerifiedCredential(
            `Bearer ${candidate.accessToken}`,
            candidate.playerId,
          );
          return service.adoptGameCredential({
            ...candidate,
            authOperationId: candidate.bootstrapOperationId,
          });
        },
      })
    : null;
  if (bootstrapCoordinator && !store.isRestoreGuardActive())
    await bootstrapCoordinator.recover();
  if (authCoordinator && !store.isRestoreGuardActive())
    await authCoordinator.recover();
  // Normal runtime serves authenticated commands. Explicit 0 is an operator kill switch.
  if (enabled) await service.boot();
  const bridgeHandle = createBridgeHttp({
    registry: bridgeRegistry,
    botToken: env.TELEGRAM_BOT_TOKEN,
    ownerProofKey,
    origin: env.WIKI_PUBLIC_ORIGIN || "https://madhouse-wiki.ru",
    devOrigin: env.MADHOUSE_DOCKER_DEV === "1" ? "http://127.0.0.1:4174" : null,
    routeSelectionEnabled: bridgeCompatibility.routeSelection.enabled,
    allowRestoredDirectSelection: createRestoredDirectSelectionGuard(store),
    confirmRestoreOwner: (confirmation) =>
      store.recordRestoreOwnerConsent(confirmation),
    issueRestoreOwnerChallenge: (request) =>
      store.issueRestoreOwnerChallenge(request),
    readRestoreOwnerStatus: (ownerId) => store.readRestoreOwnerStatus(ownerId),
    confirmRestoreReview: async ({ ownerId, initData, ...review }) => {
      if (!resolveOwnerSession) throw new Error("game_session_required");
      const session = await resolveOwnerSession(initData);
      if (session.ownerId !== ownerId) throw new Error("game_session_required");
      const journal = store.readGameAuthBootstrap(ownerId);
      return store.confirmRestoredReview({
        ownerId,
        playerId: session.playerId,
        operationId: journal?.operationId,
        authorization: session.authorization,
        ...review,
      });
    },
    authCoordinator,
    bootstrapCoordinator,
  });
  const bossCardsHandle = createBossCardsHttp({
    identify: service.identify,
    identifyOwner: service.identifyOwner,
    resolveOwnerSession,
    snapshots,
    getCatalogue,
    origin: env.WIKI_PUBLIC_ORIGIN || null,
  });
  const handle = async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/api/automation/inventory-snapshots") {
      const headers = {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      };
      if (request.method !== "GET")
        return new Response(null, { status: 405, headers });
      if (
        url.search ||
        (request.headers.get("origin") &&
          request.headers.get("origin") !==
            (env.WIKI_PUBLIC_ORIGIN || url.origin))
      )
        return new Response(null, { status: 403, headers });
      const authorization = request.headers.get("authorization");
      try {
        await service.identify(authorization);
        return new Response(
          JSON.stringify(snapshots.inventory(authorization)),
          { headers },
        );
      } catch (error) {
        return new Response(null, {
          status: Number.isInteger(error.status) ? error.status : 401,
          headers,
        });
      }
    }
    return url.pathname === "/api/automation/bosses"
      ? bossCardsHandle(request)
      : automationHandle(request);
  };
  return {
    handle,
    proxy,
    routeForAuthorization: snapshots.routeForAuthorization,
    nodeHandler: nodeAutomationHandler(handle, {
      origin: env.WIKI_PUBLIC_ORIGIN,
    }),
    bridgeNodeHandler: nodeBridgeHandler(bridgeHandle, {
      origin: env.WIKI_PUBLIC_ORIGIN,
    }),
    bridgeUpgradeHandler: bridgeControlGateway.handleUpgrade,
    drain({ deadlineInMs = 35_000 } = {}) {
      if (runtimeDrainFlight) return runtimeDrainFlight;
      service.beginDrain();
      runtimeDrainFlight = Promise.all([
        snapshots.drain({ deadlineInMs }),
        bridgeControlGateway.drain({ deadlineInMs }),
      ]).then((results) => {
        authCoordinator?.close();
        return results.every(Boolean);
      });
      return runtimeDrainFlight;
    },
    close() {
      if (runtimeClosed) return;
      runtimeClosed = true;
      authCoordinator?.close();
      bridgeControlGateway.close();
      service.close();
      store.close();
    },
  };
}

export function automationPlugin(root) {
  return {
    name: "server-owned-automations",
    async configureServer(server) {
      const runtime = await createAutomationRuntime({ root });
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] === "/api/bridge")
          return runtime.bridgeNodeHandler(request, response);
        if (
          !/^\/api\/automation(?:\/|$)/.test(request.url?.split("?")[0] || "")
        )
          return isGameApiPath(request.url?.split("?")[0] || "")
            ? runtime.proxy(request, response)
            : next();
        return runtime.nodeHandler(request, response);
      });
      server.httpServer?.once("close", () => runtime.close());
    },
  };
}
