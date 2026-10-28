import { randomUUID } from "node:crypto";

const fail = (code) => Object.assign(new Error(code), { code });

/**
 * Direct admission and bridge activation share one SQLite database. A lease
 * intentionally survives crashes; it may not be expired automatically, since
 * an interrupted game mutation may have an unknown outcome.
 */
export function createDirectRouteLeases({
  db,
  accounts,
  registry,
  routeWitness = null,
} = {}) {
  if (
    !db ||
    typeof accounts?.verifiedPlayerKey !== "function" ||
    typeof accounts?.resolveVerifiedPlayer !== "function" ||
    typeof registry?.ownerKey !== "function"
  )
    throw new TypeError("direct_route_dependencies_required");
  db.exec(`CREATE TABLE IF NOT EXISTS mobile_bridge_direct_policies (
    player_key TEXT PRIMARY KEY, epoch INTEGER NOT NULL
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
  // Only trusted server code may enroll an already verified legacy account.
  function registerVerifiedDirect(playerId, owner = null) {
    const key = accounts.verifiedPlayerKey(playerId);
    const ownerKey = owner == null ? null : registry.ownerKey(owner);
    return transaction(() => {
      if (
        (ownerKey
          ? routeWitness?.hasOwner(ownerKey)
          : routeWitness?.hasAnyOwner()) ||
        routeWitness?.hasPlayer(key) ||
        (ownerKey
          ? db
              .prepare(
                "SELECT 1 FROM mobile_bridge_owner_tombstones WHERE owner_key = ?",
              )
              .get(ownerKey)
          : db
              .prepare("SELECT 1 FROM mobile_bridge_owner_tombstones LIMIT 1")
              .get()) ||
        db
          .prepare("SELECT 1 FROM mobile_bridge_accounts WHERE player_key = ?")
          .get(key) ||
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_route_tombstones WHERE player_key = ?",
          )
          .get(key)
      )
        throw fail("bridge_route_required");
      db.prepare(
        "INSERT INTO mobile_bridge_direct_policies VALUES (?, 1) ON CONFLICT(player_key) DO NOTHING",
      ).run(key);
      return { policy: "direct", epoch: 1 };
    });
  }
  function resolve(verifiedIdentity) {
    const playerId = verifiedIdentity?.playerId;
    if (typeof playerId !== "string") return null;
    const bridge = accounts.resolveVerifiedPlayer(playerId);
    if (bridge) return bridge;
    const ownerKey =
      verifiedIdentity.owner == null
        ? null
        : registry.ownerKey(verifiedIdentity.owner);
    if (
      (ownerKey
        ? routeWitness?.hasOwner(ownerKey)
        : routeWitness?.hasAnyOwner()) ||
      routeWitness?.hasPlayer(accounts.verifiedPlayerKey(playerId))
    )
      return null;
    if (
      ownerKey
        ? db
            .prepare(
              "SELECT 1 FROM mobile_bridge_owner_tombstones WHERE owner_key = ?",
            )
            .get(ownerKey)
        : db
            .prepare("SELECT 1 FROM mobile_bridge_owner_tombstones LIMIT 1")
            .get()
    )
      return null;
    const key = accounts.verifiedPlayerKey(playerId);
    if (
      db
        .prepare(
          "SELECT 1 FROM mobile_bridge_route_tombstones WHERE player_key = ?",
        )
        .get(key)
    )
      return null;
    const row = db
      .prepare(
        "SELECT epoch FROM mobile_bridge_direct_policies WHERE player_key = ?",
      )
      .get(key);
    return row ? { policy: "direct", epoch: row.epoch } : null;
  }
  async function withDirectLease(
    identity,
    epoch,
    run,
    { effect = "unknown" } = {},
  ) {
    if (
      typeof run !== "function" ||
      !["read", "mutation", "unknown"].includes(effect) ||
      !Number.isSafeInteger(epoch) ||
      epoch < 1
    )
      throw fail("direct_lease_invalid");
    const playerKey = accounts.verifiedPlayerKey(identity?.playerId);
    const ownerKey =
      identity?.owner == null ? null : registry.ownerKey(identity.owner);
    const leaseId = randomUUID();
    transaction(() => {
      if (
        (ownerKey
          ? routeWitness?.hasOwner(ownerKey)
          : routeWitness?.hasAnyOwner()) ||
        routeWitness?.hasPlayer(playerKey) ||
        (!ownerKey &&
          db
            .prepare("SELECT 1 FROM mobile_bridge_owner_tombstones LIMIT 1")
            .get()) ||
        (ownerKey &&
          db
            .prepare(
              "SELECT 1 FROM mobile_bridge_owner_tombstones WHERE owner_key = ?",
            )
            .get(ownerKey)) ||
        db
          .prepare("SELECT 1 FROM mobile_bridge_accounts WHERE player_key = ?")
          .get(playerKey) ||
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_route_tombstones WHERE player_key = ?",
          )
          .get(playerKey)
      )
        throw fail("bridge_route_required");
      const row = db
        .prepare(
          "SELECT epoch FROM mobile_bridge_direct_policies WHERE player_key = ?",
        )
        .get(playerKey);
      if (!row || row.epoch !== epoch) throw fail("game_route_changed");
      routeWitness?.beginLease(leaseId, ownerKey, playerKey);
      db.prepare(
        "INSERT INTO mobile_bridge_direct_leases (lease_id, player_key, owner_key, epoch, phase, effect, created_at) VALUES (?, ?, ?, ?, 'prepared', ?, ?)",
      ).run(leaseId, playerKey, ownerKey, epoch, effect, Date.now());
    });
    let dispatched = false;
    const release = () => {
      db.prepare(
        "DELETE FROM mobile_bridge_direct_leases WHERE lease_id = ?",
      ).run(leaseId);
      routeWitness?.finishLease(leaseId);
    };
    try {
      const result = await run(() => {
        const changed = db
          .prepare(
            "UPDATE mobile_bridge_direct_leases SET phase = 'dispatched' WHERE lease_id = ? AND phase = 'prepared'",
          )
          .run(leaseId).changes;
        if (changed !== 1) throw fail("direct_lease_invalid");
        dispatched = true;
      });
      release();
      return result;
    } catch (error) {
      // A dispatched request with an uncertain result remains durably blocked.
      if (!dispatched) release();
      throw error;
    }
  }
  function pending(verifiedPlayerId) {
    const playerKey = accounts.verifiedPlayerKey(verifiedPlayerId);
    return db
      .prepare(
        "SELECT lease_id, phase, effect, created_at FROM mobile_bridge_direct_leases WHERE player_key = ? ORDER BY created_at, lease_id",
      )
      .all(playerKey)
      .map((row) => ({
        id: row.lease_id,
        phase: row.phase,
        effect: row.effect,
        createdAt: row.created_at,
      }));
  }
  return Object.freeze({
    registerVerifiedDirect,
    resolve,
    withDirectLease,
    pending,
  });
}
