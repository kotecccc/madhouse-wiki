import { createDeviceTunnelPool } from "./device-tunnel-pool.mjs";

/**
 * Local bridge service boundary. `verifiedOwner` must originate from the
 * authenticated server session. HTTP admission, storage and rate limits live
 * outside this object and are required before any public exposure.
 */
export function createBridgeDeviceService({ registry } = {}) {
  if (
    !registry ||
    typeof registry.authenticateDevice !== "function" ||
    typeof registry.isActive !== "function" ||
    typeof registry.ownerKey !== "function"
  )
    throw new TypeError("device_registry_required");
  let onAuthenticatedReconnect = () => {};
  const pool = createDeviceTunnelPool({
    authorize: (identity) => registry.isActive(identity),
    onAuthenticatedReconnect: (identity) =>
      onAuthenticatedReconnect(identity.owner),
  });
  return Object.freeze({
    setAuthenticatedReconnectHandler(handler) {
      if (typeof handler !== "function")
        throw new TypeError("reconnect_handler_required");
      onAuthenticatedReconnect = handler;
      return () => {
        if (onAuthenticatedReconnect === handler)
          onAuthenticatedReconnect = () => {};
      };
    },
    issueInvitation: (verifiedOwner) => registry.issueInvitation(verifiedOwner),
    listDevice: (verifiedOwner) => registry.listDevice(verifiedOwner),
    redeemInvitation: (invitation) => registry.redeemInvitation(invitation),
    async admit({ deviceId, deviceKey }, socket) {
      let identity;
      try {
        identity = registry.authenticateDevice(deviceId, deviceKey);
      } catch {
        socket.terminate();
        throw new Error("bridge_unavailable");
      }
      if (!identity) {
        socket.terminate();
        throw new Error("bridge_unavailable");
      }
      await pool.admit(identity, socket);
    },
    async status(verifiedOwner) {
      return (await pool.online(registry.ownerKey(verifiedOwner)))
        ? "online"
        : "offline";
    },
    open(verifiedOwner, options) {
      return pool.open(registry.ownerKey(verifiedOwner), options);
    },
    revoke(verifiedOwner, deviceId) {
      const owner = registry.ownerKey(verifiedOwner);
      try {
        return registry.revoke(verifiedOwner, deviceId);
      } finally {
        pool.revoke(owner, deviceId);
      }
    },
    close: pool.close,
  });
}
