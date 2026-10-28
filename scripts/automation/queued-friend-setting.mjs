import { readRaidFriendStatus } from "./raid-friends.mjs";
import { terminalBattlePreflight } from "./battle-preflight-error.mjs";

export function queuedFriendSettingAdapter({ entry, fetcher, save, kind }) {
  async function apply(job, { canDispatch }) {
    const { playerId, enabled } = job.args;
    if (enabled) {
      try {
        const status = await readRaidFriendStatus({
          fetcher,
          credential: entry.credential,
          playerId,
          includeIncoming: false,
        });
        if (!canDispatch()) return { status: "retry" };
        if (status !== "friend")
          return { status: "failed", reason: "friend_not_found" };
      } catch (error) {
        const terminal = terminalBattlePreflight(error.status);
        if (terminal) return terminal;
        if (error.status && error.status < 500 && error.status !== 429)
          return { status: "failed", reason: error.message };
        return {
          status: "retry",
          reason: "Ожидаем игру.",
          retryAfterMs: error.retryAfterMs,
        };
      }
    }
    if (!canDispatch()) return { status: "retry" };
    if (kind === "favorite") {
      const ids = new Set(entry.preferences.favoriteFriendIds ?? []);
      if (enabled && ids.size >= 1000 && !ids.has(playerId))
        return { status: "failed", reason: "too_many_favorites" };
      if (enabled) ids.add(playerId);
      else ids.delete(playerId);
      entry.preferences = { ...entry.preferences, favoriteFriendIds: [...ids] };
      save(entry);
    } else {
      const subscription = entry.raidSubscription.getSnapshot();
      if (
        (subscription.enabled || subscription.checkpoint) &&
        subscription.mode !== "buddy"
      )
        return { status: "retry", reason: "Ожидаем другие действия." };
      const ids = new Set(
        subscription.mode === "buddy" ? (subscription.friendIds ?? []) : [],
      );
      if (enabled) ids.add(playerId);
      else ids.delete(playerId);
      if (!entry.raidSubscription.setBuddyFriends([...ids]))
        return { status: "failed", reason: "buddy_unavailable" };
    }
    return { status: "completed" };
  }
  return {
    validate(args) {
      if (
        !Number.isSafeInteger(args?.playerId) ||
        args.playerId <= 0 ||
        typeof args.enabled !== "boolean"
      )
        throw new Error("invalid_friend_player");
      return {
        playerId: args.playerId,
        enabled: args.enabled,
        name: typeof args.name === "string" ? args.name.slice(0, 80) : "",
      };
    },
    dedupeKey: (args) => `${args.playerId}:${args.enabled}`,
    supersedes: (args, previous) => args.playerId === previous.playerId,
    execute: apply,
    // This only changes local settings, so repeating it after a crash is safe.
    reconcile: apply,
  };
}
