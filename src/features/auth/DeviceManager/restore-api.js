const ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const RESTORE_STATES = new Set([
  "not_required",
  "reauthorization_required",
  "auth_pending",
  "auth_prepared",
  "auth_ready_to_resume",
  "auth_check_saved",
  "auth_outcome_unknown",
  "auth_failed",
  "review_required",
  "reconciliation_required",
  "ready",
]);

export function createRestoreApi({
  fetcher = fetch,
  uuid = () => crypto.randomUUID(),
} = {}) {
  async function request(operation, fields, initData, signal) {
    if (typeof initData !== "string" || !initData || initData.length > 8192)
      throw new Error("telegram_session_required");
    const requestId = uuid();
    if (typeof requestId !== "string" || !ID_PATTERN.test(requestId))
      throw new Error("invalid_request");
    const response = await fetcher("/api/bridge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      redirect: "error",
      signal,
      body: JSON.stringify({ operation, requestId, ...fields, initData }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok)
      throw new Error(
        typeof body?.error === "string" ? body.error : "bridge_unavailable",
      );
    if (
      !body ||
      body.operation !== operation ||
      body.requestId !== requestId ||
      Object.hasOwn(body, "accessToken")
    )
      throw new Error("bridge_unavailable");
    return body;
  }
  async function status(initData, signal) {
    const result = await request("restore.status", {}, initData, signal);
    if (Object.keys(result).length !== 3 || !RESTORE_STATES.has(result.status))
      throw new Error("bridge_unavailable");
    return result.status;
  }
  async function review(initData, signal) {
    const challenge = await request("restore.challenge", {}, initData, signal);
    if (
      Object.keys(challenge).length !== 4 ||
      typeof challenge.challenge !== "string" ||
      !CHALLENGE_PATTERN.test(challenge.challenge) ||
      !Number.isSafeInteger(challenge.expiresAt)
    )
      throw new Error("bridge_unavailable");
    const result = await request(
      "restore.review",
      { challenge: challenge.challenge },
      initData,
      signal,
    );
    if (
      Object.keys(result).length !== 3 ||
      !["ready", "reconciliation_required"].includes(result.status)
    )
      throw new Error("bridge_unavailable");
    return result.status;
  }
  async function beginDirect(initData, signal) {
    const challenge = await request("restore.challenge", {}, initData, signal);
    if (
      Object.keys(challenge).length !== 4 ||
      typeof challenge.challenge !== "string" ||
      !CHALLENGE_PATTERN.test(challenge.challenge) ||
      !Number.isSafeInteger(challenge.expiresAt)
    )
      throw new Error("bridge_unavailable");
    const result = await request(
      "restore.confirm",
      { routePolicy: "direct", challenge: challenge.challenge },
      initData,
      signal,
    );
    if (Object.keys(result).length !== 3 || result.status !== "confirmed")
      throw new Error("bridge_unavailable");
    return result.requestId;
  }
  async function resume(initData, signal) {
    const result = await request("restore.resume", {}, initData, signal);
    if (Object.keys(result).length !== 3 || result.status !== "review_required")
      throw new Error("bridge_unavailable");
    return result.status;
  }
  async function cancelPrepared(initData, signal) {
    const result = await request(
      "restore.cancel_prepared",
      {},
      initData,
      signal,
    );
    if (Object.keys(result).length !== 3 || result.status !== "cancelled")
      throw new Error("bridge_unavailable");
    return "reauthorization_required";
  }
  async function acknowledgeUnknown(initData, signal) {
    const challenge = await request("restore.challenge", {}, initData, signal);
    if (
      Object.keys(challenge).length !== 4 ||
      typeof challenge.challenge !== "string" ||
      !CHALLENGE_PATTERN.test(challenge.challenge) ||
      !Number.isSafeInteger(challenge.expiresAt)
    )
      throw new Error("bridge_unavailable");
    const result = await request(
      "restore.ack_unknown",
      { challenge: challenge.challenge },
      initData,
      signal,
    );
    if (
      Object.keys(result).length !== 3 ||
      result.status !== "reauthorization_required"
    )
      throw new Error("bridge_unavailable");
    return result.status;
  }
  return Object.freeze({
    status,
    review,
    beginDirect,
    resume,
    cancelPrepared,
    acknowledgeUnknown,
  });
}
