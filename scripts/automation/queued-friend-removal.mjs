import { removeFriend, reconcileFriendRemoval } from "./friend-removal.mjs";
import { readRaidFriendStatus } from "./raid-friends.mjs";

export function queuedFriendRemovalAdapter({ entry, fetcher, save }) {
  function confirmed(job) {
    const buddy = entry.raidSubscription.getSnapshot();
    if (
      buddy.mode === "buddy" &&
      (buddy.friendIds ?? []).includes(job.args.playerId) &&
      !entry.raidSubscription.setBuddyFriends(
        buddy.friendIds.filter((id) => id !== job.args.playerId),
      )
    )
      return { status: "uncertain", reason: "Ожидаем другие действия." };
    if (entry.friendSnapshot?.items) {
      entry.friendSnapshot.items = entry.friendSnapshot.items.filter(
        (item) => item.playerId !== job.args.playerId,
      );
      save(entry);
    }
    return { status: "completed" };
  }
  async function reconcile(job) {
    try {
      const pending = entry.friendRemoval?.pending;
      if (pending && pending.commandId !== job.id)
        return {
          status: "uncertain",
          reason: "Проверяем предыдущее действие.",
        };
      if (pending) {
        const result = await reconcileFriendRemoval({ entry, fetcher, save });
        return result === "removed"
          ? confirmed(job)
          : { status: "uncertain", reason: "Проверяем результат." };
      }
      const status = await readRaidFriendStatus({
        fetcher,
        credential: entry.credential,
        playerId: job.args.playerId,
        includeIncoming: false,
      });
      return status !== "friend"
        ? confirmed(job)
        : { status: "uncertain", reason: "Проверяем результат." };
    } catch (error) {
      return {
        status: "uncertain",
        reason: [401, 403].includes(error.status)
          ? "game_session_required"
          : "Ожидаем игру.",
        retryAfterMs: error.retryAfterMs,
      };
    }
  }
  return {
    dedupeKey: (args) => args.playerId,
    validate(args) {
      if (!Number.isSafeInteger(args?.playerId) || args.playerId <= 0)
        throw new Error("invalid_friend_player");
      return {
        playerId: args.playerId,
        ...(typeof args.name === "string"
          ? { name: args.name.slice(0, 80) }
          : {}),
      };
    },
    async execute(job, { canDispatch }) {
      if (entry.friendRemoval?.pending) {
        try {
          const old = entry.friendRemoval.pending;
          const result = await reconcileFriendRemoval({ entry, fetcher, save });
          if (result !== "removed")
            return {
              status: "retry",
              reason: "Проверяем предыдущее действие.",
            };
          if (old.playerId === job.args.playerId) return confirmed(job);
        } catch (error) {
          return {
            status: "retry",
            reason: "Ожидаем игру.",
            retryAfterMs: error.retryAfterMs,
          };
        }
      }
      try {
        const result = await removeFriend({
          entry,
          playerId: job.args.playerId,
          commandId: job.id,
          fetcher,
          save,
          allowed: canDispatch,
        });
        return result === "removed"
          ? confirmed(job)
          : { status: "uncertain", reason: "Проверяем результат." };
      } catch (error) {
        if (entry.friendRemoval?.pending?.commandId === job.id)
          return { status: "uncertain", reason: "Проверяем результат." };
        if ([401, 403].includes(error.status))
          return { status: "failed", reason: "game_session_required" };
        if (error?.notDispatched)
          return {
            status: "retry",
            reason: error.retryAfterMs ? "Ожидаем игру." : null,
            retryAfterMs: error.retryAfterMs,
          };
        if (error.status === 429)
          return {
            status: "retry",
            reason: "Ожидаем игру.",
            retryAfterMs: error.retryAfterMs,
          };
        if (error.status && error.status < 500)
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
