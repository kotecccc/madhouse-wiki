import { createBridgeAccountService } from "./account-service.mjs";
import { createBridgeDeviceHttp } from "./device-http.mjs";
import { createDeviceGateway } from "./device-gateway.mjs";
import { createBridgeDeviceService } from "./device-service.mjs";
import { createBridgeStorage } from "./device-storage.mjs";
import { createBridgeAwareAccountFetch } from "./bridge-aware-fetch.mjs";
import { createConnectorLeaseIpcHandler } from "./connector-lease-ipc.mjs";

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
  try {
    service = createBridgeDeviceService({ registry: storage.registry });
    const accountService = createBridgeAccountService({
      accounts: storage.accounts,
      devices: service,
      registry: storage.registry,
      ...(readProfile ? { readProfile } : {}),
      ...(readGame ? { readGame } : {}),
    });
    const handle = createBridgeDeviceHttp({
      service,
      accountService,
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
          accounts: storage.accounts,
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
