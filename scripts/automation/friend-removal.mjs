import { readRaidFriendStatus } from "./raid-friends.mjs";
const fail = (status, code) => Object.assign(new Error(code), { status });
const positive = (value) => Number.isSafeInteger(value) && value > 0;

export async function removeFriend({
  entry,
  playerId,
  commandId,
  fetcher,
  save,
  allowed,
}) {
  if (!positive(playerId)) throw fail(400, "invalid_friend_player");
  if (entry.friendRemoval?.pending) throw fail(409, "friend_removal_uncertain");
  const before = await readRaidFriendStatus({
    fetcher,
    credential: entry.credential,
    playerId,
    includeIncoming: false,
  });
  if (before !== "friend") throw fail(409, "friend_not_found");
  entry.friendRemoval = { pending: { playerId, commandId } };
  save(entry);
  if (entry.storageFailed) throw fail(503, "automation_storage_unavailable");
  if (!allowed()) {
    entry.friendRemoval.pending = null;
    save(entry);
    throw Object.assign(fail(409, "friend_removal_cancelled"), {
      notDispatched: true,
    });
  }
  let response;
  try {
    response = await fetcher(
      `https://cargohustle.online/api/friends/${playerId}`,
      {
        method: "DELETE",
        headers: {
          Authorization: entry.credential,
          Accept: "application/json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(20000),
        canDispatch: allowed,
      },
    );
  } catch (error) {
    if (error?.notDispatched) {
      entry.friendRemoval.pending = null;
      save(entry);
    }
    throw error;
  }
  if (!response.ok) throw fail(503, "friend_removal_uncertain");
  return reconcileFriendRemoval({ entry, fetcher, save });
}
export async function reconcileFriendRemoval({ entry, fetcher, save }) {
  const playerId = entry.friendRemoval?.pending?.playerId;
  if (!positive(playerId)) return "none";
  const status = await readRaidFriendStatus({
    fetcher,
    credential: entry.credential,
    playerId,
    includeIncoming: false,
  });
  if (status === "friend") return "uncertain";
  entry.friendRemoval = { pending: null };
  entry.preferences = {
    ...entry.preferences,
    favoriteFriendIds: (entry.preferences.favoriteFriendIds ?? []).filter(
      (id) => id !== playerId,
    ),
  };
  save(entry);
  if (entry.storageFailed) throw fail(503, "automation_storage_unavailable");
  return "removed";
}
