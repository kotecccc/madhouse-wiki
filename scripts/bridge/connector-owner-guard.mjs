/**
 * Server-side coordinator for a Connector request. Identity verification and
 * lease operations must be backed by trusted server state, never client claims.
 */
export function createConnectorOwnerGuard({ verifyOwner, leases } = {}) {
  if (
    typeof verifyOwner !== "function" ||
    typeof leases?.acquire !== "function" ||
    typeof leases?.markDispatched !== "function" ||
    typeof leases?.finish !== "function"
  )
    throw new TypeError("connector_guard_dependencies_required");

  async function withOwnerLease(owner, operation, run) {
    const lease = await leases.acquire(owner, operation);
    let dispatched = false;
    try {
      await leases.markDispatched(owner, lease);
      dispatched = true;
      const register = async (playerId, credentialDigest) => {
        if (
          !["session_verify", "telegram_auth"].includes(operation) ||
          typeof leases.registerVerified !== "function"
        )
          throw new Error("bridge_unavailable");
        await leases.registerVerified(owner, lease, playerId, credentialDigest);
      };
      const result = await run(register);
      const status = result?.status;
      if (!Number.isInteger(status) || status < 100 || status > 599)
        throw new Error("direct_result_uncertain");
      if (status >= 500 || status === 429) return result;
      await leases.finish(owner, lease, { definitelyFinished: true });
      return result;
    } catch (error) {
      if (!dispatched)
        await leases.finish(owner, lease, { definitelyFinished: true });
      throw error;
    }
  }

  async function withGameSessionLease(wikiInitData, gameInitData, run) {
    const owner = await verifyOwner(wikiInitData);
    if (typeof owner !== "string" || !/^[1-9][0-9]{0,15}$/.test(owner))
      throw new Error("invalid_wiki_identity");
    try {
      const values = new URLSearchParams(gameInitData);
      if (values.getAll("user").length !== 1) throw new Error();
      const user = JSON.parse(values.get("user"));
      if (!Number.isSafeInteger(user?.id) || String(user.id) !== owner)
        throw new Error();
    } catch {
      throw new Error("invalid_game_identity");
    }
    return withOwnerLease(owner, "telegram_auth", run);
  }
  return Object.freeze({ withOwnerLease, withGameSessionLease });
}
