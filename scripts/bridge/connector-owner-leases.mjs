import { randomUUID } from "node:crypto";

const fail = (code) => Object.assign(new Error(code), { code });

/**
 * Cross-process fence for the legacy Connector's direct game requests. The
 * owner must already be authenticated by a trusted connector boundary. Leases
 * do not expire: a lost response requires explicit reconciliation.
 */
export function createConnectorOwnerLeases({
  db,
  registry,
  routeWitness = null,
} = {}) {
  if (!db || typeof registry?.ownerKey !== "function")
    throw new TypeError("owner_lease_dependencies_required");
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
  function acquire(verifiedOwner, operation) {
    if (!["telegram_auth", "session_verify"].includes(operation))
      throw fail("invalid_owner_operation");
    const ownerKey = registry.ownerKey(verifiedOwner);
    const leaseId = randomUUID();
    transaction(() => {
      if (
        routeWitness?.hasOwner(ownerKey) ||
        db
          .prepare("SELECT 1 FROM mobile_bridge_accounts WHERE owner_key = ?")
          .get(ownerKey) ||
        db
          .prepare(
            "SELECT 1 FROM mobile_bridge_owner_tombstones WHERE owner_key = ?",
          )
          .get(ownerKey)
      )
        throw fail("bridge_route_required");
      routeWitness?.beginLease(leaseId, ownerKey, null);
      db.prepare(
        "INSERT INTO mobile_bridge_owner_leases (lease_id, owner_key, phase, operation, created_at) VALUES (?, ?, 'prepared', ?, ?)",
      ).run(leaseId, ownerKey, operation, Date.now());
    });
    return leaseId;
  }
  function markDispatched(verifiedOwner, leaseId) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    const result = db
      .prepare(
        "UPDATE mobile_bridge_owner_leases SET phase = 'dispatched' WHERE owner_key = ? AND lease_id = ? AND phase = 'prepared'",
      )
      .run(ownerKey, leaseId);
    if (result.changes !== 1) throw fail("owner_lease_invalid");
  }
  function finish(verifiedOwner, leaseId, { definitelyFinished = false } = {}) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    if (definitelyFinished !== true) throw fail("owner_lease_unresolved");
    const deleted =
      db
        .prepare(
          "DELETE FROM mobile_bridge_owner_leases WHERE owner_key = ? AND lease_id = ?",
        )
        .run(ownerKey, leaseId).changes === 1;
    if (deleted) routeWitness?.finishLease(leaseId);
    return deleted;
  }
  function pending(verifiedOwner) {
    const ownerKey = registry.ownerKey(verifiedOwner);
    return db
      .prepare(
        "SELECT lease_id, phase, operation, created_at FROM mobile_bridge_owner_leases WHERE owner_key = ? ORDER BY created_at, lease_id",
      )
      .all(ownerKey)
      .map((row) => ({
        id: row.lease_id,
        phase: row.phase,
        operation: row.operation,
        createdAt: row.created_at,
      }));
  }
  return Object.freeze({ acquire, markDispatched, finish, pending });
}
