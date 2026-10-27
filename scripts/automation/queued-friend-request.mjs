import { reconcileRaidFriend, requestRaidFriend } from "./raid-friends.mjs";

export function queuedFriendRequestAdapter({ entry, fetcher, save }) {
  const confirmed = (job) => (entry.raidFriendReceipts ?? []).includes(job.id);
  const finish = () => {
    const friend = entry.raidFriend;
    if (friend.status === "pending")
      entry.raidFriendWatch[friend.playerId] = friend.username;
    if (friend.playerId)
      entry.raidFriendStatuses[`id:${friend.playerId}`] = friend.status;
    if (friend.username)
      entry.raidFriendStatuses[`name:${friend.username}`] = friend.status;
    save(entry);
    return { status: "completed" };
  };
  async function reconcile(job) {
    if (confirmed(job)) return finish();
    const pending = entry.raidFriend?.pending;
    if (!pending) return { status: "retry", reason: "Ожидаем игру." };
    try {
      await reconcileRaidFriend({ entry, fetcher, save });
      if (confirmed(job)) return finish();
      if (entry.raidFriend.pending)
        return {
          status: pending.id === job.id ? "uncertain" : "retry",
          reason: "Проверяем результат.",
        };
      return { status: "retry", reason: "Ожидаем игру." };
    } catch (error) {
      return {
        status: pending.id === job.id ? "uncertain" : "retry",
        reason: "Ожидаем игру.",
        retryAfterMs: error.retryAfterMs,
      };
    }
  }
  return {
    validate(args) {
      const playerId = args?.playerId;
      const username = String(args?.username ?? "")
        .trim()
        .replace(/^@/, "");
      if (
        !(Number.isSafeInteger(playerId) && playerId > 0) &&
        !/^[A-Za-z0-9_]{1,64}$/.test(username)
      )
        throw new Error("invalid_friend_player");
      if (username && !/^[A-Za-z0-9_]{1,64}$/.test(username))
        throw new Error("invalid_friend_player");
      return {
        playerId:
          Number.isSafeInteger(playerId) && playerId > 0 ? playerId : null,
        username: username.toLowerCase(),
      };
    },
    dedupeKey: (args) => args.playerId || `name:${args.username}`,
    async execute(job, { canDispatch }) {
      if (entry.raidFriend?.pending) {
        const result = await reconcile(job);
        if (result.status !== "retry" || entry.raidFriend.pending)
          return result;
      }
      if (Object.keys(entry.raidFriendWatch).length >= 100)
        return { status: "failed", reason: "too_many_friend_requests" };
      try {
        await requestRaidFriend({
          entry,
          args: job.args,
          commandId: job.id,
          fetcher,
          save,
          allowed: canDispatch,
        });
        return confirmed(job) ? finish() : { status: "uncertain" };
      } catch (error) {
        if (entry.raidFriend?.pending?.id === job.id)
          return { status: "uncertain", reason: "Проверяем результат." };
        if (error?.notDispatched || !canDispatch()) return { status: "retry" };
        if (error.status && error.status < 500 && error.status !== 429)
          return { status: "failed", reason: error.message };
        return {
          status: "retry",
          reason: "Ожидаем игру.",
          retryAfterMs: error.retryAfterMs,
        };
      }
    },
    reconcile,
  };
}
