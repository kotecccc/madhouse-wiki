import { createHmac, timingSafeEqual } from "node:crypto";

/** Short-lived Wiki credential; it never contains a game token. */
export function createBridgeBrowserSessions({ key, now = Date.now } = {}) {
  if (!Buffer.isBuffer(key) || key.length < 32 || typeof now !== "function")
    throw new TypeError("invalid_session_key");
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
  ).toString("base64url");
  const signature = (value) => createHmac("sha256", key).update(value).digest();
  return Object.freeze({
    issue(owner, revision, device) {
      if (
        !/^[1-9][0-9]{0,19}$/.test(owner) ||
        !Number.isSafeInteger(revision) ||
        revision < 1 ||
        typeof device?.deviceId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(device.deviceId) ||
        !Number.isSafeInteger(device.generation) ||
        device.generation < 1
      )
        throw new TypeError("invalid_session_owner");
      const payload = Buffer.from(
        JSON.stringify({
          sub: owner,
          rev: revision,
          dev: device.deviceId,
          gen: device.generation,
          aud: "madhouse-bridge",
          exp: Math.floor(now() / 1000) + 900,
        }),
      ).toString("base64url");
      const value = `${header}.${payload}`;
      return `${value}.${signature(value).toString("base64url")}`;
    },
    verify(token) {
      if (typeof token !== "string" || token.length > 2048) return null;
      const parts = token.split(".");
      if (
        parts.length !== 3 ||
        parts[0] !== header ||
        parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
      )
        return null;
      const expected = signature(`${parts[0]}.${parts[1]}`);
      const actual = Buffer.from(parts[2], "base64url");
      if (
        actual.length !== expected.length ||
        actual.toString("base64url") !== parts[2] ||
        !timingSafeEqual(actual, expected)
      )
        return null;
      try {
        const value = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf8"),
        );
        if (
          !value ||
          value.aud !== "madhouse-bridge" ||
          !/^[1-9][0-9]{0,19}$/.test(value.sub) ||
          !Number.isSafeInteger(value.rev) ||
          value.rev < 1 ||
          typeof value.dev !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(value.dev) ||
          !Number.isSafeInteger(value.gen) ||
          value.gen < 1 ||
          !Number.isSafeInteger(value.exp) ||
          value.exp <= Math.floor(now() / 1000)
        )
          return null;
        return {
          owner: value.sub,
          revision: value.rev,
          deviceId: value.dev,
          generation: value.gen,
        };
      } catch {
        return null;
      }
    },
  });
}

/** Resolve only the current binding; caller must not return authorization to the browser. */
export function resolveBridgeBrowserSession(
  token,
  { sessions, accounts, devices } = {},
) {
  if (
    typeof sessions?.verify !== "function" ||
    typeof accounts?.read !== "function" ||
    typeof devices?.listDevice !== "function"
  )
    throw new TypeError("session_dependencies_required");
  const session = sessions.verify(token);
  if (!session) return null;
  const account = accounts.read(session.owner);
  const device = devices.listDevice(session.owner);
  if (
    !account ||
    account.revision !== session.revision ||
    !device ||
    session.deviceId !== device.deviceId ||
    session.generation !== device.generation
  )
    return null;
  return {
    owner: session.owner,
    revision: account.revision,
    authorization: account.authorization,
  };
}
