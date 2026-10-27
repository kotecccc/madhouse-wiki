import { sortRaidsByTime } from "../../lib/raid-schedule.js";

const normalize = (value) =>
  String(value || "")
    .trim()
    .replace(/^@/, "")
    .toLocaleLowerCase("ru-RU");

export function raidFriendTarget(raid, candidate) {
  const playerId = candidate?.leaderPlayerId;
  const rawLeader = String(raid?.leader ?? "").trim();
  const username = String(
    candidate?.leaderUsername ?? (rawLeader.startsWith("@") ? rawLeader : ""),
  )
    .trim()
    .replace(/^@/, "");
  if (Number.isSafeInteger(playerId) && playerId > 0)
    return {
      playerId,
      username: /^[A-Za-z0-9_]{1,64}$/.test(username) ? username : "",
    };
  if (rawLeader.startsWith("@") && /^[A-Za-z0-9_]{1,64}$/.test(username))
    return { username };
  return null;
}

export function raidFriendKey(target) {
  return target?.playerId
    ? `id:${target.playerId}`
    : target?.username
      ? `name:${normalize(target.username)}`
      : null;
}

// Public handles are used only to find an unambiguous display match. The
// server validates the leader's numeric game ID again before subscribing.
export function combineRaids(
  publicRaids,
  detectedRaids,
  subscription,
  bosses = [],
) {
  const detected = [...(detectedRaids || [])];
  if (
    (subscription?.enabled || subscription?.hasSuspendedGoal) &&
    !detected.some(
      (item) =>
        item.leaderPlayerId === subscription.leaderPlayerId &&
        item.bossId === subscription.bossId,
    )
  )
    detected.push({
      leaderPlayerId: subscription.leaderPlayerId,
      bossId: subscription.bossId,
      bossName: subscription.bossName,
      sender: subscription.leaderName,
      leaderUsername: subscription.leaderUsername,
    });
  const used = new Set();
  const rows = sortRaidsByTime(publicRaids).map((raid, index) => {
    const matches = detected.filter(
      (item) =>
        item.leaderUsername &&
        normalize(item.leaderUsername) === normalize(raid.leader) &&
        normalize(item.bossName) === normalize(raid.boss),
    );
    let match = matches.length === 1 ? matches[0] : null;
    if (match) used.add(`${match.leaderPlayerId}:${match.bossId}`);
    if (
      !match &&
      matches.length === 0 &&
      /^@?[A-Za-z0-9_]{1,64}$/.test(String(raid.leader || "").trim())
    ) {
      const exact = bosses.filter(
        (boss) =>
          normalize(boss.name) === normalize(raid.boss) &&
          Number.isSafeInteger(Number(boss.numericId ?? boss.apiId)) &&
          Number(boss.numericId ?? boss.apiId) > 0,
      );
      if (exact.length === 1)
        match = {
          leaderPlayerId: null,
          leaderUsername: String(raid.leader).trim().replace(/^@/, ""),
          bossId: Number(exact[0].numericId ?? exact[0].apiId),
          bossName: exact[0].name,
        };
    }
    return { key: `public:${index}`, raid, candidate: match, detected: false };
  });
  for (const item of detected) {
    const key = `${item.leaderPlayerId}:${item.bossId}`;
    if (used.has(key)) continue;
    used.add(key);
    rows.push({
      key: `detected:${key}`,
      raid: {
        boss: item.bossName,
        leader: item.leaderUsername
          ? `@${item.leaderUsername.replace(/^@/, "")}`
          : item.sender,
      },
      candidate: item,
      detected: true,
    });
  }
  return rows;
}
