import { createBridgeAccountService } from "./account-service.mjs";
import { createBridgeDeviceHttp } from "./device-http.mjs";
import { createDeviceGateway } from "./device-gateway.mjs";
import { createBridgeDeviceService } from "./device-service.mjs";
import { createBridgeStorage } from "./device-storage.mjs";
import { createBridgeAwareAccountFetch } from "./bridge-aware-fetch.mjs";
import { createConnectorLeaseIpcHandler } from "./connector-lease-ipc.mjs";
import { createQueueActionGate } from "./queue-action-gate.mjs";
import { createHmac } from "node:crypto";
import {
  createBridgeBrowserSessions,
  resolveBridgeBrowserSession,
} from "./browser-session.mjs";

/**
 * Isolated composition boundary. The hosting server must gate activation,
 * supply trusted peer addresses and a real rate limiter. No route selection or
 * direct-game fallback is installed by constructing this object.
 */
export function createBridgeRuntime({
  directory,
  botToken,
  origin,
  consume,
  now,
  heartbeatMs,
  readProfile,
  readGame,
  sendAction,
  sendWork,
  connectorIpcKey,
  witnessPath,
  provisionWitness = false,
  requireGameCoordinator = false,
} = {}) {
  if (typeof consume !== "function")
    throw new TypeError("bridge_rate_limiter_required");
  const storage = createBridgeStorage({
    directory,
    now,
    witnessPath,
    provisionWitness,
  });
  let service;
  let gateway;
  const queueActionGate = createQueueActionGate();
  let gameCoordinator = requireGameCoordinator
    ? null
    : ({ execute }) => execute();
  let bindGameAccount = () => {};
  let installRecoveryStore = () => {};
  const browserSessions = createBridgeBrowserSessions({
    key: createHmac("sha256", botToken)
      .update("madhouse-bridge-browser-session-v1")
      .digest(),
    ...(now ? { now } : {}),
  });
  try {
    service = createBridgeDeviceService({ registry: storage.registry });
    const accountService = createBridgeAccountService({
      accounts: storage.accounts,
      devices: service,
      registry: storage.registry,
      queueActionGate,
      coordinate: (attempt) => {
        if (!gameCoordinator) throw new Error("game_coordinator_unavailable");
        return gameCoordinator(attempt);
      },
      coordinateVerified: (authorization, playerId) =>
        bindGameAccount(authorization, playerId),
      ...(readProfile ? { readProfile } : {}),
      ...(readGame ? { readGame } : {}),
      ...(sendAction ? { sendAction } : {}),
      ...(sendWork ? { sendWork } : {}),
    });
    const handle = createBridgeDeviceHttp({
      service,
      accountService,
      accounts: storage.accounts,
      browserSessions,
      botToken,
      origin,
      consume,
      ...(now ? { now } : {}),
    });
    gateway = createDeviceGateway({
      service,
      registry: storage.registry,
      consume: (ip, device) => consume(ip, "/bridge/data", device),
      ...(heartbeatMs ? { heartbeatMs } : {}),
    });
    const connectorLease = connectorIpcKey
      ? createConnectorLeaseIpcHandler({
          leases: storage.connectorLeases,
          directCredentials: storage.directCredentials,
          consumeNonce: storage.consumeConnectorNonce,
          key: connectorIpcKey,
          ...(now ? { now } : {}),
        })
      : null;
    let closed = false;
    return Object.freeze({
      queueActionGate,
      bootstrapPolicy: Object.freeze({
        canClaim: (...args) =>
          !closed && storage.connectorLeases.canClaimStep(...args),
        claim: (...args) => {
          if (closed) throw new Error("bridge_unavailable");
          return storage.connectorLeases.claimStep(...args);
        },
        complete: (...args) => {
          if (closed) throw new Error("bridge_unavailable");
          return storage.connectorLeases.completeStep(...args);
        },
      }),
      setGameCoordinator(coordinator, bindAccount, installStore) {
        if (
          typeof coordinator !== "function" ||
          typeof bindAccount !== "function" ||
          typeof installStore !== "function" ||
          gameCoordinator
        )
          throw new TypeError("game_coordinator_invalid");
        gameCoordinator = coordinator;
        bindGameAccount = bindAccount;
        installRecoveryStore = installStore;
      },
      setAuthenticatedReconnectHandler(handler) {
        if (closed) throw new Error("bridge_unavailable");
        return service.setAuthenticatedReconnectHandler(handler);
      },
      installRecoveryStore(store) {
        installRecoveryStore(store);
      },
      // Called only by the verified private Telegram webhook, never from a
      // client-supplied owner ID.
      botDevices: Object.freeze({
        list: (owner) => service.listDevice(owner),
        status: (owner) => service.status(owner),
        invite: (owner) => service.issueInvitation(owner),
        revoke: (owner, deviceId) => service.revoke(owner, deviceId),
        player: (owner) => storage.accounts.read(owner)?.playerId ?? null,
      }),
      ownerForPlayer: (playerId) =>
        storage.accounts.resolveVerifiedPlayer(String(playerId))?.owner ?? null,
      ownerKey: (verifiedOwner) => storage.registry.ownerKey(verifiedOwner),
      canonicalCredential(authorization) {
        const token =
          typeof authorization === "string" &&
          authorization.startsWith("Bearer ")
            ? authorization.slice(7)
            : "";
        if (!browserSessions.isBridgeToken(token)) return authorization;
        const session = resolveBridgeBrowserSession(token, {
          sessions: browserSessions,
          accounts: storage.accounts,
          devices: service,
        });
        if (!session) throw new Error("bridge_session_invalid");
        return session.authorization;
      },
      handle,
      upgrade: gateway.upgrade,
      connectorLease(request, trustedPeer) {
        if (closed || !connectorLease)
          return new Response(null, { status: 404 });
        return connectorLease(request, trustedPeer);
      },
      wrapSnapshots(snapshots) {
        if (closed) throw new Error("bridge_unavailable");
        accountService.setProfileObserver((authorization, profile) =>
          snapshots.saveBridgeProfile(authorization, profile),
        );
        return createBridgeAwareAccountFetch({
          snapshots,
          accounts: {
            ...storage.accounts,
            resolveCredential(authorization) {
              const session =
                typeof authorization === "string" &&
                authorization.startsWith("Bearer ")
                  ? resolveBridgeBrowserSession(authorization.slice(7), {
                      sessions: browserSessions,
                      accounts: storage.accounts,
                      devices: service,
                    })
                  : null;
              if (session)
                return {
                  policy: "bridge_required",
                  owner: session.owner,
                  epoch: session.revision,
                  credentialCurrent: true,
                };
              if (
                typeof authorization === "string" &&
                authorization.startsWith("Bearer ") &&
                browserSessions.isBridgeToken(authorization.slice(7))
              )
                throw new Error("bridge_session_invalid");
              return storage.accounts.resolveCredential(authorization);
            },
          },
          directCredentials: storage.directCredentials,
          directRoutes: storage.directRoutes,
          accountService,
          canonicalCredential: (authorization) =>
            this.canonicalCredential(authorization),
        });
      },
      close() {
        if (closed) return;
        closed = true;
        gateway.close();
        service.close();
        storage.close();
      },
    });
  } catch (error) {
    gateway?.close();
    service?.close();
    storage.close();
    throw error;
  }
}
