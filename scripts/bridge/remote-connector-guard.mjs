import { verifyWikiIdentity } from "../../connector/account-session.js";
import { createConnectorLeaseIpcClient } from "./connector-lease-ipc.mjs";
import { createConnectorOwnerGuard } from "./connector-owner-guard.mjs";

/** Construct only on the Connector host, with a provisioned private IPC key. */
export function createRemoteConnectorGuard({
  endpoint,
  key,
  verificationKey,
  fetcher = fetch,
  now = Date.now,
} = {}) {
  if (
    typeof verificationKey !== "string" ||
    !/^[a-f0-9]{64}$/i.test(verificationKey)
  )
    throw new TypeError("wiki_verification_key_required");
  const leases = createConnectorLeaseIpcClient({ endpoint, key, fetcher, now });
  return createConnectorOwnerGuard({
    verifyOwner: (initData) =>
      verifyWikiIdentity(initData, verificationKey, now()),
    leases,
  });
}
