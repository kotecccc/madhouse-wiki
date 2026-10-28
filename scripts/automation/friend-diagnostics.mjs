const stages = new Set(["snapshot", "friends", "outgoing", "incoming"]);
const operations = new Set([
  "snapshot.refresh",
  "raid.friend.check",
  "raid.friend.inspect",
  "raid.friend.refresh",
  "raid.friend.request",
  "friend.request.enqueue",
  "friend.request.execute",
  "friend.request.reconcile",
]);
const reasons = new Set([
  "friends_unavailable",
  "friends_incomplete",
  "friends_capacity_exceeded",
  "friend_status_unavailable",
  "friend_search_unavailable",
  "friend_leader_unverified",
  "friend_status_pending",
  "too_many_friend_requests",
  "invalid_friend_player",
  "invalid_friend_targets",
  "automation_storage_unavailable",
  "automation_command_already_received",
  "invalid_automation_command",
  "friend_request_uncertain",
  "automation_stopped",
  "automation_version_conflict",
]);

export function annotateFriendError(error, stage) {
  if (error && typeof error === "object" && stages.has(stage)) {
    try {
      error.friendDiagnosticStage = stage;
    } catch {
      // Diagnostics must never alter error handling.
    }
  }
  return error;
}

export function friendDiagnostic(operation, error) {
  const reason = reasons.has(error?.message)
    ? error.message
    : error?.name === "TimeoutError"
      ? "timeout"
      : error?.name === "AbortError"
        ? "aborted"
        : error instanceof SyntaxError
          ? "invalid_json"
          : error instanceof TypeError
            ? "transport_or_processing"
            : "other";
  const candidate = error?.friendUpstreamStatus ?? error?.status;
  const status =
    Number.isInteger(candidate) && candidate >= 100 && candidate <= 599
      ? candidate
      : null;
  return {
    operation: operations.has(operation) ? operation : "other",
    stage: stages.has(error?.friendDiagnosticStage)
      ? error.friendDiagnosticStage
      : "command",
    reason,
    status,
  };
}

export function logFriendError(operation, error) {
  try {
    console.warn(
      "madhouse-friend-diagnostic",
      JSON.stringify(friendDiagnostic(operation, error)),
    );
  } catch {
    // Logging is best effort and must not affect automation.
  }
}
