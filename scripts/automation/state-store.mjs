import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";

// Goal series retain per-battle deduplication history across long runs.
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_GAME_AUTH_RECOVERY_RECORDS = 4096;
const MAX_GAME_AUTH_BOOTSTRAP_RECORDS = 4096;
const KEY_FILE = "encryption.key";
const DATABASE_FILE = "automation.sqlite";
const encoder = new TextEncoder();

function ensureDirectory(directory) {
  const absolute = resolve(directory);
  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("automation_state_directory_invalid");
  chmodSync(absolute, 0o700);
  return absolute;
}

function loadOrCreateKey(directory) {
  const path = join(directory, KEY_FILE);
  try {
    const fd = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const key = randomBytes(32);
      writeFileSync(fd, key);
      fsyncSync(fd);
      return key;
    } finally {
      closeSync(fd);
    }
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }

  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const pathStat = lstatSync(path);
    if (!stat.isFile() || !pathStat.isFile() || pathStat.isSymbolicLink())
      throw new Error("automation_encryption_key_invalid");
    if ((stat.mode & 0o077) !== 0)
      throw new Error("automation_encryption_key_permissions_invalid");
    const key = readFileSync(fd);
    if (key.byteLength !== 32)
      throw new Error("automation_encryption_key_invalid");
    return key;
  } catch (error) {
    if (error.code === "ELOOP")
      throw new Error("automation_encryption_key_invalid", { cause: error });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function normalizePlayerId(playerId) {
  if (
    !(typeof playerId === "number" && Number.isSafeInteger(playerId)) &&
    !(typeof playerId === "string" && /^[1-9]\d{0,15}$/u.test(playerId))
  )
    throw new TypeError("invalid_player_id");
  const normalized = String(playerId);
  if (
    !/^[1-9]\d{0,15}$/u.test(normalized) ||
    !Number.isSafeInteger(Number(normalized))
  )
    throw new TypeError("invalid_player_id");
  return normalized;
}

function normalizeOwnerId(ownerId) {
  if (
    !(typeof ownerId === "number" && Number.isSafeInteger(ownerId)) &&
    !(typeof ownerId === "string" && /^[1-9]\d{0,15}$/u.test(ownerId))
  )
    throw new TypeError("invalid_owner_id");
  const normalized = String(ownerId);
  if (
    !/^[1-9]\d{0,15}$/u.test(normalized) ||
    !Number.isSafeInteger(Number(normalized))
  )
    throw new TypeError("invalid_owner_id");
  return normalized;
}

const deviceIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
function validRouteRecord(record, playerId, allowDefault = false) {
  const keys = [
    "schemaVersion",
    "playerId",
    "policy",
    "activeDeviceId",
    "routeEpoch",
    "updatedAt",
  ];
  return Boolean(
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === keys.length &&
    keys.every((key) => Object.hasOwn(record, key)) &&
    record.schemaVersion === 1 &&
    record.playerId === playerId &&
    ["direct", "bridge_required"].includes(record.policy) &&
    Number.isSafeInteger(record.routeEpoch) &&
    record.routeEpoch >= (allowDefault ? 0 : 1) &&
    ((record.routeEpoch === 0 &&
      allowDefault &&
      record.policy === "direct" &&
      record.activeDeviceId === null &&
      record.updatedAt === null) ||
      (record.routeEpoch >= 1 &&
        Number.isSafeInteger(record.updatedAt) &&
        record.updatedAt >= 1 &&
        ((record.policy === "direct" && record.activeDeviceId === null) ||
          (record.policy === "bridge_required" &&
            typeof record.activeDeviceId === "string" &&
            deviceIdPattern.test(record.activeDeviceId))))),
  );
}

function opaqueId(key, playerId) {
  return createHmac("sha256", key)
    .update("automation-account:")
    .update(playerId)
    .digest("hex");
}

function opaqueOwnerId(key, ownerId) {
  return createHmac("sha256", key)
    .update("wiki-owner:")
    .update(ownerId)
    .digest("hex");
}

function opaqueBoundPlayerId(key, playerId) {
  return createHmac("sha256", key)
    .update("bound-game-player:")
    .update(playerId)
    .digest("hex");
}

function opaqueBridgeRequestKey(key, idempotencyKey) {
  return createHmac("sha256", key)
    .update("bridge-pairing-request:")
    .update(idempotencyKey)
    .digest("hex");
}

function validOwnerGameAccount(record, ownerId) {
  return Boolean(
    record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    Object.keys(record).length === 4 &&
    Object.hasOwn(record, "schemaVersion") &&
    Object.hasOwn(record, "ownerId") &&
    Object.hasOwn(record, "playerId") &&
    Object.hasOwn(record, "verifiedAt") &&
    record.schemaVersion === 1 &&
    typeof record.ownerId === "string" &&
    /^[1-9]\d{0,15}$/u.test(record.ownerId) &&
    Number.isSafeInteger(Number(record.ownerId)) &&
    record.ownerId === ownerId &&
    typeof record.playerId === "string" &&
    /^[1-9]\d{0,15}$/u.test(record.playerId) &&
    Number.isSafeInteger(Number(record.playerId)) &&
    Number.isSafeInteger(record.verifiedAt) &&
    record.verifiedAt >= 1,
  );
}

function encrypt(key, id, record) {
  const plaintext = Buffer.from(JSON.stringify(record));
  if (plaintext.byteLength > MAX_RECORD_BYTES)
    throw new RangeError("automation_record_too_large");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(encoder.encode(id));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString("base64url"),
    data: ciphertext.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
  });
}

function decrypt(key, id, envelopeText) {
  let envelope;
  try {
    envelope = JSON.parse(envelopeText);
  } catch {
    throw new Error("automation_state_corrupt");
  }
  if (
    envelope?.v !== 1 ||
    typeof envelope.iv !== "string" ||
    typeof envelope.data !== "string" ||
    typeof envelope.tag !== "string"
  )
    throw new Error("automation_state_corrupt");
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(envelope.iv, "base64url"),
    );
    decipher.setAAD(encoder.encode(id));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64url")),
      decipher.final(),
    ]);
    if (plaintext.byteLength > MAX_RECORD_BYTES)
      throw new Error("automation_state_corrupt");
    return JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("automation_state_authentication_failed");
  }
}

export function createAutomationStateStore({ directory }) {
  if (typeof directory !== "string" || !directory)
    throw new TypeError("automation_state_directory_required");
  const root = ensureDirectory(directory);
  const key = loadOrCreateKey(root);
  const commandAdmissionKey = createHmac("sha256", key)
    .update("madhouse-wiki-automation-command-admission-v1")
    .digest();
  const databasePath = join(root, DATABASE_FILE);
  if (!existsSync(databasePath)) {
    let fd;
    try {
      fd = openSync(
        databasePath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }
  {
    const stat = lstatSync(databasePath);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new Error("automation_state_database_invalid");
  }

  const db = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      account_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS account_snapshots (
      account_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS account_route_policies (
      account_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS owner_game_accounts (
      owner_key TEXT PRIMARY KEY NOT NULL,
      player_key TEXT NOT NULL UNIQUE,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS game_auth_recovery (
      owner_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS game_auth_bootstraps (
      owner_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS bridge_pairings (
      pairing_id TEXT PRIMARY KEY NOT NULL,
      request_key TEXT NOT NULL UNIQUE,
      device_id TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS bridge_devices (
      device_id TEXT PRIMARY KEY NOT NULL,
      owner_key TEXT NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS bridge_challenges (
      challenge_id TEXT PRIMARY KEY NOT NULL,
      device_id TEXT NOT NULL,
      expires_at_ms INTEGER NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS bridge_helper_controls (
      owner_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS worker_lease (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      owner TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS restore_guard (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      record TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS restore_reauthorized_accounts (
      player_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS restore_owner_consents (
      owner_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS restore_owner_challenges (
      owner_key TEXT PRIMARY KEY NOT NULL,
      record TEXT NOT NULL
    ) WITHOUT ROWID;
  `);
  const bridgePairingColumns = new Set(
    db
      .prepare("PRAGMA table_info(bridge_pairings)")
      .all()
      .map((row) => row.name),
  );
  if (!bridgePairingColumns.has("created_at_ms")) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      db.exec(
        "ALTER TABLE bridge_pairings ADD COLUMN created_at_ms INTEGER NOT NULL DEFAULT 0",
      );
      const oldPairings = db
        .prepare("SELECT pairing_id, record FROM bridge_pairings")
        .all();
      const setCreatedAt = db.prepare(
        "UPDATE bridge_pairings SET created_at_ms = ? WHERE pairing_id = ?",
      );
      for (const row of oldPairings) {
        const record = decrypt(
          key,
          `bridge-pairing:${row.pairing_id}`,
          row.record,
        );
        if (
          record?.pairingId !== row.pairing_id ||
          !Number.isSafeInteger(record.createdAtMs) ||
          record.createdAtMs < 1
        )
          throw new Error("automation_bridge_pairing_corrupt");
        setCreatedAt.run(record.createdAtMs, row.pairing_id);
      }
      db.exec("COMMIT;");
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS bridge_pairings_by_device ON bridge_pairings(device_id); CREATE INDEX IF NOT EXISTS bridge_pairings_by_created_at ON bridge_pairings(created_at_ms); CREATE INDEX IF NOT EXISTS bridge_challenges_by_device ON bridge_challenges(device_id); CREATE INDEX IF NOT EXISTS bridge_challenges_by_expiry ON bridge_challenges(expires_at_ms);",
  );
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = databasePath + suffix;
    if (existsSync(sidecar)) chmodSync(sidecar, 0o600);
  }

  const select = db.prepare(
    "SELECT record FROM accounts WHERE account_key = ?",
  );
  const upsert = db.prepare(
    "INSERT INTO accounts (account_key, record) VALUES (?, ?) ON CONFLICT(account_key) DO UPDATE SET record = excluded.record",
  );
  const snapshotSelect = db.prepare(
    "SELECT record FROM account_snapshots WHERE account_key = ?",
  );
  const snapshotUpsert = db.prepare(
    "INSERT INTO account_snapshots (account_key, record) VALUES (?, ?) ON CONFLICT(account_key) DO UPDATE SET record = excluded.record",
  );
  const snapshotAll = db.prepare(
    "SELECT account_key, record FROM account_snapshots",
  );
  const routeSelect = db.prepare(
    "SELECT record FROM account_route_policies WHERE account_key = ?",
  );
  const routeUpsert = db.prepare(
    "INSERT INTO account_route_policies (account_key, record) VALUES (?, ?) ON CONFLICT(account_key) DO UPDATE SET record = excluded.record",
  );
  const ownerBindingByOwner = db.prepare(
    "SELECT player_key, record FROM owner_game_accounts WHERE owner_key = ?",
  );
  const ownerBindingByPlayer = db.prepare(
    "SELECT owner_key, player_key, record FROM owner_game_accounts WHERE player_key = ?",
  );
  const ownerBindingInsert = db.prepare(
    "INSERT INTO owner_game_accounts (owner_key, player_key, record) VALUES (?, ?, ?)",
  );
  const gameAuthRecoverySelect = db.prepare(
    "SELECT record FROM game_auth_recovery WHERE owner_key = ?",
  );
  const gameAuthRecoveryAll = db.prepare(
    "SELECT owner_key, record FROM game_auth_recovery ORDER BY owner_key LIMIT 4097",
  );
  const gameAuthRecoveryCount = db.prepare(
    "SELECT COUNT(*) AS count FROM game_auth_recovery",
  );
  const gameAuthRecoveryUpsert = db.prepare(
    "INSERT INTO game_auth_recovery (owner_key, record) VALUES (?, ?) ON CONFLICT(owner_key) DO UPDATE SET record = excluded.record",
  );
  const gameAuthBootstrapSelect = db.prepare(
    "SELECT record FROM game_auth_bootstraps WHERE owner_key = ?",
  );
  const gameAuthBootstrapAll = db.prepare(
    "SELECT owner_key, record FROM game_auth_bootstraps ORDER BY owner_key LIMIT 4097",
  );
  const gameAuthBootstrapCount = db.prepare(
    "SELECT COUNT(*) AS count FROM game_auth_bootstraps",
  );
  const gameAuthBootstrapUpsert = db.prepare(
    "INSERT INTO game_auth_bootstraps (owner_key, record) VALUES (?, ?) ON CONFLICT(owner_key) DO UPDATE SET record = excluded.record",
  );
  const bridgePairingById = db.prepare(
    "SELECT pairing_id, request_key, device_id, created_at_ms, record FROM bridge_pairings WHERE pairing_id = ?",
  );
  const bridgePairingByRequestKey = db.prepare(
    "SELECT pairing_id, request_key, device_id, created_at_ms, record FROM bridge_pairings WHERE request_key = ?",
  );
  const bridgePairingsByDevice = db.prepare(
    "SELECT pairing_id, request_key, device_id, created_at_ms, record FROM bridge_pairings WHERE device_id = ?",
  );
  const bridgePairingInsert = db.prepare(
    "INSERT INTO bridge_pairings (pairing_id, request_key, device_id, created_at_ms, record) VALUES (?, ?, ?, ?, ?)",
  );
  const bridgePairingPrune = db.prepare(
    "DELETE FROM bridge_pairings WHERE created_at_ms <= ?",
  );
  const bridgePairingUpdate = db.prepare(
    "UPDATE bridge_pairings SET record = ? WHERE pairing_id = ? AND device_id = ?",
  );
  const bridgeDeviceById = db.prepare(
    "SELECT device_id, owner_key, record FROM bridge_devices WHERE device_id = ?",
  );
  const bridgeDevicesByOwner = db.prepare(
    "SELECT device_id, owner_key, record FROM bridge_devices WHERE owner_key = ?",
  );
  const bridgeDeviceInsert = db.prepare(
    "INSERT INTO bridge_devices (device_id, owner_key, record) VALUES (?, ?, ?)",
  );
  const bridgeDeviceUpdate = db.prepare(
    "UPDATE bridge_devices SET record = ? WHERE device_id = ? AND owner_key = ?",
  );
  const bridgeChallengeById = db.prepare(
    "SELECT challenge_id, device_id, expires_at_ms, record FROM bridge_challenges WHERE challenge_id = ?",
  );
  const bridgeChallengesByDevice = db.prepare(
    "SELECT challenge_id, device_id, expires_at_ms, record FROM bridge_challenges WHERE device_id = ?",
  );
  const bridgeChallengeInsert = db.prepare(
    "INSERT INTO bridge_challenges (challenge_id, device_id, expires_at_ms, record) VALUES (?, ?, ?, ?)",
  );
  const bridgeChallengeUpdate = db.prepare(
    "UPDATE bridge_challenges SET record = ? WHERE challenge_id = ? AND device_id = ? AND expires_at_ms = ?",
  );
  const bridgeChallengePrune = db.prepare(
    "DELETE FROM bridge_challenges WHERE expires_at_ms <= ?",
  );
  const bridgeHelperControlByOwner = db.prepare(
    "SELECT owner_key, record FROM bridge_helper_controls WHERE owner_key = ?",
  );
  const bridgeHelperControlUpsert = db.prepare(
    "INSERT INTO bridge_helper_controls (owner_key, record) VALUES (?, ?) ON CONFLICT(owner_key) DO UPDATE SET record = excluded.record",
  );
  const selectAll = db.prepare(
    "SELECT account_key, record FROM accounts ORDER BY account_key",
  );
  const acquireLeaseStatement = db.prepare(`
    INSERT INTO worker_lease (singleton, owner, expires_at)
    VALUES (1, ?, ?)
    ON CONFLICT(singleton) DO UPDATE
    SET owner = excluded.owner, expires_at = excluded.expires_at
    WHERE worker_lease.owner = excluded.owner OR worker_lease.expires_at <= ?
  `);
  const releaseLeaseStatement = db.prepare(
    "DELETE FROM worker_lease WHERE singleton = 1 AND owner = ?",
  );
  const restoreGuardSelect = db.prepare(
    "SELECT record FROM restore_guard WHERE singleton = 1",
  );
  const restoreGuardInsert = db.prepare(
    "INSERT INTO restore_guard (singleton, record) VALUES (1, ?)",
  );
  const restoreGuardUpsert = db.prepare(
    "INSERT INTO restore_guard (singleton, record) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET record = excluded.record",
  );
  const restoreAccountSelect = db.prepare(
    "SELECT record FROM restore_reauthorized_accounts WHERE player_key = ?",
  );
  const restoreAccountUpsert = db.prepare(
    "INSERT INTO restore_reauthorized_accounts (player_key, record) VALUES (?, ?) ON CONFLICT(player_key) DO UPDATE SET record = excluded.record",
  );
  const restoreAccountDeleteAll = db.prepare(
    "DELETE FROM restore_reauthorized_accounts",
  );
  const restoreConsentSelect = db.prepare(
    "SELECT record FROM restore_owner_consents WHERE owner_key = ?",
  );
  const restoreConsentUpsert = db.prepare(
    "INSERT INTO restore_owner_consents (owner_key, record) VALUES (?, ?) ON CONFLICT(owner_key) DO UPDATE SET record = excluded.record",
  );
  const restoreConsentDeleteAll = db.prepare(
    "DELETE FROM restore_owner_consents",
  );
  const restoreChallengeSelect = db.prepare(
    "SELECT record FROM restore_owner_challenges WHERE owner_key = ?",
  );
  const restoreChallengeUpsert = db.prepare(
    "INSERT INTO restore_owner_challenges (owner_key, record) VALUES (?, ?) ON CONFLICT(owner_key) DO UPDATE SET record = excluded.record",
  );
  const restoreChallengeDelete = db.prepare(
    "DELETE FROM restore_owner_challenges WHERE owner_key = ?",
  );
  const restoreChallengeDeleteAll = db.prepare(
    "DELETE FROM restore_owner_challenges",
  );

  function transaction(run) {
    db.exec("BEGIN IMMEDIATE;");
    try {
      const result = run();
      db.exec("COMMIT;");
      return result;
    } catch (error) {
      db.exec("ROLLBACK;");
      throw error;
    }
  }

  function readRestoreGuard() {
    const row = restoreGuardSelect.get();
    if (!row) return null;
    const record = decrypt(key, "restore-guard", row.record);
    if (
      record?.schemaVersion !== 1 ||
      !Number.isSafeInteger(record.activatedAt) ||
      record.activatedAt < 1
    )
      throw new Error("automation_restore_guard_corrupt");
    return record;
  }

  function readRestoreOwnerConsentRecord(ownerId) {
    const ownerKey = opaqueOwnerId(key, ownerId);
    const row = restoreConsentSelect.get(ownerKey);
    if (!row) return null;
    const record = decrypt(
      key,
      `restore-owner-consent:${ownerKey}`,
      row.record,
    );
    if (
      record?.schemaVersion !== 1 ||
      record.ownerId !== ownerId ||
      typeof record.requestId !== "string" ||
      !uuidPattern.test(record.requestId) ||
      record.routePolicy !== "direct" ||
      !Number.isSafeInteger(record.confirmedAt) ||
      !Number.isSafeInteger(record.identityIssuedAt) ||
      !Number.isSafeInteger(record.restoreActivatedAt) ||
      record.identityIssuedAt <
        Math.floor(record.restoreActivatedAt / 1000) * 1000 ||
      record.identityIssuedAt > record.confirmedAt ||
      record.confirmedAt < record.restoreActivatedAt ||
      record.restoreActivatedAt < 1
    )
      throw new Error("automation_restore_consent_corrupt");
    return readRestoreGuard()?.activatedAt === record.restoreActivatedAt
      ? record
      : null;
  }

  function readRestoreAuthorization(playerId, playerKey) {
    const row = restoreAccountSelect.get(playerKey);
    if (!row) return null;
    const record = decrypt(key, `restore-account:${playerKey}`, row.record);
    if (
      record?.schemaVersion !== 1 ||
      record.playerId !== playerId ||
      typeof record.ownerId !== "string" ||
      !/^[1-9][0-9]{0,15}$/u.test(record.ownerId) ||
      !Number.isSafeInteger(Number(record.ownerId)) ||
      !Number.isSafeInteger(record.verifiedAt) ||
      record.verifiedAt < 1 ||
      (record.reviewConfirmed !== undefined &&
        typeof record.reviewConfirmed !== "boolean")
    )
      throw new Error("automation_restore_account_corrupt");
    return record;
  }

  function isRestoreAccountReauthorized(playerId) {
    const guard = readRestoreGuard();
    if (!guard) return false;
    const playerKey = opaqueBoundPlayerId(key, playerId);
    const authorization = readRestoreAuthorization(playerId, playerKey);
    if (!authorization) return false;
    const ownerKey = opaqueOwnerId(key, authorization.ownerId);
    const bindingRow = ownerBindingByPlayer.get(playerKey);
    if (!bindingRow) return false;
    const binding = decrypt(key, bindingRow.owner_key, bindingRow.record);
    return (
      binding?.ownerId === authorization.ownerId &&
      binding?.playerId === playerId &&
      bindingRow.owner_key === ownerKey
    );
  }

  function hasUnresolvedMutation(playerId) {
    const id = opaqueId(key, playerId);
    const row = select.get(id);
    if (!row) return false;
    const record = decrypt(key, id, row.record);
    if (
      !record ||
      record.playerId !== playerId ||
      !Object.hasOwn(record, "value")
    )
      throw new Error("automation_state_corrupt");
    const value = record.value;
    const present = (item) =>
      item !== undefined && item !== null && item !== false;
    return Boolean(
      present(value?.battle?.pending) ||
      present(value?.battle?.pendingInvitation) ||
      value?.battle?.needsRefresh === true ||
      value?.battle?.purchaseUncertain === true ||
      present(value?.assistant?.pending) ||
      present(value?.equipment?.pending) ||
      present(value?.characterUpgrade?.pending) ||
      present(value?.buddyHelp?.pending) ||
      present(value?.buddyHelp?.stashPending) ||
      present(value?.friendRemoval?.pending) ||
      present(value?.raidFriend?.pending) ||
      present(value?.pvp?.pending) ||
      value?.floorRunner?.phase === "launching" ||
      value?.auto?.phase === "starting" ||
      present(value?.workFarm?.run?.pending) ||
      present(value?.workFarm?.manualPending) ||
      present(value?.businessHelper?.run?.pending) ||
      present(value?.businessHelper?.run?.pendingUpgrade),
    );
  }

  function resetRestoreGuard(activatedAt) {
    return transaction(() => {
      restoreGuardUpsert.run(
        encrypt(key, "restore-guard", {
          schemaVersion: 1,
          activatedAt,
        }),
      );
      restoreAccountDeleteAll.run();
      restoreConsentDeleteAll.run();
      restoreChallengeDeleteAll.run();
      db.exec(`
        DELETE FROM account_route_policies;
        DELETE FROM owner_game_accounts;
        DELETE FROM game_auth_recovery;
        DELETE FROM game_auth_bootstraps;
        DELETE FROM bridge_pairings;
        DELETE FROM bridge_devices;
        DELETE FROM bridge_challenges;
        DELETE FROM worker_lease;
      `);
      return true;
    });
  }

  const gameAuthStates = new Set([
    "created",
    "launch_requested",
    "exchange_pending",
    "verification_pending",
    "credential_stored",
    "ready",
    "auth_outcome_unknown",
    "failed",
    "cancelled",
    "logout_pending",
    "logged_out",
  ]);
  const gameAuthReasons = new Set([
    "auth_required",
    "device_offline",
    "invalid_game_session",
    "game_unavailable",
    "consent_required",
    "route_stale",
    "credential_unavailable",
    "storage_unavailable",
    "unknown_outcome",
  ]);
  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
  function validGameAuthRecovery(record, ownerId) {
    const required = [
      "schemaVersion",
      "ownerId",
      "playerId",
      "operationId",
      "authGeneration",
      "consentGeneration",
      "routeEpoch",
      "state",
      "expectedCredentialVersion",
      "credentialVersion",
      "updatedAt",
    ];
    const allowed = new Set([...required, "reason"]);
    return Boolean(
      record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      required.every((key) => Object.hasOwn(record, key)) &&
      Object.keys(record).every((key) => allowed.has(key)) &&
      record.schemaVersion === 1 &&
      record.ownerId === ownerId &&
      typeof record.playerId === "string" &&
      /^[1-9][0-9]{0,15}$/u.test(record.playerId) &&
      Number.isSafeInteger(Number(record.playerId)) &&
      typeof record.operationId === "string" &&
      uuidPattern.test(record.operationId) &&
      Number.isSafeInteger(record.authGeneration) &&
      record.authGeneration >= 1 &&
      Number.isSafeInteger(record.consentGeneration) &&
      record.consentGeneration >= 1 &&
      Number.isSafeInteger(record.routeEpoch) &&
      record.routeEpoch >= 1 &&
      gameAuthStates.has(record.state) &&
      Number.isSafeInteger(record.expectedCredentialVersion) &&
      record.expectedCredentialVersion >= 0 &&
      (record.credentialVersion === null ||
        (Number.isSafeInteger(record.credentialVersion) &&
          record.credentialVersion >= 1)) &&
      (!(record.state === "credential_stored" || record.state === "ready") ||
        record.credentialVersion === record.expectedCredentialVersion + 1) &&
      Number.isSafeInteger(record.updatedAt) &&
      record.updatedAt >= 1 &&
      (record.reason === undefined || gameAuthReasons.has(record.reason)) &&
      !("credential" in record) &&
      !("accessToken" in record) &&
      !("launchData" in record),
    );
  }

  function readGameAuthRecoveryRow(ownerId, ownerKey) {
    const row = gameAuthRecoverySelect.get(ownerKey);
    if (!row) return null;
    const record = decrypt(key, `game-auth-recovery:${ownerKey}`, row.record);
    if (!validGameAuthRecovery(record, ownerId))
      throw new Error("automation_game_auth_recovery_corrupt");
    return record;
  }

  function readGameAuthRecoveryByOwner(ownerId) {
    const normalizedOwnerId = normalizeOwnerId(ownerId);
    return readGameAuthRecoveryRow(
      normalizedOwnerId,
      opaqueOwnerId(key, normalizedOwnerId),
    );
  }

  function writeGameAuthRecoveryRecord(record) {
    const ownerKey = opaqueOwnerId(key, record.ownerId);
    gameAuthRecoveryUpsert.run(
      ownerKey,
      encrypt(key, `game-auth-recovery:${ownerKey}`, record),
    );
    return record;
  }

  const gameAuthBootstrapStates = new Set([
    "prepared",
    "exchange_pending",
    "verification_pending",
    "credential_stored",
    "ready",
    "auth_outcome_unknown",
    "failed",
    "cancelled",
  ]);
  const gameAuthBootstrapReasons = new Set([
    "invalid_game_session",
    "game_unavailable",
    "credential_unavailable",
    "storage_unavailable",
    "unknown_outcome",
    "unknown_acknowledged",
  ]);
  const allowedGameAuthBootstrapTransitions = Object.freeze({
    prepared: new Set(["exchange_pending", "failed", "cancelled"]),
    exchange_pending: new Set([
      "verification_pending",
      "auth_outcome_unknown",
      "failed",
    ]),
    verification_pending: new Set([
      "credential_stored",
      "auth_outcome_unknown",
      "failed",
    ]),
    credential_stored: new Set(["ready", "auth_outcome_unknown"]),
    auth_outcome_unknown: new Set(["failed", "credential_stored"]),
  });
  function validGameAuthBootstrap(record, ownerId) {
    const required = [
      "schemaVersion",
      "ownerId",
      "requestId",
      "operationId",
      "authGeneration",
      "consentGeneration",
      "routeEpoch",
      "launchDataDigest",
      "state",
      "expectedCredentialVersion",
      "credentialVersion",
      "playerId",
      "createdAt",
      "updatedAt",
    ];
    const allowed = new Set([...required, "reason"]);
    const playerId = record?.playerId;
    const credentialStored = ["credential_stored", "ready"].includes(
      record?.state,
    );
    return Boolean(
      record &&
      typeof record === "object" &&
      !Array.isArray(record) &&
      required.every((field) => Object.hasOwn(record, field)) &&
      Object.keys(record).every((field) => allowed.has(field)) &&
      record.schemaVersion === 1 &&
      record.ownerId === ownerId &&
      typeof record.requestId === "string" &&
      uuidPattern.test(record.requestId) &&
      typeof record.operationId === "string" &&
      uuidPattern.test(record.operationId) &&
      Number.isSafeInteger(record.authGeneration) &&
      record.authGeneration >= 1 &&
      Number.isSafeInteger(record.consentGeneration) &&
      record.consentGeneration >= 1 &&
      Number.isSafeInteger(record.routeEpoch) &&
      record.routeEpoch >= 0 &&
      typeof record.launchDataDigest === "string" &&
      /^[a-f0-9]{64}$/u.test(record.launchDataDigest) &&
      gameAuthBootstrapStates.has(record.state) &&
      Number.isSafeInteger(record.expectedCredentialVersion) &&
      record.expectedCredentialVersion >= 0 &&
      (record.credentialVersion === null ||
        (Number.isSafeInteger(record.credentialVersion) &&
          record.credentialVersion >= 1)) &&
      (playerId === null ||
        (typeof playerId === "string" &&
          /^[1-9][0-9]{0,15}$/u.test(playerId) &&
          Number.isSafeInteger(Number(playerId)))) &&
      (credentialStored
        ? playerId !== null &&
          record.credentialVersion === record.expectedCredentialVersion + 1
        : record.credentialVersion === null) &&
      Number.isSafeInteger(record.createdAt) &&
      record.createdAt >= 1 &&
      Number.isSafeInteger(record.updatedAt) &&
      record.updatedAt >= record.createdAt &&
      (record.reason === undefined ||
        gameAuthBootstrapReasons.has(record.reason)) &&
      !("credential" in record) &&
      !("accessToken" in record) &&
      !("launchData" in record) &&
      !("initData" in record),
    );
  }

  function readGameAuthBootstrapRow(ownerId, ownerKey) {
    const row = gameAuthBootstrapSelect.get(ownerKey);
    if (!row) return null;
    const record = decrypt(key, `game-auth-bootstrap:${ownerKey}`, row.record);
    if (!validGameAuthBootstrap(record, ownerId))
      throw new Error("automation_game_auth_bootstrap_corrupt");
    return record;
  }

  function writeGameAuthBootstrapRecord(record) {
    const ownerKey = opaqueOwnerId(key, record.ownerId);
    gameAuthBootstrapUpsert.run(
      ownerKey,
      encrypt(key, `game-auth-bootstrap:${ownerKey}`, record),
    );
    return record;
  }

  const activeGameAuthStates = new Set([
    "created",
    "launch_requested",
    "exchange_pending",
    "verification_pending",
    "credential_stored",
    "auth_outcome_unknown",
    "logout_pending",
  ]);
  const allowedGameAuthTransitions = Object.freeze({
    created: new Set(["launch_requested", "failed", "cancelled"]),
    launch_requested: new Set([
      "exchange_pending",
      "failed",
      "cancelled",
      "auth_outcome_unknown",
    ]),
    exchange_pending: new Set([
      "verification_pending",
      "failed",
      "auth_outcome_unknown",
    ]),
    verification_pending: new Set([
      "credential_stored",
      "failed",
      "auth_outcome_unknown",
    ]),
    credential_stored: new Set(["ready", "auth_outcome_unknown"]),
    auth_outcome_unknown: new Set([
      "auth_outcome_unknown",
      "credential_stored",
      "failed",
    ]),
    ready: new Set(["ready", "auth_outcome_unknown"]),
    failed: new Set(["failed"]),
    cancelled: new Set(["cancelled"]),
    logout_pending: new Set(["logged_out"]),
    logged_out: new Set(["logged_out"]),
  });

  return {
    signCommandAdmissionTicket(payload) {
      let serialized;
      try {
        serialized = JSON.stringify(payload);
      } catch {
        throw new TypeError("automation_command_ticket_invalid");
      }
      if (
        typeof serialized !== "string" ||
        Buffer.byteLength(serialized) > 4096
      )
        throw new RangeError("automation_command_ticket_too_large");
      const body = Buffer.from(serialized).toString("base64url");
      const signature = createHmac("sha256", commandAdmissionKey)
        .update(body)
        .digest("base64url");
      return `${body}.${signature}`;
    },
    verifyCommandAdmissionTicket(ticket) {
      if (typeof ticket !== "string" || ticket.length > 8192) return null;
      const separator = ticket.indexOf(".");
      if (separator < 1 || ticket.indexOf(".", separator + 1) !== -1)
        return null;
      const body = ticket.slice(0, separator);
      const signatureText = ticket.slice(separator + 1);
      if (
        !/^[A-Za-z0-9_-]+$/u.test(body) ||
        !/^[A-Za-z0-9_-]{43}$/u.test(signatureText)
      )
        return null;
      let signature;
      try {
        signature = Buffer.from(signatureText, "base64url");
      } catch {
        return null;
      }
      const expected = createHmac("sha256", commandAdmissionKey)
        .update(body)
        .digest();
      if (
        signature.length !== expected.length ||
        signature.toString("base64url") !== signatureText ||
        !timingSafeEqual(signature, expected)
      )
        return null;
      try {
        const bytes = Buffer.from(body, "base64url");
        if (bytes.toString("base64url") !== body) return null;
        const payload = JSON.parse(bytes.toString("utf8"));
        return payload && typeof payload === "object" && !Array.isArray(payload)
          ? payload
          : null;
      } catch {
        return null;
      }
    },
    commandAdmissionOwnerRef(ownerId) {
      if (typeof ownerId !== "string" || !/^[1-9]\d{0,15}$/u.test(ownerId))
        throw new TypeError("automation_command_owner_invalid");
      return createHmac("sha256", commandAdmissionKey)
        .update("owner\0")
        .update(ownerId)
        .digest("base64url");
    },
    commandAdmissionPlayerRef(playerId) {
      const normalized = normalizePlayerId(playerId);
      return createHmac("sha256", commandAdmissionKey)
        .update("player\0")
        .update(normalized)
        .digest("base64url");
    },
    isRestoreGuardActive() {
      return readRestoreGuard() !== null;
    },
    readRestoreGuardEpoch() {
      return readRestoreGuard()?.activatedAt ?? null;
    },
    isRestoreRequired(playerId) {
      const guard = readRestoreGuard();
      if (!guard) return false;
      const normalizedPlayerId = normalizePlayerId(playerId);
      return (
        !isRestoreAccountReauthorized(normalizedPlayerId) ||
        readRestoreAuthorization(
          normalizedPlayerId,
          opaqueBoundPlayerId(key, normalizedPlayerId),
        )?.reviewConfirmed !== true ||
        !routeSelect.get(opaqueId(key, normalizedPlayerId)) ||
        hasUnresolvedMutation(normalizedPlayerId)
      );
    },
    isRestoreAccountReauthorized(playerId) {
      const normalizedPlayerId = normalizePlayerId(playerId);
      return isRestoreAccountReauthorized(normalizedPlayerId);
    },
    readRestoreOwnerStatus(ownerId) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      if (!readRestoreGuard()) return { status: "not_required" };
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      const row = ownerBindingByOwner.get(ownerKey);
      const pendingStatus = () => {
        const journal = readGameAuthBootstrapRow(normalizedOwnerId, ownerKey);
        if (journal?.state === "auth_outcome_unknown")
          return { status: "auth_outcome_unknown" };
        if (journal?.state === "failed")
          return {
            status:
              journal.reason === "unknown_acknowledged"
                ? "reauthorization_required"
                : "auth_failed",
          };
        if (journal?.state === "cancelled")
          return { status: "reauthorization_required" };
        if (journal?.state === "credential_stored")
          return { status: "auth_ready_to_resume" };
        if (journal?.state === "verification_pending")
          return { status: "auth_check_saved" };
        if (journal?.state === "prepared") return { status: "auth_prepared" };
        if (journal?.state === "exchange_pending")
          return { status: "auth_pending" };
        return { status: "reauthorization_required" };
      };
      if (!row) return pendingStatus();
      const binding = decrypt(key, ownerKey, row.record);
      if (
        !validOwnerGameAccount(binding, normalizedOwnerId) ||
        row.player_key !== opaqueBoundPlayerId(key, binding.playerId)
      )
        throw new Error("automation_owner_binding_corrupt");
      if (!isRestoreAccountReauthorized(binding.playerId))
        return pendingStatus();
      const authorization = readRestoreAuthorization(
        binding.playerId,
        row.player_key,
      );
      if (authorization?.reviewConfirmed !== true)
        return { status: "review_required" };
      if (
        !routeSelect.get(opaqueId(key, binding.playerId)) ||
        hasUnresolvedMutation(binding.playerId)
      )
        return { status: "reconciliation_required" };
      return { status: "ready" };
    },
    activateRestoreGuard({ activatedAt = Date.now() } = {}) {
      if (!Number.isSafeInteger(activatedAt) || activatedAt < 1)
        throw new TypeError("automation_restore_timestamp_invalid");
      if (readRestoreGuard()) return false;
      return transaction(() => {
        if (readRestoreGuard()) return false;
        restoreGuardInsert.run(
          encrypt(key, "restore-guard", {
            schemaVersion: 1,
            activatedAt,
          }),
        );
        restoreAccountDeleteAll.run();
        restoreConsentDeleteAll.run();
        restoreChallengeDeleteAll.run();
        db.exec(`
          DELETE FROM account_route_policies;
          DELETE FROM owner_game_accounts;
          DELETE FROM game_auth_recovery;
          DELETE FROM game_auth_bootstraps;
          DELETE FROM bridge_pairings;
          DELETE FROM bridge_devices;
          DELETE FROM bridge_challenges;
          DELETE FROM worker_lease;
        `);
        return true;
      });
    },
    armRestoreGuardForMarker({ createdAt } = {}) {
      if (!Number.isSafeInteger(createdAt) || createdAt < 1)
        throw new TypeError("automation_restore_timestamp_invalid");
      const current = readRestoreGuard();
      if (current?.activatedAt === createdAt) return false;
      return resetRestoreGuard(createdAt);
    },
    prepareRestoredSnapshot({ activatedAt = Date.now() } = {}) {
      if (!Number.isSafeInteger(activatedAt) || activatedAt < 1)
        throw new TypeError("automation_restore_timestamp_invalid");
      return resetRestoreGuard(activatedAt);
    },
    issueRestoreOwnerChallenge({ ownerId, issuedAt, identityIssuedAt } = {}) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      if (
        !Number.isSafeInteger(issuedAt) ||
        issuedAt < 1 ||
        !Number.isSafeInteger(identityIssuedAt) ||
        identityIssuedAt < 1 ||
        identityIssuedAt > issuedAt ||
        !Number.isSafeInteger(issuedAt + 120000)
      )
        throw new TypeError("automation_restore_challenge_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      return transaction(() => {
        const guard = readRestoreGuard();
        if (
          !guard ||
          issuedAt < guard.activatedAt ||
          identityIssuedAt < Math.floor(guard.activatedAt / 1000) * 1000
        )
          throw new Error("automation_restore_challenge_stale");
        const challenge = randomBytes(32).toString("base64url");
        const expiresAt = issuedAt + 120000;
        restoreChallengeUpsert.run(
          ownerKey,
          encrypt(key, `restore-owner-challenge:${ownerKey}`, {
            schemaVersion: 1,
            ownerId: normalizedOwnerId,
            challenge,
            issuedAt,
            expiresAt,
            restoreActivatedAt: guard.activatedAt,
          }),
        );
        return { challenge, expiresAt };
      });
    },
    recordRestoreOwnerConsent({
      ownerId,
      requestId,
      routePolicy,
      confirmedAt,
      identityIssuedAt,
      challenge,
    } = {}) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      if (
        typeof requestId !== "string" ||
        !uuidPattern.test(requestId) ||
        routePolicy !== "direct" ||
        !Number.isSafeInteger(confirmedAt) ||
        confirmedAt < 1 ||
        !Number.isSafeInteger(identityIssuedAt) ||
        identityIssuedAt < 1 ||
        identityIssuedAt > confirmedAt ||
        typeof challenge !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(challenge)
      )
        throw new TypeError("automation_restore_consent_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      return transaction(() => {
        const guard = readRestoreGuard();
        if (
          !guard ||
          confirmedAt < guard.activatedAt ||
          identityIssuedAt < Math.floor(guard.activatedAt / 1000) * 1000
        )
          throw new Error("automation_restore_consent_stale");
        const challengeRow = restoreChallengeSelect.get(ownerKey);
        if (!challengeRow)
          throw new Error("automation_restore_challenge_missing");
        const saved = decrypt(
          key,
          `restore-owner-challenge:${ownerKey}`,
          challengeRow.record,
        );
        const suppliedBytes = Buffer.from(challenge, "base64url");
        const expectedBytes =
          typeof saved?.challenge === "string"
            ? Buffer.from(saved.challenge, "base64url")
            : Buffer.alloc(0);
        if (
          saved?.schemaVersion !== 1 ||
          saved.ownerId !== normalizedOwnerId ||
          saved.restoreActivatedAt !== guard.activatedAt ||
          !Number.isSafeInteger(saved.issuedAt) ||
          !Number.isSafeInteger(saved.expiresAt) ||
          confirmedAt < saved.issuedAt ||
          confirmedAt >= saved.expiresAt ||
          suppliedBytes.length !== 32 ||
          expectedBytes.length !== 32 ||
          suppliedBytes.toString("base64url") !== challenge ||
          !timingSafeEqual(suppliedBytes, expectedBytes)
        )
          throw new Error("automation_restore_challenge_invalid");
        const record = {
          schemaVersion: 1,
          ownerId: normalizedOwnerId,
          requestId,
          routePolicy,
          confirmedAt,
          identityIssuedAt,
          restoreActivatedAt: guard.activatedAt,
        };
        restoreConsentUpsert.run(
          ownerKey,
          encrypt(key, `restore-owner-consent:${ownerKey}`, record),
        );
        restoreChallengeDelete.run(ownerKey);
        return record;
      });
    },
    readRestoreOwnerConsent(ownerId) {
      return readRestoreOwnerConsentRecord(normalizeOwnerId(ownerId));
    },
    authorizeRestoredAccountReads({
      ownerId,
      playerId,
      operationId,
      accessToken,
      verifiedAt,
    } = {}) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      const normalizedPlayerId = normalizePlayerId(playerId);
      if (
        typeof operationId !== "string" ||
        !uuidPattern.test(operationId) ||
        typeof accessToken !== "string" ||
        !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(
          accessToken,
        ) ||
        accessToken.length > 16384 ||
        !Number.isSafeInteger(verifiedAt) ||
        verifiedAt < 1
      )
        throw new TypeError("automation_restore_account_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      const playerKey = opaqueBoundPlayerId(key, normalizedPlayerId);
      const actorKey = opaqueId(key, normalizedPlayerId);
      return transaction(() => {
        const consent = readRestoreOwnerConsentRecord(normalizedOwnerId);
        const journal = readGameAuthBootstrapRow(normalizedOwnerId, ownerKey);
        const bindingRow = ownerBindingByOwner.get(ownerKey);
        const routeRow = routeSelect.get(actorKey);
        const actorRow = select.get(actorKey);
        if (
          !consent ||
          !journal ||
          journal.state !== "credential_stored" ||
          journal.operationId !== operationId ||
          journal.requestId !== consent.requestId ||
          journal.playerId !== normalizedPlayerId ||
          journal.routeEpoch !== 1 ||
          !bindingRow ||
          bindingRow.player_key !== playerKey ||
          !routeRow ||
          !actorRow ||
          verifiedAt < consent.confirmedAt
        )
          throw new Error("automation_restore_account_stale");
        const binding = decrypt(key, ownerKey, bindingRow.record);
        const route = decrypt(key, actorKey, routeRow.record);
        const actor = decrypt(key, actorKey, actorRow.record);
        if (
          !validOwnerGameAccount(binding, normalizedOwnerId) ||
          binding.playerId !== normalizedPlayerId ||
          !validRouteRecord(route, normalizedPlayerId) ||
          route.policy !== "direct" ||
          route.routeEpoch !== journal.routeEpoch ||
          actor?.playerId !== normalizedPlayerId ||
          actor?.value?.credential !== `Bearer ${accessToken}` ||
          actor.value.auto?.enabled !== false
        )
          throw new Error("automation_restore_account_stale");
        restoreAccountUpsert.run(
          playerKey,
          encrypt(key, `restore-account:${playerKey}`, {
            schemaVersion: 1,
            ownerId: normalizedOwnerId,
            playerId: normalizedPlayerId,
            verifiedAt,
            reviewConfirmed: false,
          }),
        );
        writeGameAuthBootstrapRecord({
          ...journal,
          state: "ready",
          updatedAt: Math.max(journal.updatedAt, verifiedAt),
        });
        return true;
      });
    },
    acknowledgeUnknownRestore({
      ownerId,
      operationId,
      challenge,
      confirmedAt,
      identityIssuedAt,
    } = {}) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      if (
        typeof operationId !== "string" ||
        !uuidPattern.test(operationId) ||
        typeof challenge !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(challenge) ||
        !Number.isSafeInteger(confirmedAt) ||
        !Number.isSafeInteger(identityIssuedAt) ||
        identityIssuedAt < 1 ||
        identityIssuedAt > confirmedAt
      )
        throw new TypeError("automation_restore_ack_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      return transaction(() => {
        const guard = readRestoreGuard();
        const consent = readRestoreOwnerConsentRecord(normalizedOwnerId);
        const journal = readGameAuthBootstrapRow(normalizedOwnerId, ownerKey);
        const row = restoreChallengeSelect.get(ownerKey);
        if (
          !guard ||
          !consent ||
          !journal ||
          !["auth_outcome_unknown", "exchange_pending"].includes(
            journal.state,
          ) ||
          journal.requestId !== consent.requestId ||
          journal.operationId !== operationId ||
          journal.routeEpoch !== 1 ||
          !row ||
          identityIssuedAt < Math.floor(guard.activatedAt / 1000) * 1000
        )
          throw new Error("automation_restore_ack_stale");
        const saved = decrypt(
          key,
          `restore-owner-challenge:${ownerKey}`,
          row.record,
        );
        const supplied = Buffer.from(challenge, "base64url");
        const expected =
          typeof saved?.challenge === "string"
            ? Buffer.from(saved.challenge, "base64url")
            : Buffer.alloc(0);
        if (
          saved?.schemaVersion !== 1 ||
          saved.ownerId !== normalizedOwnerId ||
          saved.restoreActivatedAt !== guard.activatedAt ||
          !Number.isSafeInteger(saved.issuedAt) ||
          !Number.isSafeInteger(saved.expiresAt) ||
          confirmedAt < saved.issuedAt ||
          confirmedAt >= saved.expiresAt ||
          supplied.length !== 32 ||
          supplied.toString("base64url") !== challenge ||
          expected.length !== 32 ||
          !timingSafeEqual(supplied, expected)
        )
          throw new Error("automation_restore_ack_stale");
        writeGameAuthBootstrapRecord({
          ...journal,
          state: "failed",
          reason: "unknown_acknowledged",
          updatedAt: Math.max(journal.updatedAt, confirmedAt),
        });
        restoreChallengeDelete.run(ownerKey);
        return { status: "reauthorization_required" };
      });
    },
    confirmRestoredReview({
      ownerId,
      playerId,
      operationId,
      authorization,
      challenge,
      confirmedAt,
      identityIssuedAt,
    } = {}) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      const normalizedPlayerId = normalizePlayerId(playerId);
      if (
        typeof operationId !== "string" ||
        !uuidPattern.test(operationId) ||
        typeof authorization !== "string" ||
        !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(
          authorization,
        ) ||
        authorization.length > 16391 ||
        typeof challenge !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(challenge) ||
        !Number.isSafeInteger(confirmedAt) ||
        !Number.isSafeInteger(identityIssuedAt) ||
        identityIssuedAt < 1 ||
        identityIssuedAt > confirmedAt
      )
        throw new TypeError("automation_restore_review_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      const playerKey = opaqueBoundPlayerId(key, normalizedPlayerId);
      const actorKey = opaqueId(key, normalizedPlayerId);
      return transaction(() => {
        const guard = readRestoreGuard();
        const consent = readRestoreOwnerConsentRecord(normalizedOwnerId);
        const journal = readGameAuthBootstrapRow(normalizedOwnerId, ownerKey);
        const account = readRestoreAuthorization(normalizedPlayerId, playerKey);
        const bindingRow = ownerBindingByOwner.get(ownerKey);
        const routeRow = routeSelect.get(actorKey);
        const actorRow = select.get(actorKey);
        const challengeRow = restoreChallengeSelect.get(ownerKey);
        if (
          !guard ||
          !consent ||
          !journal ||
          journal.state !== "ready" ||
          journal.requestId !== consent.requestId ||
          journal.operationId !== operationId ||
          journal.playerId !== normalizedPlayerId ||
          account?.ownerId !== normalizedOwnerId ||
          account.reviewConfirmed !== false ||
          !bindingRow ||
          bindingRow.player_key !== playerKey ||
          !routeRow ||
          !actorRow ||
          !challengeRow ||
          identityIssuedAt < Math.floor(guard.activatedAt / 1000) * 1000
        )
          throw new Error("automation_restore_review_stale");
        const binding = decrypt(key, ownerKey, bindingRow.record);
        const route = decrypt(key, actorKey, routeRow.record);
        const actor = decrypt(key, actorKey, actorRow.record);
        const saved = decrypt(
          key,
          `restore-owner-challenge:${ownerKey}`,
          challengeRow.record,
        );
        const supplied = Buffer.from(challenge, "base64url");
        const expected =
          typeof saved?.challenge === "string"
            ? Buffer.from(saved.challenge, "base64url")
            : Buffer.alloc(0);
        if (
          !validOwnerGameAccount(binding, normalizedOwnerId) ||
          binding.playerId !== normalizedPlayerId ||
          !validRouteRecord(route, normalizedPlayerId) ||
          route.policy !== "direct" ||
          route.routeEpoch !== journal.routeEpoch ||
          actor?.playerId !== normalizedPlayerId ||
          actor.value?.credential !== authorization ||
          actor.value.auto?.enabled !== false ||
          saved?.schemaVersion !== 1 ||
          saved.ownerId !== normalizedOwnerId ||
          saved.restoreActivatedAt !== guard.activatedAt ||
          !Number.isSafeInteger(saved.issuedAt) ||
          !Number.isSafeInteger(saved.expiresAt) ||
          confirmedAt < saved.issuedAt ||
          confirmedAt >= saved.expiresAt ||
          supplied.length !== 32 ||
          supplied.toString("base64url") !== challenge ||
          expected.length !== 32 ||
          !timingSafeEqual(supplied, expected)
        )
          throw new Error("automation_restore_review_stale");
        restoreAccountUpsert.run(
          playerKey,
          encrypt(key, `restore-account:${playerKey}`, {
            ...account,
            reviewConfirmed: true,
          }),
        );
        restoreChallengeDelete.run(ownerKey);
        return {
          status: hasUnresolvedMutation(normalizedPlayerId)
            ? "reconciliation_required"
            : "ready",
        };
      });
    },
    confirmRestoredAccount({ ownerId, playerId, verifiedAt } = {}) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      const normalizedPlayerId = normalizePlayerId(playerId);
      if (!Number.isSafeInteger(verifiedAt) || verifiedAt < 1)
        throw new TypeError("automation_restore_timestamp_invalid");
      const playerKey = opaqueBoundPlayerId(key, normalizedPlayerId);
      return transaction(() => {
        if (!readRestoreGuard()) return false;
        const bindingRow = ownerBindingByPlayer.get(playerKey);
        if (!bindingRow) throw new Error("automation_owner_binding_required");
        const binding = decrypt(key, bindingRow.owner_key, bindingRow.record);
        if (
          !validOwnerGameAccount(binding, normalizedOwnerId) ||
          binding.playerId !== normalizedPlayerId ||
          bindingRow.owner_key !== opaqueOwnerId(key, normalizedOwnerId)
        )
          throw new Error("automation_owner_binding_mismatch");
        restoreAccountUpsert.run(
          playerKey,
          encrypt(key, `restore-account:${playerKey}`, {
            schemaVersion: 1,
            ownerId: normalizedOwnerId,
            playerId: normalizedPlayerId,
            verifiedAt,
            reviewConfirmed: true,
          }),
        );
        return true;
      });
    },
    readGameAccountBinding(ownerId) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      const row = ownerBindingByOwner.get(ownerKey);
      if (!row) return null;
      const record = decrypt(key, ownerKey, row.record);
      if (
        !validOwnerGameAccount(record, normalizedOwnerId) ||
        row.player_key !== opaqueBoundPlayerId(key, record.playerId)
      )
        throw new Error("automation_owner_binding_corrupt");
      return record;
    },
    readGameAccountOwner(playerId) {
      const normalizedPlayerId = normalizePlayerId(playerId);
      const playerKey = opaqueBoundPlayerId(key, normalizedPlayerId);
      const row = ownerBindingByPlayer.get(playerKey);
      if (!row) return null;
      const record = decrypt(key, row.owner_key, row.record);
      if (
        !validOwnerGameAccount(record, record?.ownerId) ||
        record.playerId !== normalizedPlayerId ||
        row.owner_key !== opaqueOwnerId(key, record.ownerId)
      )
        throw new Error("automation_owner_binding_corrupt");
      return record;
    },
    isGameHelperPaused(playerId) {
      const binding = this.readGameAccountOwner(playerId);
      if (!binding) return false;
      return this.withBridgeTransaction(
        (bridge) => bridge.readHelperControl(binding.ownerId).paused,
      );
    },
    readGameAuthRecovery: readGameAuthRecoveryByOwner,
    listGameAuthRecoveries() {
      const rows = gameAuthRecoveryAll.all();
      if (rows.length > MAX_GAME_AUTH_RECOVERY_RECORDS)
        throw new Error("automation_game_auth_recovery_capacity_exceeded");
      return rows.map(({ owner_key: ownerKey, record }) => {
        const decoded = decrypt(key, `game-auth-recovery:${ownerKey}`, record);
        if (!validGameAuthRecovery(decoded, decoded?.ownerId))
          throw new Error("automation_game_auth_recovery_corrupt");
        if (opaqueOwnerId(key, decoded.ownerId) !== ownerKey)
          throw new Error("automation_game_auth_recovery_corrupt");
        return decoded;
      });
    },
    readGameAuthBootstrap(ownerId) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      return readGameAuthBootstrapRow(
        normalizedOwnerId,
        opaqueOwnerId(key, normalizedOwnerId),
      );
    },
    listGameAuthBootstraps() {
      const rows = gameAuthBootstrapAll.all();
      if (rows.length > MAX_GAME_AUTH_BOOTSTRAP_RECORDS)
        throw new Error("automation_game_auth_bootstrap_capacity_exceeded");
      return rows.map(({ owner_key: ownerKey, record }) => {
        const decoded = decrypt(key, `game-auth-bootstrap:${ownerKey}`, record);
        if (
          !validGameAuthBootstrap(decoded, decoded?.ownerId) ||
          opaqueOwnerId(key, decoded.ownerId) !== ownerKey
        )
          throw new Error("automation_game_auth_bootstrap_corrupt");
        return decoded;
      });
    },
    startRestoreGameAuthBootstrap(record) {
      const normalizedOwnerId = normalizeOwnerId(record?.ownerId);
      if (
        !validGameAuthBootstrap(record, normalizedOwnerId) ||
        record.state !== "prepared" ||
        record.playerId !== null ||
        record.credentialVersion !== null ||
        record.routeEpoch !== 1
      )
        throw new TypeError("automation_game_auth_bootstrap_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      return transaction(() => {
        const consent = readRestoreOwnerConsentRecord(normalizedOwnerId);
        if (
          !consent ||
          consent.requestId !== record.requestId ||
          record.createdAt < consent.confirmedAt
        )
          throw new Error("automation_restore_consent_required");
        const current = readGameAuthBootstrapRow(normalizedOwnerId, ownerKey);
        if (current) {
          const fields = [
            "requestId",
            "operationId",
            "authGeneration",
            "consentGeneration",
            "routeEpoch",
            "launchDataDigest",
            "expectedCredentialVersion",
            "createdAt",
          ];
          if (fields.every((field) => current[field] === record[field]))
            return current;
          if (
            !(
              current.state === "cancelled" ||
              (current.state === "failed" &&
                current.reason === "unknown_acknowledged")
            ) ||
            current.requestId === record.requestId ||
            current.operationId === record.operationId ||
            current.launchDataDigest === record.launchDataDigest ||
            record.expectedCredentialVersion !==
              current.expectedCredentialVersion ||
            record.authGeneration <= current.authGeneration ||
            record.consentGeneration <= current.consentGeneration
          )
            throw new Error("automation_game_auth_bootstrap_pending");
        }
        if (
          ownerBindingByOwner.get(ownerKey) ||
          readGameAuthRecoveryByOwner(normalizedOwnerId)
        )
          throw new Error("automation_game_auth_bootstrap_pending");
        if (
          gameAuthBootstrapCount.get().count >= MAX_GAME_AUTH_BOOTSTRAP_RECORDS
        )
          throw new Error("automation_game_auth_bootstrap_capacity_exceeded");
        return writeGameAuthBootstrapRecord(record);
      });
    },
    startGameAuthBootstrap(record, { expectedCurrent } = {}) {
      const normalizedOwnerId = normalizeOwnerId(record?.ownerId);
      if (
        !validGameAuthBootstrap(record, normalizedOwnerId) ||
        record.state !== "prepared"
      )
        throw new TypeError("automation_game_auth_bootstrap_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      return transaction(() => {
        const current = readGameAuthBootstrapRow(normalizedOwnerId, ownerKey);
        const recovery = readGameAuthRecoveryByOwner(normalizedOwnerId);
        const rebootstrapAfterLogout = Boolean(
          current?.state === "ready" &&
          recovery?.state === "logged_out" &&
          recovery.credentialVersion === record.expectedCredentialVersion &&
          record.authGeneration > recovery.authGeneration &&
          record.consentGeneration > recovery.consentGeneration &&
          record.expectedCredentialVersion > current.credentialVersion &&
          recovery.playerId === record.playerId,
        );
        const explicitUnknownRetry = Boolean(
          current?.state === "auth_outcome_unknown" &&
          current.playerId === null &&
          current.credentialVersion === null &&
          !recovery &&
          record.playerId === null &&
          record.expectedCredentialVersion ===
            current.expectedCredentialVersion &&
          record.authGeneration === current.authGeneration + 1 &&
          record.consentGeneration > current.consentGeneration,
        );
        if (record.playerId !== null && !rebootstrapAfterLogout)
          throw new Error("automation_game_auth_bootstrap_invalid");
        if (current?.requestId === record.requestId) {
          if (current.launchDataDigest !== record.launchDataDigest)
            throw new Error("automation_game_auth_bootstrap_conflict");
          return current;
        }
        if (current?.operationId === record.operationId)
          throw new Error("automation_game_auth_bootstrap_conflict");
        if (expectedCurrent !== undefined) {
          const expectedFields = [
            "operationId",
            "authGeneration",
            "consentGeneration",
            "launchDataDigest",
            "state",
            "updatedAt",
          ];
          const matches =
            expectedCurrent === null
              ? current === null
              : Boolean(
                  current &&
                  expectedFields.every(
                    (field) => current[field] === expectedCurrent[field],
                  ),
                );
          if (!matches)
            throw new Error("automation_game_auth_bootstrap_changed");
        }
        if (
          (current &&
            [
              "prepared",
              "exchange_pending",
              "verification_pending",
              "credential_stored",
            ].includes(current.state)) ||
          (current?.state === "auth_outcome_unknown" && !explicitUnknownRetry)
        )
          throw new Error("automation_game_auth_bootstrap_pending");
        if (current?.state === "ready" && !rebootstrapAfterLogout)
          throw new Error("automation_game_auth_bootstrap_already_complete");
        if (current?.launchDataDigest === record.launchDataDigest)
          throw new Error("automation_game_auth_bootstrap_replay");
        const generationsValid = !current
          ? record.authGeneration === 1 && record.consentGeneration === 1
          : rebootstrapAfterLogout
            ? record.expectedCredentialVersion === recovery.credentialVersion
            : record.authGeneration === current.authGeneration + 1 &&
              record.consentGeneration > current.consentGeneration &&
              record.expectedCredentialVersion ===
                (current.credentialVersion ??
                  current.expectedCredentialVersion);
        if (!generationsValid)
          throw new Error("automation_game_auth_generation_conflict");
        if (
          !current &&
          gameAuthBootstrapCount.get().count >= MAX_GAME_AUTH_BOOTSTRAP_RECORDS
        )
          throw new Error("automation_game_auth_bootstrap_capacity_exceeded");
        return writeGameAuthBootstrapRecord(record);
      });
    },
    updateGameAuthBootstrap(ownerId, operationId, record) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      if (
        !validGameAuthBootstrap(record, normalizedOwnerId) ||
        record.operationId !== operationId
      )
        throw new TypeError("automation_game_auth_bootstrap_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      return transaction(() => {
        const current = readGameAuthBootstrapRow(normalizedOwnerId, ownerKey);
        if (!current || current.operationId !== operationId)
          throw new Error("automation_game_auth_bootstrap_stale");
        const immutableFields = [
          "requestId",
          "authGeneration",
          "consentGeneration",
          "routeEpoch",
          "launchDataDigest",
          "expectedCredentialVersion",
          "createdAt",
        ];
        const playerChanged = current.playerId !== record.playerId;
        const credentialChanged =
          current.credentialVersion !== record.credentialVersion;
        const restoreUnknownReconciliation =
          current.state === "auth_outcome_unknown" &&
          record.state === "credential_stored" &&
          current.routeEpoch === 1 &&
          readRestoreOwnerConsentRecord(normalizedOwnerId)?.requestId ===
            current.requestId;
        if (
          immutableFields.some((field) => current[field] !== record[field]) ||
          !allowedGameAuthBootstrapTransitions[current.state]?.has(
            record.state,
          ) ||
          record.updatedAt < current.updatedAt ||
          (playerChanged &&
            (!(
              ["verification_pending"].includes(current.state) ||
              restoreUnknownReconciliation
            ) ||
              record.state !== "credential_stored" ||
              current.playerId !== null ||
              typeof record.playerId !== "string")) ||
          (credentialChanged &&
            (!(
              ["verification_pending"].includes(current.state) ||
              restoreUnknownReconciliation
            ) ||
              record.state !== "credential_stored" ||
              record.credentialVersion !==
                current.expectedCredentialVersion + 1)) ||
          (!credentialChanged &&
            (record.state === "credential_stored" ||
              record.state === "ready") &&
            record.credentialVersion !== current.credentialVersion)
        )
          throw new Error("automation_game_auth_bootstrap_transition_invalid");
        if (!record.reason) delete record.reason;
        return writeGameAuthBootstrapRecord(record);
      });
    },
    startGameAuthRecovery(
      record,
      { replaceUnknown = false, expectedCurrent } = {},
    ) {
      const normalizedOwnerId = normalizeOwnerId(record?.ownerId);
      if (
        !validGameAuthRecovery(record, normalizedOwnerId) ||
        record.state !== "created" ||
        typeof replaceUnknown !== "boolean"
      )
        throw new TypeError("automation_game_auth_recovery_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      return transaction(() => {
        const current = readGameAuthRecoveryRow(normalizedOwnerId, ownerKey);
        if (expectedCurrent !== undefined) {
          const expectedFields = [
            "operationId",
            "authGeneration",
            "consentGeneration",
            "routeEpoch",
            "state",
            "expectedCredentialVersion",
            "credentialVersion",
            "updatedAt",
          ];
          const matches =
            expectedCurrent === null
              ? current === null
              : Boolean(
                  current &&
                  expectedFields.every(
                    (field) => current[field] === expectedCurrent[field],
                  ),
                );
          if (!matches)
            throw new Error("automation_game_auth_recovery_changed");
        }
        const mayReplaceUnknown =
          replaceUnknown && current?.state === "auth_outcome_unknown";
        if (
          current &&
          activeGameAuthStates.has(current.state) &&
          !mayReplaceUnknown
        )
          throw new Error("automation_game_auth_operation_pending");
        if (
          !current &&
          gameAuthRecoveryCount.get().count >= MAX_GAME_AUTH_RECOVERY_RECORDS
        )
          throw new Error("automation_game_auth_recovery_capacity_exceeded");
        if (
          (current &&
            (record.authGeneration !== current.authGeneration + 1 ||
              record.playerId !== current.playerId ||
              record.consentGeneration <= current.consentGeneration ||
              record.expectedCredentialVersion !==
                (current.credentialVersion ??
                  current.expectedCredentialVersion))) ||
          (!current && record.authGeneration !== 1)
        )
          throw new Error("automation_game_auth_generation_conflict");
        if (mayReplaceUnknown)
          writeGameAuthRecoveryRecord({
            ...current,
            state: "failed",
            updatedAt: Math.max(record.updatedAt, current.updatedAt),
          });
        return writeGameAuthRecoveryRecord(record);
      });
    },
    beginGameAuthLogout(record) {
      const normalizedOwnerId = normalizeOwnerId(record?.ownerId);
      if (
        !validGameAuthRecovery(record, normalizedOwnerId) ||
        record.state !== "logout_pending"
      )
        throw new TypeError("automation_game_auth_recovery_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      return transaction(() => {
        const current = readGameAuthRecoveryRow(normalizedOwnerId, ownerKey);
        const bootstrap = readGameAuthBootstrapRow(normalizedOwnerId, ownerKey);
        const logoutAfterBootstrap = Boolean(
          !current &&
          bootstrap?.state === "ready" &&
          record.playerId === bootstrap.playerId &&
          record.authGeneration === bootstrap.authGeneration + 1 &&
          record.consentGeneration > bootstrap.consentGeneration &&
          record.routeEpoch >= Math.max(1, bootstrap.routeEpoch) &&
          record.expectedCredentialVersion === bootstrap.credentialVersion,
        );
        if (current?.state === "logout_pending") {
          if (current.operationId === record.operationId) return current;
          throw new Error("automation_game_auth_operation_pending");
        }
        if (
          (current &&
            (record.authGeneration !== current.authGeneration + 1 ||
              record.playerId !== current.playerId ||
              record.consentGeneration <= current.consentGeneration ||
              record.expectedCredentialVersion !==
                (current.credentialVersion ??
                  current.expectedCredentialVersion))) ||
          (!current && record.authGeneration !== 1 && !logoutAfterBootstrap)
        )
          throw new Error("automation_game_auth_generation_conflict");
        if (
          !current &&
          gameAuthRecoveryCount.get().count >= MAX_GAME_AUTH_RECOVERY_RECORDS
        )
          throw new Error("automation_game_auth_recovery_capacity_exceeded");
        return writeGameAuthRecoveryRecord(record);
      });
    },
    updateGameAuthRecovery(ownerId, operationId, record) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      if (
        !validGameAuthRecovery(record, normalizedOwnerId) ||
        record.operationId !== operationId
      )
        throw new TypeError("automation_game_auth_recovery_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      return transaction(() => {
        const current = readGameAuthRecoveryRow(normalizedOwnerId, ownerKey);
        if (!current || current.operationId !== operationId)
          throw new Error("automation_game_auth_operation_stale");
        const immutableFields = [
          "playerId",
          "authGeneration",
          "consentGeneration",
          "routeEpoch",
          "expectedCredentialVersion",
        ];
        if (
          immutableFields.some((field) => current[field] !== record[field]) ||
          !allowedGameAuthTransitions[current.state]?.has(record.state) ||
          record.updatedAt < current.updatedAt ||
          (record.state !== "credential_stored" &&
            record.state !== "ready" &&
            record.state !== "logged_out" &&
            record.credentialVersion !== current.credentialVersion)
        )
          throw new Error("automation_game_auth_transition_invalid");
        return writeGameAuthRecoveryRecord(record);
      });
    },
    // Caller must have matched a freshly verified Wiki identity to a fresh Cargo /api/me.
    // This storage primitive enforces permanence and uniqueness, not identity proof.
    stageRestoredGameAccount({
      ownerId,
      playerId,
      operationId,
      verifiedAt,
    } = {}) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      const normalizedPlayerId = normalizePlayerId(playerId);
      if (
        typeof operationId !== "string" ||
        !uuidPattern.test(operationId) ||
        !Number.isSafeInteger(verifiedAt) ||
        verifiedAt < 1
      )
        throw new TypeError("automation_restore_account_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      const playerKey = opaqueBoundPlayerId(key, normalizedPlayerId);
      const routeKey = opaqueId(key, normalizedPlayerId);
      return transaction(() => {
        const consent = readRestoreOwnerConsentRecord(normalizedOwnerId);
        const journal = readGameAuthBootstrapRow(normalizedOwnerId, ownerKey);
        if (
          !consent ||
          !journal ||
          consent.requestId !== journal.requestId ||
          journal.operationId !== operationId ||
          journal.state !== "credential_stored" ||
          journal.playerId !== normalizedPlayerId ||
          journal.routeEpoch !== 1 ||
          verifiedAt < consent.confirmedAt
        )
          throw new Error("automation_restore_account_stale");
        const ownerRow = ownerBindingByOwner.get(ownerKey);
        const playerRow = ownerBindingByPlayer.get(playerKey);
        const existingRoute = routeSelect.get(routeKey);
        if (ownerRow || playerRow || existingRoute) {
          if (
            !ownerRow ||
            !playerRow ||
            !existingRoute ||
            ownerRow.player_key !== playerKey ||
            playerRow.owner_key !== ownerKey
          )
            throw new Error("automation_restore_account_conflict");
          const binding = decrypt(key, ownerKey, ownerRow.record);
          const route = decrypt(key, routeKey, existingRoute.record);
          if (
            !validOwnerGameAccount(binding, normalizedOwnerId) ||
            binding.playerId !== normalizedPlayerId ||
            !validRouteRecord(route, normalizedPlayerId) ||
            route.policy !== "direct" ||
            route.routeEpoch !== journal.routeEpoch ||
            route.activeDeviceId !== null
          )
            throw new Error("automation_restore_account_conflict");
          return { binding, route };
        }
        const binding = {
          schemaVersion: 1,
          ownerId: normalizedOwnerId,
          playerId: normalizedPlayerId,
          verifiedAt,
        };
        const route = {
          schemaVersion: 1,
          playerId: normalizedPlayerId,
          policy: "direct",
          activeDeviceId: null,
          routeEpoch: journal.routeEpoch,
          updatedAt: verifiedAt,
        };
        ownerBindingInsert.run(
          ownerKey,
          playerKey,
          encrypt(key, ownerKey, binding),
        );
        routeUpsert.run(routeKey, encrypt(key, routeKey, route));
        return { binding, route };
      });
    },
    bindVerifiedGameAccount(ownerId, playerId, verifiedAt) {
      const normalizedOwnerId = normalizeOwnerId(ownerId);
      const normalizedPlayerId = normalizePlayerId(playerId);
      if (!Number.isSafeInteger(verifiedAt) || verifiedAt < 1)
        throw new TypeError("automation_owner_binding_invalid");
      const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
      const playerKey = opaqueBoundPlayerId(key, normalizedPlayerId);
      return transaction(() => {
        const ownerRow = ownerBindingByOwner.get(ownerKey);
        if (ownerRow) {
          const current = decrypt(key, ownerKey, ownerRow.record);
          if (
            !validOwnerGameAccount(current, normalizedOwnerId) ||
            ownerRow.player_key !== opaqueBoundPlayerId(key, current.playerId)
          )
            throw new Error("automation_owner_binding_corrupt");
          if (current.playerId !== normalizedPlayerId)
            throw new Error("automation_owner_binding_conflict");
          return current;
        }

        const playerRow = ownerBindingByPlayer.get(playerKey);
        if (playerRow) {
          const current = decrypt(key, playerRow.owner_key, playerRow.record);
          if (
            !validOwnerGameAccount(current, current?.ownerId) ||
            playerRow.owner_key !== opaqueOwnerId(key, current.ownerId) ||
            playerRow.player_key !== opaqueBoundPlayerId(key, current.playerId)
          )
            throw new Error("automation_owner_binding_corrupt");
          if (current.ownerId !== normalizedOwnerId)
            throw new Error("automation_game_account_already_bound");
          return current;
        }

        const record = {
          schemaVersion: 1,
          ownerId: normalizedOwnerId,
          playerId: normalizedPlayerId,
          verifiedAt,
        };
        ownerBindingInsert.run(
          ownerKey,
          playerKey,
          encrypt(key, ownerKey, record),
        );
        return record;
      });
    },
    withBridgeTransaction(run) {
      if (typeof run !== "function")
        throw new TypeError("automation_bridge_transaction_required");
      return transaction(() => {
        const readPairingRow = (row) => {
          if (!row) return null;
          const record = decrypt(
            key,
            `bridge-pairing:${row.pairing_id}`,
            row.record,
          );
          if (
            record?.pairingId !== row.pairing_id ||
            record?.deviceId !== row.device_id ||
            record?.createdAtMs !== row.created_at_ms ||
            typeof record?.idempotencyKey !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
              record.idempotencyKey,
            ) ||
            row.request_key !==
              opaqueBridgeRequestKey(key, record.idempotencyKey)
          )
            throw new Error("automation_bridge_pairing_corrupt");
          return record;
        };
        const readDeviceRow = (row) => {
          if (!row) return null;
          const record = decrypt(
            key,
            `bridge-device:${row.device_id}`,
            row.record,
          );
          let normalizedOwnerId;
          try {
            normalizedOwnerId = normalizeOwnerId(record?.ownerId);
          } catch {
            throw new Error("automation_bridge_device_corrupt");
          }
          if (
            record?.deviceId !== row.device_id ||
            row.owner_key !== opaqueOwnerId(key, normalizedOwnerId)
          )
            throw new Error("automation_bridge_device_corrupt");
          return record;
        };
        const readChallengeRow = (row) => {
          if (!row) return null;
          const record = decrypt(
            key,
            `bridge-challenge:${row.challenge_id}`,
            row.record,
          );
          if (
            record?.challengeId !== row.challenge_id ||
            record?.deviceId !== row.device_id ||
            record?.expiresAtMs !== row.expires_at_ms
          )
            throw new Error("automation_bridge_challenge_corrupt");
          return record;
        };
        const readHelperControlRow = (row, expectedOwnerId) => {
          if (!row)
            return {
              schemaVersion: 1,
              ownerId: expectedOwnerId,
              paused: false,
              generation: 0,
              updatedAtMs: null,
            };
          const record = decrypt(
            key,
            `bridge-helper-control:${row.owner_key}`,
            row.record,
          );
          if (
            record?.schemaVersion !== 1 ||
            record.ownerId !== expectedOwnerId ||
            row.owner_key !== opaqueOwnerId(key, expectedOwnerId) ||
            typeof record.paused !== "boolean" ||
            !Number.isSafeInteger(record.generation) ||
            record.generation < 1 ||
            !Number.isSafeInteger(record.updatedAtMs) ||
            record.updatedAtMs < 1
          )
            throw new Error("automation_bridge_helper_control_corrupt");
          return record;
        };
        const bridge = Object.freeze({
          prunePairingsBefore: (cutoffMs) => {
            if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 1)
              throw new TypeError("automation_bridge_cutoff_invalid");
            bridgePairingPrune.run(cutoffMs);
          },
          readPairing: (pairingId) =>
            readPairingRow(bridgePairingById.get(pairingId)),
          readPairingByIdempotencyKey: (idempotencyKey) =>
            readPairingRow(
              bridgePairingByRequestKey.get(
                opaqueBridgeRequestKey(key, idempotencyKey),
              ),
            ),
          listPairingsByDevice: (deviceId) =>
            bridgePairingsByDevice.all(deviceId).map(readPairingRow),
          insertPairing: (record) => {
            bridgePairingInsert.run(
              record.pairingId,
              opaqueBridgeRequestKey(key, record.idempotencyKey),
              record.deviceId,
              record.createdAtMs,
              encrypt(key, `bridge-pairing:${record.pairingId}`, record),
            );
          },
          updatePairing: (record) => {
            const row = bridgePairingById.get(record.pairingId);
            const current = readPairingRow(row);
            if (
              !current ||
              current.deviceId !== record.deviceId ||
              current.idempotencyKey !== record.idempotencyKey
            )
              throw new Error("automation_bridge_pairing_missing");
            const result = bridgePairingUpdate.run(
              encrypt(key, `bridge-pairing:${record.pairingId}`, record),
              record.pairingId,
              record.deviceId,
            );
            if (result.changes !== 1)
              throw new Error("automation_bridge_pairing_missing");
          },
          readDevice: (deviceId) =>
            readDeviceRow(bridgeDeviceById.get(deviceId)),
          listDevicesByOwner: (ownerId) => {
            const ownerKey = opaqueOwnerId(key, normalizeOwnerId(ownerId));
            return bridgeDevicesByOwner.all(ownerKey).map(readDeviceRow);
          },
          insertDevice: (record) => {
            bridgeDeviceInsert.run(
              record.deviceId,
              opaqueOwnerId(key, normalizeOwnerId(record.ownerId)),
              encrypt(key, `bridge-device:${record.deviceId}`, record),
            );
          },
          updateDevice: (record) => {
            const result = bridgeDeviceUpdate.run(
              encrypt(key, `bridge-device:${record.deviceId}`, record),
              record.deviceId,
              opaqueOwnerId(key, normalizeOwnerId(record.ownerId)),
            );
            if (result.changes !== 1)
              throw new Error("automation_bridge_device_missing");
          },
          pruneChallengesBefore: (cutoffMs) => {
            if (!Number.isSafeInteger(cutoffMs) || cutoffMs < 1)
              throw new TypeError("automation_bridge_cutoff_invalid");
            bridgeChallengePrune.run(cutoffMs);
          },
          readChallenge: (challengeId) =>
            readChallengeRow(bridgeChallengeById.get(challengeId)),
          listChallengesByDevice: (deviceId) =>
            bridgeChallengesByDevice.all(deviceId).map(readChallengeRow),
          insertChallenge: (record) => {
            bridgeChallengeInsert.run(
              record.challengeId,
              record.deviceId,
              record.expiresAtMs,
              encrypt(key, `bridge-challenge:${record.challengeId}`, record),
            );
          },
          updateChallenge: (record) => {
            const result = bridgeChallengeUpdate.run(
              encrypt(key, `bridge-challenge:${record.challengeId}`, record),
              record.challengeId,
              record.deviceId,
              record.expiresAtMs,
            );
            if (result.changes !== 1)
              throw new Error("automation_bridge_challenge_missing");
          },
          readHelperControl: (rawOwnerId) => {
            const normalizedOwnerId = normalizeOwnerId(rawOwnerId);
            const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
            return readHelperControlRow(
              bridgeHelperControlByOwner.get(ownerKey),
              normalizedOwnerId,
            );
          },
          setHelperPaused: (rawOwnerId, paused, updatedAtMs) => {
            const normalizedOwnerId = normalizeOwnerId(rawOwnerId);
            if (
              typeof paused !== "boolean" ||
              !Number.isSafeInteger(updatedAtMs) ||
              updatedAtMs < 1
            )
              throw new TypeError("automation_bridge_helper_control_invalid");
            const ownerKey = opaqueOwnerId(key, normalizedOwnerId);
            const current = readHelperControlRow(
              bridgeHelperControlByOwner.get(ownerKey),
              normalizedOwnerId,
            );
            if (current.paused === paused) return current;
            const next = {
              schemaVersion: 1,
              ownerId: normalizedOwnerId,
              paused,
              generation: current.generation + 1,
              updatedAtMs,
            };
            if (!Number.isSafeInteger(next.generation))
              throw new Error("automation_bridge_helper_generation_exhausted");
            bridgeHelperControlUpsert.run(
              ownerKey,
              encrypt(key, `bridge-helper-control:${ownerKey}`, next),
            );
            return next;
          },
        });
        const result = run(bridge);
        if (result && typeof result.then === "function")
          throw new TypeError("automation_bridge_transaction_must_be_sync");
        return result;
      });
    },
    readSnapshots() {
      return snapshotAll
        .all()
        .map((row) => decrypt(key, row.account_key, row.record));
    },
    readSnapshot(playerId) {
      const id = opaqueId(key, normalizePlayerId(playerId));
      const row = snapshotSelect.get(id);
      return row ? decrypt(key, id, row.record) : null;
    },
    writeSnapshot(playerId, value) {
      const normalized = normalizePlayerId(playerId);
      const id = opaqueId(key, normalized);
      const encrypted = encrypt(key, id, { ...value, playerId: normalized });
      transaction(() => snapshotUpsert.run(id, encrypted));
    },
    hasExplicitRoutePolicy(playerId) {
      const normalized = normalizePlayerId(playerId);
      return Boolean(routeSelect.get(opaqueId(key, normalized)));
    },
    readRoutePolicy(playerId) {
      const normalized = normalizePlayerId(playerId);
      const id = opaqueId(key, normalized);
      const row = routeSelect.get(id);
      if (!row)
        return {
          schemaVersion: 1,
          playerId: normalized,
          policy: "direct",
          activeDeviceId: null,
          routeEpoch: 0,
          updatedAt: null,
        };
      const record = decrypt(key, id, row.record);
      if (!record || !validRouteRecord(record, normalized))
        throw new Error("automation_route_policy_corrupt");
      return record;
    },
    selectRoutePolicy(playerId, selection) {
      const normalized = normalizePlayerId(playerId);
      if (
        !selection ||
        typeof selection !== "object" ||
        !["direct", "bridge_required"].includes(selection.policy) ||
        !Number.isSafeInteger(selection.expectedRouteEpoch) ||
        selection.expectedRouteEpoch < 0 ||
        !Number.isSafeInteger(selection.updatedAt) ||
        selection.updatedAt < 1
      )
        throw new TypeError("automation_route_selection_invalid");
      if (
        (selection.policy === "direct" && selection.activeDeviceId !== null) ||
        (selection.policy === "bridge_required" &&
          (typeof selection.activeDeviceId !== "string" ||
            !deviceIdPattern.test(selection.activeDeviceId)))
      )
        throw new TypeError("automation_route_selection_invalid");
      const id = opaqueId(key, normalized);
      return transaction(() => {
        const row = routeSelect.get(id);
        const current = row
          ? decrypt(key, id, row.record)
          : {
              schemaVersion: 1,
              playerId: normalized,
              policy: "direct",
              activeDeviceId: null,
              routeEpoch: 0,
              updatedAt: null,
            };
        if (!validRouteRecord(current, normalized, true))
          throw new Error("automation_route_policy_corrupt");
        if (current.routeEpoch !== selection.expectedRouteEpoch)
          throw new Error("automation_route_epoch_conflict");
        if (
          current.policy === selection.policy &&
          current.activeDeviceId === selection.activeDeviceId &&
          (row || !readRestoreGuard())
        )
          return current;
        const next = {
          schemaVersion: 1,
          playerId: normalized,
          policy: selection.policy,
          activeDeviceId: selection.activeDeviceId,
          routeEpoch: current.routeEpoch + 1,
          updatedAt: selection.updatedAt,
        };
        if (!Number.isSafeInteger(next.routeEpoch))
          throw new Error("automation_route_epoch_exhausted");
        routeUpsert.run(id, encrypt(key, id, next));
        return next;
      });
    },
    read(playerId) {
      const normalized = normalizePlayerId(playerId);
      const id = opaqueId(key, normalized);
      const row = select.get(id);
      if (!row) return null;
      const record = decrypt(key, id, row.record);
      if (
        !record ||
        record.playerId !== normalized ||
        !Object.hasOwn(record, "value")
      )
        throw new Error("automation_state_corrupt");
      return record.value;
    },
    write(playerId, value) {
      const normalized = normalizePlayerId(playerId);
      let record;
      try {
        record = JSON.stringify({ playerId: normalized, value });
      } catch {
        throw new TypeError("automation_record_invalid");
      }
      if (Buffer.byteLength(record) > MAX_RECORD_BYTES)
        throw new RangeError("automation_record_too_large");
      const id = opaqueId(key, normalized);
      const encrypted = encrypt(key, id, {
        playerId: normalized,
        value: JSON.parse(record).value,
      });
      transaction(() => upsert.run(id, encrypted));
      for (const suffix of ["-wal", "-shm"])
        if (existsSync(databasePath + suffix))
          chmodSync(databasePath + suffix, 0o600);
    },
    writeIfVersion(playerId, expectedVersion, value, restoreCheck = null) {
      const normalized = normalizePlayerId(playerId);
      if (
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 ||
        expectedVersion >= Number.MAX_SAFE_INTEGER ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        value.version !== expectedVersion + 1
      )
        throw new TypeError("automation_state_version_invalid");
      let serialized;
      try {
        serialized = JSON.stringify({ playerId: normalized, value });
      } catch {
        throw new TypeError("automation_record_invalid");
      }
      if (Buffer.byteLength(serialized) > MAX_RECORD_BYTES)
        throw new RangeError("automation_record_too_large");
      const id = opaqueId(key, normalized);
      const encrypted = encrypt(key, id, {
        playerId: normalized,
        value: JSON.parse(serialized).value,
      });
      const written = transaction(() => {
        if (restoreCheck) {
          const route = this.readRoutePolicy(normalized);
          if (
            this.readRestoreGuardEpoch() !== restoreCheck.epoch ||
            (restoreCheck.epoch !== null &&
              (!this.isRestoreAccountReauthorized(normalized) ||
                !this.hasExplicitRoutePolicy(normalized) ||
                this.readGameAccountOwner(normalized)?.ownerId !==
                  restoreCheck.ownerId)) ||
            route.policy !== restoreCheck.route.policy ||
            route.routeEpoch !== restoreCheck.route.routeEpoch ||
            route.activeDeviceId !== restoreCheck.route.activeDeviceId
          )
            return false;
        }
        const row = select.get(id);
        if (!row)
          return (
            expectedVersion === 0 && upsert.run(id, encrypted).changes === 1
          );
        const record = decrypt(key, id, row.record);
        if (
          !record ||
          record.playerId !== normalized ||
          !Object.hasOwn(record, "value")
        )
          throw new Error("automation_state_corrupt");
        const currentVersion = record.value?.version ?? 0;
        if (!Number.isSafeInteger(currentVersion) || currentVersion < 0)
          throw new Error("automation_state_corrupt");
        if (currentVersion !== expectedVersion) return false;
        upsert.run(id, encrypted);
        return true;
      });
      if (written)
        for (const suffix of ["-wal", "-shm"])
          if (existsSync(databasePath + suffix))
            chmodSync(databasePath + suffix, 0o600);
      return written;
    },
    list() {
      const rows = selectAll.all();
      const result = [];
      for (const row of rows) {
        const record = decrypt(key, row.account_key, row.record);
        if (
          !record ||
          typeof record.playerId !== "string" ||
          opaqueId(key, record.playerId) !== row.account_key ||
          !Object.hasOwn(record, "value")
        )
          throw new Error("automation_state_corrupt");
        result.push({ playerId: record.playerId, value: record.value });
      }
      return result;
    },
    acquireLease(owner, nowMs, ttlMs) {
      if (
        typeof owner !== "string" ||
        owner.length < 1 ||
        owner.length > 256 ||
        !Number.isSafeInteger(nowMs) ||
        !Number.isSafeInteger(ttlMs) ||
        ttlMs <= 0 ||
        !Number.isSafeInteger(nowMs + ttlMs)
      )
        throw new TypeError("invalid_automation_lease");
      const result = transaction(() =>
        acquireLeaseStatement.run(owner, nowMs + ttlMs, nowMs),
      );
      return result.changes === 1;
    },
    releaseLease(owner) {
      if (typeof owner !== "string" || owner.length < 1 || owner.length > 256)
        throw new TypeError("invalid_automation_lease_owner");
      const result = transaction(() => releaseLeaseStatement.run(owner));
      return result.changes === 1;
    },
    close() {
      db.close();
    },
  };
}
