import { createHmac, randomBytes, randomUUID } from "node:crypto";

const ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const OWNER = /^[1-9][0-9]{0,15}$/;
const INVITATION_TTL_MS = 5 * 60_000;

function failure(code) {
  return Object.assign(new Error(code), { code });
}

/**
 * Registry persistence over an already protected SQLite database. `owner` is
 * supplied by a verified identity boundary, never trusted from the device.
 * Key management, HTTP authentication and rate limiting are caller duties.
 */
export function createDeviceRegistry({
  db,
  hmacKey,
  now = Date.now,
  routeWitness = null,
} = {}) {
  if (
    !db ||
    !Buffer.isBuffer(hmacKey) ||
    hmacKey.length !== 32 ||
    typeof now !== "function"
  )
    throw new TypeError("invalid_registry_dependencies");
  const secretKey = Buffer.from(hmacKey);
  const hash = (domain, value) =>
    createHmac("sha256", secretKey)
      .update(domain)
      .update("\0")
      .update(value)
      .digest("hex");
  const checkOwner = (owner) => {
    if (
      typeof owner !== "string" ||
      !OWNER.test(owner) ||
      !Number.isSafeInteger(Number(owner))
    )
      throw failure("invalid_owner");
    return hash("owner", owner);
  };
  const clock = () => {
    const value = now();
    if (
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > Number.MAX_SAFE_INTEGER - INVITATION_TTL_MS
    )
      throw failure("invalid_clock");
    return value;
  };
  const validSecret = (secret) =>
    typeof secret === "string" &&
    SECRET.test(secret) &&
    Buffer.from(secret, "base64url").toString("base64url") === secret;
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_bridge_invites (
    digest TEXT PRIMARY KEY, owner_key TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mobile_bridge_devices (
    device_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL UNIQUE, credential_digest TEXT NOT NULL, generation INTEGER NOT NULL, active INTEGER NOT NULL
  );`);
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };

  function issueInvitation(owner) {
    const ownerKey = checkOwner(owner);
    const expiresAt = clock() + INVITATION_TTL_MS;
    const invitation = randomBytes(32).toString("base64url");
    transaction(() => {
      const previous = db
        .prepare("SELECT digest FROM mobile_bridge_invites WHERE owner_key = ?")
        .get(ownerKey);
      if (previous) routeWitness?.recordConsumedInvite(previous.digest);
      db.prepare(
        "DELETE FROM mobile_bridge_invites WHERE owner_key = ? OR expires_at <= ?",
      ).run(ownerKey, clock());
      db.prepare("INSERT INTO mobile_bridge_invites VALUES (?, ?, ?)").run(
        hash("invitation", invitation),
        ownerKey,
        expiresAt,
      );
    });
    return { invitation, expiresAt };
  }

  function redeemInvitation(invitation) {
    if (!validSecret(invitation)) throw failure("invalid_invitation");
    return transaction(() => {
      const digest = hash("invitation", invitation);
      if (routeWitness?.isInviteConsumed(digest))
        throw failure("invalid_invitation");
      const row = db
        .prepare(
          "SELECT owner_key, expires_at FROM mobile_bridge_invites WHERE digest = ?",
        )
        .get(digest);
      if (!row || row.expires_at <= clock()) {
        // Expired entries are unusable even when no cleanup has run.
        throw failure("invalid_invitation");
      }
      const existing = db
        .prepare(
          "SELECT active, device_id FROM mobile_bridge_devices WHERE owner_key = ?",
        )
        .get(row.owner_key);
      if (
        existing?.active === 1 &&
        !routeWitness?.isDeviceRevoked(
          hash("revoked-device", existing.device_id),
        )
      )
        throw failure("device_already_active");
      const deviceId = randomUUID();
      const deviceKey = randomBytes(32).toString("base64url");
      routeWitness?.recordConsumedInvite(digest);
      db.prepare("DELETE FROM mobile_bridge_invites WHERE digest = ?").run(
        digest,
      );
      db.prepare("DELETE FROM mobile_bridge_devices WHERE owner_key = ?").run(
        row.owner_key,
      );
      db.prepare(
        "INSERT INTO mobile_bridge_devices VALUES (?, ?, ?, 1, 1)",
      ).run(deviceId, row.owner_key, hash("device", deviceKey));
      return { deviceId, deviceKey, generation: 1 };
    });
  }

  function authenticate(owner, deviceId, deviceKey, generation) {
    const ownerKey = checkOwner(owner);
    if (
      !ID.test(deviceId || "") ||
      !validSecret(deviceKey) ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      return false;
    if (routeWitness?.isDeviceRevoked(hash("revoked-device", deviceId)))
      return false;
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM mobile_bridge_devices WHERE owner_key = ? AND device_id = ? AND credential_digest = ? AND generation = ? AND active = 1",
        )
        .get(ownerKey, deviceId, hash("device", deviceKey), generation),
    );
  }

  function authenticateDevice(deviceId, deviceKey) {
    if (!ID.test(deviceId || "") || !validSecret(deviceKey)) return null;
    if (routeWitness?.isDeviceRevoked(hash("revoked-device", deviceId)))
      return null;
    const row = db
      .prepare(
        "SELECT owner_key, generation FROM mobile_bridge_devices WHERE device_id = ? AND credential_digest = ? AND active = 1",
      )
      .get(deviceId, hash("device", deviceKey));
    return row
      ? { owner: row.owner_key, device: deviceId, generation: row.generation }
      : null;
  }

  function isActive(identity) {
    if (
      !identity ||
      !/^[a-f0-9]{64}$/.test(identity.owner || "") ||
      !ID.test(identity.device || "") ||
      !Number.isSafeInteger(identity.generation) ||
      identity.generation < 1
    )
      return false;
    if (routeWitness?.isDeviceRevoked(hash("revoked-device", identity.device)))
      return false;
    return Boolean(
      db
        .prepare(
          "SELECT 1 FROM mobile_bridge_devices WHERE owner_key = ? AND device_id = ? AND generation = ? AND active = 1",
        )
        .get(identity.owner, identity.device, identity.generation),
    );
  }

  function listDevice(owner) {
    const ownerKey = checkOwner(owner);
    const row = db
      .prepare(
        "SELECT device_id, generation FROM mobile_bridge_devices WHERE owner_key = ? AND active = 1",
      )
      .get(ownerKey);
    return row &&
      !routeWitness?.isDeviceRevoked(hash("revoked-device", row.device_id))
      ? { deviceId: row.device_id, generation: row.generation }
      : null;
  }

  function revoke(owner, deviceId) {
    const ownerKey = checkOwner(owner);
    if (!ID.test(deviceId || "")) throw failure("invalid_device");
    return transaction(() => {
      const found = db
        .prepare(
          "SELECT 1 FROM mobile_bridge_devices WHERE owner_key = ? AND device_id = ? AND active = 1",
        )
        .get(ownerKey, deviceId);
      if (!found) return false;
      routeWitness?.recordRevokedDevice(hash("revoked-device", deviceId));
      return (
        db
          .prepare(
            "UPDATE mobile_bridge_devices SET active = 0, generation = generation + 1 WHERE owner_key = ? AND device_id = ? AND active = 1",
          )
          .run(ownerKey, deviceId).changes === 1
      );
    });
  }
  return Object.freeze({
    issueInvitation,
    redeemInvitation,
    authenticate,
    authenticateDevice,
    isActive,
    ownerKey: checkOwner,
    listDevice,
    revoke,
  });
}
