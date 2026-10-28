import { readRaidFriendStatus } from "./raid-friends.mjs";

// The queue persists the running state before dispatch and reconciles it after restart.
export function queuedFriendResponseAdapter({ entry, fetcher, save }) {
  const status = (playerId) =>
    readRaidFriendStatus({ fetcher, credential: entry.credential, playerId });
  const resolved = (job, current) =>
    job.args.decision === "accept" ? current === "friend" : current === "none";
  const complete = () => {
    if (entry.friendSnapshot) entry.friendSnapshot.nextAt = 0;
    save(entry);
    return { status: "completed" };
  };
  async function reconcile(job) {
    try {
      return resolved(job, await status(job.args.playerId))
        ? complete()
        : { status: "uncertain", reason: "Проверяем результат заявки." };
    } catch (error) {
      return {
        status: "uncertain",
        reason: "Ожидаем игру.",
        retryAfterMs: error.retryAfterMs,
      };
    }
  }
  return {
    validate(args) {
      if (
        !Number.isSafeInteger(args?.playerId) ||
        args.playerId <= 0 ||
        !["accept", "decline"].includes(args.decision)
      )
        throw new Error("invalid_friend_request_response");
      return {
        playerId: args.playerId,
        decision: args.decision,
        name: typeof args.name === "string" ? args.name.slice(0, 100) : "",
      };
    },
    dedupeKey: (args) => args.playerId,
    async execute(job, { canDispatch }) {
      let current;
      try {
        current = await status(job.args.playerId);
      } catch (error) {
        return {
          status: "retry",
          reason: "Ожидаем игру.",
          retryAfterMs: error.retryAfterMs,
        };
      }
      if (resolved(job, current)) return complete();
      if (current !== "incoming")
        return { status: "failed", reason: "friend_request_unavailable" };
      if (!canDispatch()) return { status: "retry" };
      const accept = job.args.decision === "accept";
      try {
        const response = await fetcher(
          `https://cargohustle.online/api/friends/requests/${job.args.playerId}${accept ? "/accept" : ""}`,
          {
            method: accept ? "POST" : "DELETE",
            headers: {
              Authorization: entry.credential,
              Accept: "application/json",
              ...(accept ? { "Content-Type": "application/json" } : {}),
            },
            ...(accept ? { body: "{}" } : {}),
            redirect: "error",
            cache: "no-store",
            signal: AbortSignal.timeout(20000),
            canDispatch,
          },
        );
        if (
          !response.ok &&
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 429
        )
          return { status: "failed", reason: "friend_request_unavailable" };
      } catch (error) {
        if (error?.notDispatched) return { status: "retry" };
      }
      return reconcile(job);
    },
    reconcile,
  };
}
