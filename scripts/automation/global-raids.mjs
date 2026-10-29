const TWO_HOURS = 2 * 60 * 60 * 1000;
const FIVE_MINUTES = 5 * 60 * 1000;
const THIRTY_MINUTES = 30 * 60 * 1000;
const TERMINAL = new Set(["won", "lost", "expired", "surrendered"]);

// An invitation discovers a battle; only its own response identifies the leader.
export function projectGlobalRaidBattle(invitation, battle) {
  if (
    !invitation ||
    !battle ||
    typeof invitation.battleId !== "string" ||
    !/^[A-Za-z0-9_-]{1,120}$/.test(invitation.battleId) ||
    battle.battleId !== invitation.battleId ||
    !Number.isSafeInteger(battle.bossId) ||
    battle.bossId <= 0 ||
    battle.bossId !== invitation.bossId ||
    !Number.isSafeInteger(battle.leaderPlayerId) ||
    battle.leaderPlayerId <= 0 ||
    (invitation.leaderPlayerId != null &&
      invitation.leaderPlayerId !== battle.leaderPlayerId)
  )
    return null;
  const status = String(battle.status ?? "").toLowerCase();
  if (status !== "active" && !TERMINAL.has(status)) return null;
  const startedAt = Date.parse(battle.createdAtUtc);
  const completedAt = Date.parse(battle.completedAtUtc);
  if (status !== "active" && !Number.isFinite(completedAt)) return null;
  const participants = Array.isArray(battle.participants)
    ? battle.participants.filter((p) => p?.playerId === battle.leaderPlayerId)
    : [];
  const leader = participants.length === 1 ? participants[0] : null;
  const text = (value) =>
    typeof value === "string" ? value.trim().slice(0, 80) : "";
  return {
    id: battle.battleId,
    bossId: battle.bossId,
    leaderPlayerId: battle.leaderPlayerId,
    leaderName: text(leader?.nickname),
    leaderUsername: text(leader?.username),
    status,
    startedAt: Number.isFinite(startedAt) ? startedAt : null,
    completedAt: Number.isFinite(completedAt) ? completedAt : null,
  };
}

// Inputs are confirmed battle completions for a single verified leader and boss.
// The caller must deduplicate by battle identity and establish who led the battle.
export function calculateGlobalRaids(completions, activeBattle, now) {
  const unique = new Map();
  for (const battle of completions) {
    if (
      typeof battle?.id !== "string" ||
      !battle.id ||
      !Number.isFinite(battle.completedAt) ||
      battle.completedAt > now
    )
      continue;
    if (!unique.has(battle.id))
      unique.set(battle.id, {
        completedAt: battle.completedAt,
        startedAt:
          Number.isFinite(battle.startedAt) &&
          battle.startedAt <= battle.completedAt
            ? battle.startedAt
            : battle.completedAt,
      });
  }
  const ordered = [...unique].map(([id, times]) => ({ id, ...times }));
  ordered.sort(
    (a, b) => a.completedAt - b.completedAt || a.id.localeCompare(b.id),
  );
  const groups = [];
  let group = [];
  for (const battle of ordered) {
    if (
      group.length &&
      battle.startedAt - group.at(-1).completedAt > THIRTY_MINUTES
    ) {
      groups.push(group);
      group = [];
    }
    group.push(battle);
  }
  if (group.length) groups.push(group);
  return groups.flatMap((battles, index) => {
    let detectedAt = null;
    for (let end = 5; end < battles.length; end++) {
      if (
        battles[end].completedAt - battles[end - 5].completedAt <=
        TWO_HOURS
      ) {
        detectedAt = battles[end].completedAt;
        break;
      }
    }
    if (detectedAt === null) return [];
    const lastBattleAt = battles.at(-1).completedAt;
    const active = index === groups.length - 1 && activeBattle === true;
    const elapsed = Math.max(0, now - lastBattleAt);
    const status = active
      ? "active"
      : elapsed <= FIVE_MINUTES
        ? "waiting"
        : elapsed <= THIRTY_MINUTES
          ? "paused"
          : "finished";
    return [
      {
        startedAt: battles[0].completedAt,
        detectedAt,
        lastBattleAt,
        count: battles.length,
        status,
      },
    ];
  });
}
