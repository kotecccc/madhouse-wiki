import {
  readGameOverBridge,
  readProfileOverBridge,
  sendFriendResponseOverBridge,
  sendWorkTaskOverBridge,
} from "./profile-client.mjs";

function failure(code) {
  return Object.assign(new Error(code), { code });
}
const secret =
  /token|jwt|authorization|password|session|credential|initdata|secret/i;
function sanitize(value, depth = 0) {
  if (depth > 32) throw failure("profile_invalid");
  if (Array.isArray(value))
    return value.map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !secret.test(key) &&
            !["__proto__", "constructor", "prototype"].includes(key),
        )
        .map(([key, item]) => [key, sanitize(item, depth + 1)]),
    );
  return value;
}

/** Verified owner only; credentials remain on the server. */
export function createBridgeAccountService({
  accounts,
  devices,
  registry,
  readProfile = readProfileOverBridge,
  readGame = readGameOverBridge,
  sendAction = sendFriendResponseOverBridge,
  queueActionGate = null,
} = {}) {
  if (
    !accounts ||
    !devices ||
    !registry ||
    typeof readProfile !== "function" ||
    typeof readGame !== "function"
  )
    throw new TypeError("account_service_dependencies_required");

  async function fetchProfile(verifiedOwner, authorization, signal) {
    const device = devices.listDevice(verifiedOwner);
    if (!device) throw failure("device_unavailable");
    const identity = {
      owner: registry.ownerKey(verifiedOwner),
      device: device.deviceId,
      generation: device.generation,
    };
    let result;
    try {
      result = await readProfile({
        authorization,
        signal,
        openTunnel: () => devices.open(verifiedOwner, { signal }),
        validateTunnel: () => registry.isActive(identity),
      });
    } catch {
      throw failure("bridge_unavailable");
    }
    if (result.status === 401 || result.status === 403)
      throw failure("invalid_game_token");
    if (result.status !== 200 || !Buffer.isBuffer(result.body))
      throw failure("profile_unavailable");
    let profile;
    try {
      profile = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(result.body),
      );
    } catch {
      throw failure("profile_invalid");
    }
    if (!Number.isSafeInteger(profile?.playerId) || profile.playerId <= 0)
      throw failure("profile_invalid");
    const telegramId =
      typeof profile.telegramId === "number" &&
      Number.isSafeInteger(profile.telegramId) &&
      profile.telegramId > 0
        ? String(profile.telegramId)
        : typeof profile.telegramId === "string" &&
            /^[1-9][0-9]{0,15}$/.test(profile.telegramId) &&
            Number.isSafeInteger(Number(profile.telegramId))
          ? profile.telegramId
          : null;
    if (telegramId !== verifiedOwner) throw failure("account_mismatch");
    if (!registry.isActive(identity)) throw failure("device_changed");
    return { profile, device, identity };
  }

  async function bind(verifiedOwner, authorization) {
    if (
      typeof authorization !== "string" ||
      authorization.length > 8192 ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      throw failure("invalid_game_token");
    const revision = accounts.getRevision(verifiedOwner);
    const { profile, device } = await fetchProfile(
      verifiedOwner,
      authorization,
    );
    accounts.saveVerified({
      owner: verifiedOwner,
      playerId: String(profile.playerId),
      authorization,
      expectedRevision: revision,
      deviceId: device.deviceId,
      generation: device.generation,
    });
    return { status: "connected" };
  }

  async function profile(verifiedOwner, { signal } = {}) {
    const account = accounts.read(verifiedOwner);
    if (!account) throw failure("account_not_configured");
    const result = await fetchProfile(
      verifiedOwner,
      account.authorization,
      signal,
    );
    if (accounts.getRevision(verifiedOwner) !== account.revision)
      throw failure("binding_changed");
    if (String(result.profile.playerId) !== account.playerId)
      throw failure("account_mismatch");
    return { profile: sanitize(result.profile) };
  }

  async function read(verifiedOwner, path, { signal, method, body } = {}) {
    const account = accounts.read(verifiedOwner);
    if (!account) throw failure("account_not_configured");
    const device = devices.listDevice(verifiedOwner);
    if (!device) throw failure("device_unavailable");
    const identity = {
      owner: registry.ownerKey(verifiedOwner),
      device: device.deviceId,
      generation: device.generation,
    };
    let result;
    try {
      result = await readGame({
        authorization: account.authorization,
        path,
        method,
        body,
        signal,
        openTunnel: () => devices.open(verifiedOwner, { signal }),
        validateTunnel: () => registry.isActive(identity),
      });
    } catch {
      throw failure("bridge_unavailable");
    }
    if (!registry.isActive(identity)) throw failure("device_changed");
    if (accounts.getRevision(verifiedOwner) !== account.revision)
      throw failure("binding_changed");
    if (
      !Number.isInteger(result?.status) ||
      result.status < 200 ||
      result.status > 599 ||
      !Buffer.isBuffer(result.body)
    )
      throw failure("bridge_unavailable");
    return result;
  }

  async function send(verifiedOwner, method, path, { signal, body } = {}) {
    const account = accounts.read(verifiedOwner);
    if (!account || !queueActionGate) throw failure("bridge_unavailable");
    const device = devices.listDevice(verifiedOwner);
    if (!device) throw failure("device_unavailable");
    const identity = {
      owner: registry.ownerKey(verifiedOwner),
      device: device.deviceId,
      generation: device.generation,
    };
    let result;
    try {
      const sender =
        path === "/api/works/tasks/perform"
          ? sendWorkTaskOverBridge
          : sendAction;
      result = await sender({
        authorization: account.authorization,
        method,
        path,
        body,
        signal,
        openTunnel: () => devices.open(verifiedOwner, { signal }),
        validateTunnel: () =>
          registry.isActive(identity) &&
          accounts.getRevision(verifiedOwner) === account.revision &&
          queueActionGate.claim({
            authorization: account.authorization,
            method,
            path,
            body,
          }),
      });
    } catch {
      throw failure("bridge_unavailable");
    }
    if (
      !registry.isActive(identity) ||
      accounts.getRevision(verifiedOwner) !== account.revision ||
      !Number.isInteger(result?.status) ||
      result.status < 200 ||
      result.status > 599 ||
      !Buffer.isBuffer(result.body)
    )
      throw failure("bridge_unavailable");
    return result;
  }

  function status(verifiedOwner) {
    return accounts.getRevision(verifiedOwner) > 0 ? "saved" : "not_configured";
  }
  return Object.freeze({ bind, profile, read, send, status });
}
