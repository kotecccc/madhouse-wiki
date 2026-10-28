import { constants, closeSync, fstatSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

/**
 * A separately retained, append-only route fence. Provision explicitly on a
 * fresh installation; never restore it from the bridge database backup.
 */
export function createRouteWitness({
  path,
  keyFingerprint,
  provision = false,
} = {}) {
  if (
    typeof path !== "string" ||
    !path.startsWith("/") ||
    !/^[a-f0-9]{64}$/.test(keyFingerprint || "")
  )
    throw new TypeError("route_witness_path_required");
  let fd;
  try {
    const flags =
      constants.O_RDWR |
      constants.O_NOFOLLOW |
      (provision ? constants.O_CREAT | constants.O_EXCL : 0);
    fd = openSync(path, flags, 0o600);
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    )
      throw new Error("route_witness_permissions_invalid");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;");
    if (provision) {
      db.exec(`CREATE TABLE route_witness_meta (version INTEGER NOT NULL, fingerprint TEXT NOT NULL);
      CREATE TABLE route_witness_owners (owner_key TEXT PRIMARY KEY);
      CREATE TABLE route_witness_players (player_key TEXT PRIMARY KEY);
      CREATE TABLE route_witness_revoked_devices (digest TEXT PRIMARY KEY);
      CREATE TABLE route_witness_consumed_invites (digest TEXT PRIMARY KEY);
      CREATE TABLE route_witness_accounts (owner_key TEXT PRIMARY KEY, player_key TEXT NOT NULL, revision INTEGER NOT NULL, credential_digest TEXT NOT NULL);
      CREATE TABLE route_witness_leases (lease_id TEXT PRIMARY KEY, owner_key TEXT, player_key TEXT);
      CREATE TABLE route_witness_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
      CREATE TABLE route_witness_clock (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), last_time INTEGER NOT NULL);`);
      db.prepare("INSERT INTO route_witness_meta VALUES (5, ?)").run(
        keyFingerprint,
      );
    }
    const meta = db
      .prepare("SELECT version, fingerprint FROM route_witness_meta")
      .all();
    if (
      meta.length !== 1 ||
      meta[0].version !== 5 ||
      meta[0].fingerprint !== keyFingerprint
    )
      throw new Error("route_witness_invalid");
    function record(ownerKey, playerKey, revision, credentialDigest) {
      if (
        !/^[a-f0-9]{64}$/.test(ownerKey || "") ||
        !/^[a-f0-9]{64}$/.test(playerKey || "") ||
        !/^[a-f0-9]{64}$/.test(credentialDigest || "") ||
        !Number.isSafeInteger(revision) ||
        revision < 1
      )
        throw new TypeError("invalid_route_witness_identity");
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = db
          .prepare(
            "SELECT player_key, revision, credential_digest FROM route_witness_accounts WHERE owner_key = ?",
          )
          .get(ownerKey);
        if (
          previous &&
          (previous.player_key !== playerKey ||
            previous.revision > revision ||
            (previous.revision === revision &&
              previous.credential_digest !== credentialDigest))
        )
          throw new Error("route_witness_account_rollback");
        db.prepare("INSERT OR IGNORE INTO route_witness_owners VALUES (?)").run(
          ownerKey,
        );
        db.prepare(
          "INSERT OR IGNORE INTO route_witness_players VALUES (?)",
        ).run(playerKey);
        db.prepare(
          `INSERT INTO route_witness_accounts VALUES (?, ?, ?, ?)
          ON CONFLICT(owner_key) DO UPDATE SET player_key=excluded.player_key, revision=excluded.revision, credential_digest=excluded.credential_digest`,
        ).run(ownerKey, playerKey, revision, credentialDigest);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    function consumeNonce(nonce, now) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = db
          .prepare(
            "SELECT last_time FROM route_witness_clock WHERE singleton = 1",
          )
          .get();
        if (previous && now < previous.last_time) {
          db.exec("ROLLBACK");
          return false;
        }
        db.prepare(
          "INSERT INTO route_witness_clock VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET last_time = excluded.last_time",
        ).run(now);
        db.prepare(
          "DELETE FROM route_witness_nonces WHERE expires_at <= ?",
        ).run(now);
        if (
          db.prepare("SELECT COUNT(*) AS count FROM route_witness_nonces").get()
            .count >= 10000
        ) {
          db.exec("ROLLBACK");
          return false;
        }
        const inserted =
          db
            .prepare("INSERT OR IGNORE INTO route_witness_nonces VALUES (?, ?)")
            .run(nonce, now + 60001).changes === 1;
        db.exec("COMMIT");
        return inserted;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    return Object.freeze({
      record,
      matchesAccount: (ownerKey, playerKey, revision, credentialDigest) =>
        !!db
          .prepare(
            "SELECT 1 FROM route_witness_accounts WHERE owner_key = ? AND player_key = ? AND revision = ? AND credential_digest = ?",
          )
          .get(ownerKey, playerKey, revision, credentialDigest),
      consumeNonce,
      beginLease: (leaseId, ownerKey, playerKey) =>
        db
          .prepare("INSERT INTO route_witness_leases VALUES (?, ?, ?)")
          .run(leaseId, ownerKey, playerKey),
      finishLease: (leaseId) =>
        db
          .prepare("DELETE FROM route_witness_leases WHERE lease_id = ?")
          .run(leaseId),
      hasPending: (ownerKey, playerKey) =>
        !!db
          .prepare(
            "SELECT 1 FROM route_witness_leases WHERE owner_key = ? OR player_key = ? OR owner_key IS NULL LIMIT 1",
          )
          .get(ownerKey, playerKey),
      recordRevokedDevice: (digest) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO route_witness_revoked_devices VALUES (?)",
          )
          .run(digest),
      isDeviceRevoked: (digest) =>
        !!db
          .prepare(
            "SELECT 1 FROM route_witness_revoked_devices WHERE digest = ?",
          )
          .get(digest),
      recordConsumedInvite: (digest) =>
        db
          .prepare(
            "INSERT OR IGNORE INTO route_witness_consumed_invites VALUES (?)",
          )
          .run(digest),
      isInviteConsumed: (digest) =>
        !!db
          .prepare(
            "SELECT 1 FROM route_witness_consumed_invites WHERE digest = ?",
          )
          .get(digest),
      hasOwner: (key) =>
        !!db
          .prepare("SELECT 1 FROM route_witness_owners WHERE owner_key = ?")
          .get(key),
      hasPlayer: (key) =>
        !!db
          .prepare("SELECT 1 FROM route_witness_players WHERE player_key = ?")
          .get(key),
      hasAnyOwner: () =>
        !!db.prepare("SELECT 1 FROM route_witness_owners LIMIT 1").get(),
      close: () => db.close(),
    });
  } catch (error) {
    db.close();
    throw error;
  }
}
