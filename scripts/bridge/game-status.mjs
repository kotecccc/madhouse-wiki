// ownerId is supplied only by an authenticated device session, never by the
// desktop request. Only finite public status crosses back to the device.
export function createDeviceGameStatusReader({
  store,
  resolveVerifiedOwnerSession,
  snapshots,
} = {}) {
  if (
    typeof store?.isRestoreRequired !== "function" ||
    typeof resolveVerifiedOwnerSession !== "function" ||
    typeof snapshots?.registerVerifiedCredential !== "function" ||
    typeof snapshots?.verifyIdentity !== "function"
  )
    throw new TypeError("device_game_status_dependencies_invalid");
  return async function readStatus({ ownerId, deviceId, routeEpoch, signal }) {
    let before;
    try {
      if (signal?.aborted) return "unknown";
      before = await resolveVerifiedOwnerSession(ownerId, { signal });
    } catch (error) {
      if (signal?.aborted) return "unknown";
      return error?.code === "game_session_required"
        ? "auth_required"
        : "unknown";
    }
    try {
      if (signal?.aborted) return "unknown";
      if (store.isRestoreRequired(before.playerId)) return "paused";
      if (
        before.routePolicy !== "bridge_required" ||
        before.routeEpoch !== routeEpoch
      )
        return "unknown";
      const route = store.readRoutePolicy(before.playerId);
      if (
        route.policy !== "bridge_required" ||
        route.activeDeviceId !== deviceId ||
        route.routeEpoch !== routeEpoch
      )
        return "unknown";
      snapshots.registerVerifiedCredential(
        before.authorization,
        before.playerId,
      );
      const response = await snapshots.verifyIdentity(before.authorization, {
        signal,
      });
      if (signal?.aborted) return "unknown";
      if (response.status === 401) return "auth_required";
      if (!response.ok) return "unknown";
      const profile = await response.json();
      if (
        String(profile?.playerId) !== before.playerId ||
        String(profile?.telegramId) !== ownerId
      )
        return "unknown";
      const after = await resolveVerifiedOwnerSession(ownerId, { signal });
      if (signal?.aborted) return "unknown";
      const currentRoute = store.readRoutePolicy(before.playerId);
      if (
        store.isRestoreRequired(before.playerId) ||
        after.authorization !== before.authorization ||
        after.playerId !== before.playerId ||
        after.credentialVersion !== before.credentialVersion ||
        after.routeEpoch !== routeEpoch ||
        currentRoute.policy !== "bridge_required" ||
        currentRoute.activeDeviceId !== deviceId ||
        currentRoute.routeEpoch !== routeEpoch
      )
        return "unknown";
      return "ready";
    } catch {
      return "unknown";
    }
  };
}
