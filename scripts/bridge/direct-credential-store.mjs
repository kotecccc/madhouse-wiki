import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const fail = (code) => Object.assign(new Error(code), { code });

/** Verified direct-session fingerprints; raw game credentials never enter this store. */
export function createDirectCredentialStore({
  db,
  hmacKey,
  registry,
  accounts,
  routeWitness = null,
} = {}) {
  if (
    !db ||
    !Buffer.isBuffer(hmacKey) ||
    hmacKey.length !== 32 ||
    typeof registry?.ownerKey !== "function" ||
    typeof accounts?.verifiedPlayerKey !== "function"
  )
    throw new TypeError("direct_credential_dependencies_required");
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      hmacKey,
      Buffer.alloc(0),
      Buffer.from("bridge-direct-credential-v1"),
      32,
    ),
  );
  const index = (digest) =>
    createHmac("sha256", key).update("index:").update(digest).digest("hex");
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_bridge_direct_credentials (
    digest_key TEXT PRIMARY KEY, owner_key TEXT NOT NULL, player_key TEXT NOT NULL,
    ciphertext BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL
  );`);

  function register({ owner, playerId, credentialDigest, leaseId }) {
    if (
      !/^[a-f0-9]{64}$/.test(credentialDigest || "") ||
      !/^[a-f0-9-]{36}$/.test(leaseId || "")
    )
      throw fail("invalid_direct_credential");
    const ownerKey = registry.ownerKey(owner);
    const playerKey = accounts.verifiedPlayerKey(playerId);
    const digestKey = index(credentialDigest);
    db.exec("BEGIN IMMEDIATE");
    try {
      const lease = db
        .prepare(
          "SELECT phase, operation FROM mobile_bridge_owner_leases WHERE lease_id = ? AND owner_key = ?",
        )
        .get(leaseId, ownerKey);
      if (
        routeWitness?.hasOwner(ownerKey) ||
        routeWitness?.hasPlayer(playerKey) ||
        lease?.phase !== "dispatched" ||
        !["session_verify", "telegram_auth"].includes(lease.operation)
      )
        throw fail("owner_lease_invalid");
      if (
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_owner_tombstones WHERE owner_key = ?",
          )
          .get(ownerKey) ||
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_accounts WHERE owner_key = ? OR player_key = ?",
          )
          .get(ownerKey, playerKey) ||
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_route_tombstones WHERE player_key = ?",
          )
          .get(playerKey)
      )
        throw fail("bridge_route_required");
      const old = db
        .prepare(
          "SELECT owner_key, player_key FROM mobile_bridge_direct_credentials WHERE digest_key = ?",
        )
        .get(digestKey);
      if (old && (old.owner_key !== ownerKey || old.player_key !== playerKey))
        throw fail("credential_already_bound");
      if (
        !old &&
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM mobile_bridge_direct_credentials WHERE owner_key = ?",
          )
          .get(ownerKey).count >= 128
      )
        throw fail("credential_history_full");
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(`${digestKey}:${ownerKey}:${playerKey}`));
      const ciphertext = Buffer.concat([
        cipher.update(JSON.stringify({ owner, playerId })),
        cipher.final(),
      ]);
      db.prepare(
        "INSERT INTO mobile_bridge_direct_policies VALUES (?, 1) ON CONFLICT(player_key) DO NOTHING",
      ).run(playerKey);
      db.prepare(
        `INSERT INTO mobile_bridge_direct_credentials VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(digest_key) DO UPDATE SET ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag`,
      ).run(
        digestKey,
        ownerKey,
        playerKey,
        ciphertext,
        iv,
        cipher.getAuthTag(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function resolve(authorization) {
    if (
      typeof authorization !== "string" ||
      authorization.length > 8192 ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return null;
    const digest = createHash("sha256").update(authorization).digest("hex");
    const digestKey = index(digest);
    const row = db
      .prepare(
        "SELECT * FROM mobile_bridge_direct_credentials WHERE digest_key = ?",
      )
      .get(digestKey);
    if (!row) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, row.iv);
      decipher.setAAD(
        Buffer.from(`${digestKey}:${row.owner_key}:${row.player_key}`),
      );
      decipher.setAuthTag(row.tag);
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(row.ciphertext),
          decipher.final(),
        ]).toString("utf8"),
      );
      if (
        registry.ownerKey(value.owner) !== row.owner_key ||
        accounts.verifiedPlayerKey(value.playerId) !== row.player_key
      )
        throw new Error();
      return value;
    } catch {
      throw fail("account_storage_corrupt");
    }
  }
  return Object.freeze({ register, resolve });
}
