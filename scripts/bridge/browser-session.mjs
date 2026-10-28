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
    issue(owner, revision) {
      if (
        !/^[1-9][0-9]{0,19}$/.test(owner) ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        throw new TypeError("invalid_session_owner");
      const payload = Buffer.from(
        JSON.stringify({
          sub: owner,
          rev: revision,
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
          !Number.isSafeInteger(value.exp) ||
          value.exp <= Math.floor(now() / 1000)
        )
          return null;
        return { owner: value.sub, revision: value.rev };
      } catch {
        return null;
      }
    },
  });
}
