const DEVICE_STATES = new Set(["online", "offline"]);
const ACCOUNT_STATES = new Set(["saved", "not_configured"]);
const ERROR_CODES = new Set([
  "invalid_game_token",
  "device_unavailable",
  "device_changed",
  "account_mismatch",
  "account_already_bound",
  "direct_requests_in_flight",
  "binding_changed",
  "profile_invalid",
  "profile_unavailable",
  "account_not_configured",
  "invalid_invitation",
  "device_already_active",
  "invalid_device",
  "bridge_unavailable",
  "not_authorized",
  "rate_limited",
]);
const failure = (code) => Object.assign(new Error(code), { code });
const isRecord = (value) =>
  value && typeof value === "object" && !Array.isArray(value);

/** Ephemeral command sender: never stores tokens, invitations or user data. */
export function createBridgeDeviceClient({
  fetcher = fetch,
  getInitData,
} = {}) {
  if (typeof fetcher !== "function" || typeof getInitData !== "function")
    throw new TypeError("bridge_client_dependencies_required");
  async function command(operation, fields = {}, signal) {
    const initData = getInitData();
    if (typeof initData !== "string" || !initData)
      throw failure("not_authorized");
    let response;
    try {
      response = await fetcher("/api/bridge/device", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ operation, initData, ...fields }),
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        signal,
      });
    } catch {
      throw failure("bridge_unavailable");
    }
    let value;
    try {
      value = await response.json();
    } catch {
      throw failure("bridge_unavailable");
    }
    if (!response.ok)
      throw failure(
        ERROR_CODES.has(value?.error) ? value.error : "bridge_unavailable",
      );
    if (!isRecord(value)) throw failure("bridge_unavailable");
    return value;
  }
  return Object.freeze({
    async renew(authorization, signal) {
      if (
        typeof authorization !== "string" ||
        !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          authorization,
        )
      )
        throw failure("not_authorized");
      let response;
      try {
        response = await fetcher("/api/bridge/device", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: authorization,
          },
          body: JSON.stringify({ operation: "renew" }),
          cache: "no-store",
          credentials: "same-origin",
          redirect: "error",
          signal,
        });
      } catch {
        throw failure("bridge_unavailable");
      }
      const value = await response.json().catch(() => null);
      if (
        !response.ok ||
        typeof value?.session !== "string" ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          value.session,
        ) ||
        value.session.length > 2048
      )
        throw failure("bridge_unavailable");
      return value.session;
    },
    async session(signal) {
      const value = await command("session", {}, signal);
      if (
        typeof value.session !== "string" ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(
          value.session,
        ) ||
        value.session.length > 2048
      )
        throw failure("bridge_unavailable");
      return value.session;
    },
    async status(signal) {
      const value = await command("status", {}, signal);
      if (
        !DEVICE_STATES.has(value.device) ||
        !ACCOUNT_STATES.has(value.account)
      )
        throw failure("bridge_unavailable");
      return { device: value.device, account: value.account };
    },
    async invite(signal) {
      const value = await command("invite", {}, signal);
      if (
        !/^[A-Za-z0-9_-]{43}$/.test(value.invitation || "") ||
        !Number.isSafeInteger(value.expiresAt)
      )
        throw failure("bridge_unavailable");
      return { invitation: value.invitation, expiresAt: value.expiresAt };
    },
    async list(signal) {
      const value = await command("list", {}, signal);
      if (value.device === null) return null;
      if (
        !isRecord(value.device) ||
        !/^[0-9a-f-]{36}$/.test(value.device.deviceId || "") ||
        !Number.isSafeInteger(value.device.generation)
      )
        throw failure("bridge_unavailable");
      return {
        deviceId: value.device.deviceId,
        generation: value.device.generation,
      };
    },
    async bind(accessToken, signal) {
      if (
        typeof accessToken !== "string" ||
        !/^[A-Za-z0-9._~-]+$/.test(accessToken) ||
        accessToken.length > 8000
      )
        throw failure("invalid_game_token");
      const value = await command("bind", { accessToken }, signal);
      if (value.status !== "connected") throw failure("bridge_unavailable");
      return { status: "connected" };
    },
    async profile(signal) {
      const value = await command("profile", {}, signal);
      if (
        !isRecord(value.profile) ||
        !Number.isSafeInteger(value.profile.playerId) ||
        value.profile.playerId <= 0
      )
        throw failure("profile_invalid");
      return value.profile;
    },
    async revoke(deviceId, signal) {
      if (typeof deviceId !== "string" || !/^[0-9a-f-]{36}$/.test(deviceId))
        throw failure("invalid_device");
      const value = await command("revoke", { deviceId }, signal);
      if (typeof value.revoked !== "boolean")
        throw failure("bridge_unavailable");
      return value.revoked;
    },
  });
}
