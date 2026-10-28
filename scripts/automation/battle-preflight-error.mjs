// Applies only before the queued operation has sent a mutation. Unknown
// responses and rate limits remain retryable; submitted actions reconcile.
export function terminalBattlePreflight(status) {
  if ([401, 403].includes(status))
    return { status: "failed", reason: "game_session_required" };
  if ([400, 404, 405, 410, 422].includes(status))
    return { status: "failed", reason: "game_request_rejected" };
  return null;
}

export function battleRetryAfter(snapshot) {
  return Number.isFinite(snapshot?.errorRetryAfterMs) &&
    snapshot.errorRetryAfterMs >= 0
    ? { retryAfterMs: snapshot.errorRetryAfterMs }
    : {};
}
