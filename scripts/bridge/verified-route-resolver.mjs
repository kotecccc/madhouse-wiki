/**
 * Only server-verified player identities may reach this resolver. Unknown
 * identities remain unresolved: the resolver must never infer a direct route.
 */
export function createVerifiedRouteResolver({ accounts } = {}) {
  if (typeof accounts?.resolveVerifiedPlayer !== "function")
    throw new TypeError("account_store_required");
  return async (verifiedIdentity) => {
    if (!verifiedIdentity || typeof verifiedIdentity.playerId !== "string")
      return null;
    return accounts.resolveVerifiedPlayer(verifiedIdentity.playerId);
  };
}

/** Resolve only an explicitly supplied game credential; unknown means deny. */
export function createCredentialRouteResolver({ accounts } = {}) {
  if (typeof accounts?.resolveCredential !== "function")
    throw new TypeError("account_store_required");
  return async (identity) =>
    accounts.resolveCredential(identity?.authorization);
}
