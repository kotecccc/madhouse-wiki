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
      consume: (ip) => consume(ip, "/bridge/data"),
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
