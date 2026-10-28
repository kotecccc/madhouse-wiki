import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

const MAX_AUTH = 8192;
function failure(code) {
  return Object.assign(new Error(code), { code });
}

/** Private server-only mapping and encrypted game credential; never expose read(). */
export function createBridgeAccountStore({
  db,
  hmacKey,
  registry,
  routeWitness = null,
} = {}) {
  if (
    !db ||
    !Buffer.isBuffer(hmacKey) ||
    hmacKey.length !== 32 ||
    typeof registry?.ownerKey !== "function" ||
    typeof registry?.isActive !== "function"
  )
    throw new TypeError("invalid_account_store_dependencies");
  const encKey = Buffer.from(
    hkdfSync(
      "sha256",
      hmacKey,
      Buffer.alloc(0),
      Buffer.from("madhouse-bridge-account-encryption-v1"),
      32,
    ),
  );
  const indexKey = Buffer.from(
    hkdfSync(
      "sha256",
      hmacKey,
      Buffer.alloc(0),
      Buffer.from("madhouse-bridge-account-index-v1"),
      32,
    ),
  );
  const playerKey = (id) =>
    createHmac("sha256", indexKey).update("player:").update(id).digest("hex");
  const credentialKey = (authorization) =>
    createHmac("sha256", indexKey)
      .update("credential:")
      .update(authorization)
      .digest("hex");
  const bindingTag = (digest, ownerKey) =>
    createHmac("sha256", indexKey)
      .update("binding:")
      .update(digest)
      .update(":")
      .update(ownerKey)
      .digest("hex");
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_bridge_accounts (
    owner_key TEXT PRIMARY KEY, player_key TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL,
    ciphertext BLOB NOT NULL, iv BLOB NOT NULL, tag BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mobile_bridge_credential_aliases (
    digest TEXT PRIMARY KEY, owner_key TEXT NOT NULL, binding_tag TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mobile_bridge_route_tombstones (
    player_key TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS mobile_bridge_owner_tombstones (
    owner_key TEXT PRIMARY KEY
  );
  CREATE TABLE IF NOT EXISTS mobile_bridge_owner_leases (
    lease_id TEXT PRIMARY KEY, owner_key TEXT NOT NULL, phase TEXT NOT NULL,
    operation TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS mobile_bridge_direct_leases (
    lease_id TEXT PRIMARY KEY, player_key TEXT NOT NULL, epoch INTEGER NOT NULL,
    phase TEXT NOT NULL DEFAULT 'prepared', effect TEXT NOT NULL DEFAULT 'unknown', created_at INTEGER NOT NULL DEFAULT 0
  );`);
  // Old experimental databases cannot prove whether their leases dispatched.
  const leaseColumns = new Set(
    db
      .prepare("PRAGMA table_info(mobile_bridge_direct_leases)")
      .all()
      .map((row) => row.name),
  );
  if (!leaseColumns.has("phase"))
    db.exec(
      "ALTER TABLE mobile_bridge_direct_leases ADD COLUMN phase TEXT NOT NULL DEFAULT 'dispatched'",
    );
  if (!leaseColumns.has("effect"))
    db.exec(
      "ALTER TABLE mobile_bridge_direct_leases ADD COLUMN effect TEXT NOT NULL DEFAULT 'unknown'",
    );
  if (!leaseColumns.has("created_at"))
    db.exec(
      "ALTER TABLE mobile_bridge_direct_leases ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0",
    );
  if (!leaseColumns.has("owner_key"))
    db.exec(
      "ALTER TABLE mobile_bridge_direct_leases ADD COLUMN owner_key TEXT",
    );
  function validPlayer(playerId) {
    return (
      typeof playerId === "string" &&
      /^[1-9][0-9]{0,15}$/.test(playerId) &&
      Number.isSafeInteger(Number(playerId))
    );
  }
  function getRevision(owner) {
    return (
      db
        .prepare(
          "SELECT revision FROM mobile_bridge_accounts WHERE owner_key = ?",
        )
        .get(registry.ownerKey(owner))?.revision || 0
    );
  }
  function saveVerified({
    owner,
    playerId,
    authorization,
    expectedRevision,
    deviceId,
    generation,
  }) {
    const ownerKey = registry.ownerKey(owner);
    if (
      !validPlayer(playerId) ||
      typeof authorization !== "string" ||
      authorization.length > MAX_AUTH ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      !Number.isSafeInteger(generation) ||
      generation < 1
    )
      throw failure("invalid_account_binding");
    db.exec("BEGIN IMMEDIATE");
    try {
      const active = registry.isActive({
        owner: ownerKey,
        device: deviceId,
        generation,
      });
      if (!active) throw failure("device_changed");
      if (
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_owner_leases WHERE owner_key = ? LIMIT 1",
          )
          .get(ownerKey)
      )
        throw failure("direct_requests_in_flight");
      const old = db
        .prepare(
          "SELECT revision, player_key FROM mobile_bridge_accounts WHERE owner_key = ?",
        )
        .get(ownerKey);
      if ((old?.revision || 0) !== expectedRevision)
        throw failure("binding_changed");
      const target = playerKey(playerId);
      if (old && old.player_key !== target) throw failure("account_mismatch");
      if (routeWitness?.hasPending(ownerKey, target))
        throw failure("direct_requests_in_flight");
      if (
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_direct_leases WHERE player_key = ? OR owner_key = ? OR owner_key IS NULL LIMIT 1",
          )
          .get(target, ownerKey)
      )
        throw failure("direct_requests_in_flight");
      const other = db
        .prepare(
          "SELECT owner_key FROM mobile_bridge_accounts WHERE player_key = ?",
        )
        .get(target);
      if (other && other.owner_key !== ownerKey)
        throw failure("account_already_bound");
      const credentialDigest = credentialKey(authorization);
      const alias = db
        .prepare(
          "SELECT owner_key FROM mobile_bridge_credential_aliases WHERE digest = ?",
        )
        .get(credentialDigest);
      if (alias && alias.owner_key !== ownerKey)
        throw failure("credential_already_bound");
      if (
        !alias &&
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM mobile_bridge_credential_aliases WHERE owner_key = ?",
          )
          .get(ownerKey).count >= 128
      )
        throw failure("credential_history_full");
      const revision = expectedRevision + 1;
      if (!Number.isSafeInteger(revision))
        throw failure("binding_revision_exhausted");
      // The independent fence is committed first. A later rollback is safe but
      // may conservatively block direct access until the binding is retried.
      routeWitness?.record(ownerKey, target, revision, credentialDigest);
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", encKey, iv);
      cipher.setAAD(Buffer.from(`${ownerKey}:${target}:${revision}`));
      const ciphertext = Buffer.concat([
        cipher.update(
          JSON.stringify({ owner, playerId, authorization }),
          "utf8",
        ),
        cipher.final(),
      ]);
      db.prepare(
        "INSERT INTO mobile_bridge_route_tombstones (player_key) VALUES (?) ON CONFLICT(player_key) DO NOTHING",
      ).run(target);
      db.prepare(
        "INSERT INTO mobile_bridge_owner_tombstones (owner_key) VALUES (?) ON CONFLICT(owner_key) DO NOTHING",
      ).run(ownerKey);
      db.prepare(
        `INSERT INTO mobile_bridge_accounts VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_key) DO UPDATE SET player_key=excluded.player_key, revision=excluded.revision, ciphertext=excluded.ciphertext, iv=excluded.iv, tag=excluded.tag`,
      ).run(ownerKey, target, revision, ciphertext, iv, cipher.getAuthTag());
      db.prepare(
        "INSERT INTO mobile_bridge_credential_aliases (digest, owner_key, binding_tag) VALUES (?, ?, ?) ON CONFLICT(digest) DO NOTHING",
      ).run(credentialDigest, ownerKey, bindingTag(credentialDigest, ownerKey));
      db.exec("COMMIT");
      return { revision };
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  function decode(row, ownerKey) {
    if (!row) return null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", encKey, row.iv);
      decipher.setAAD(
        Buffer.from(`${ownerKey}:${row.player_key}:${row.revision}`),
      );
      decipher.setAuthTag(row.tag);
      const value = JSON.parse(
        Buffer.concat([
          decipher.update(row.ciphertext),
          decipher.final(),
        ]).toString("utf8"),
      );
      if (
        !validPlayer(value.playerId) ||
        registry.ownerKey(value.owner) !== ownerKey ||
        playerKey(value.playerId) !== row.player_key ||
        typeof value.authorization !== "string" ||
        value.authorization.length > MAX_AUTH ||
        !/^Bearer [A-Za-z0-9._~-]+$/.test(value.authorization)
      )
        throw new Error();
      if (
        routeWitness &&
        !routeWitness.matchesAccount(
          ownerKey,
          row.player_key,
          row.revision,
          credentialKey(value.authorization),
        )
      )
        throw new Error();
      return {
        owner: value.owner,
        playerId: value.playerId,
        authorization: value.authorization,
        revision: row.revision,
      };
    } catch {
      throw failure("account_storage_corrupt");
    }
  }
  function read(owner) {
    const ownerKey = registry.ownerKey(owner);
    const row = db
      .prepare("SELECT * FROM mobile_bridge_accounts WHERE owner_key = ?")
      .get(ownerKey);
    const value = decode(row, ownerKey);
    if (!value) return null;
    return {
      playerId: value.playerId,
      authorization: value.authorization,
      revision: value.revision,
    };
  }
  function verifiedPlayerKey(playerId) {
    if (!validPlayer(playerId)) throw failure("invalid_player_id");
    return playerKey(playerId);
  }
  function resolveVerifiedPlayer(playerId) {
    if (!validPlayer(playerId)) throw failure("invalid_player_id");
    const row = db
      .prepare("SELECT * FROM mobile_bridge_accounts WHERE player_key = ?")
      .get(playerKey(playerId));
    if (!row) return null;
    const value = decode(row, row.owner_key);
    if (value.playerId !== playerId) throw failure("account_storage_corrupt");
    return {
      policy: "bridge_required",
      owner: value.owner,
      epoch: value.revision,
    };
  }
  function resolveCredential(authorization) {
    if (
      typeof authorization !== "string" ||
      authorization.length > MAX_AUTH ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return null;
    const digest = credentialKey(authorization);
    const alias = db
      .prepare(
        "SELECT owner_key, binding_tag FROM mobile_bridge_credential_aliases WHERE digest = ?",
      )
      .get(digest);
    if (!alias) return null;
    if (alias.binding_tag !== bindingTag(digest, alias.owner_key))
      throw failure("account_storage_corrupt");
    const row = db
      .prepare("SELECT * FROM mobile_bridge_accounts WHERE owner_key = ?")
      .get(alias.owner_key);
    if (!row) throw failure("account_storage_corrupt");
    const value = decode(row, alias.owner_key);
    return {
      policy: "bridge_required",
      owner: value.owner,
      epoch: value.revision,
      credentialCurrent: credentialKey(value.authorization) === digest,
    };
  }
  return Object.freeze({
    getRevision,
    saveVerified,
    read,
    resolveVerifiedPlayer,
    resolveCredential,
    verifiedPlayerKey,
  });
}
