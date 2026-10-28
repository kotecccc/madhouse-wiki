/** Wait for the bridge status before restoring a legacy Telegram session. */
export function bridgeRestorePolicy(bridgeAvailable, status) {
  if (!bridgeAvailable) return "allow";
  if (status === "pending") return "wait";
  return status === "not_configured" ? "allow" : "skip";
}
