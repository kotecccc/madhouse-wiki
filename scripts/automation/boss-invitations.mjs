import { normalizeBossBattleStatus } from "../../src/features/bosses/BossBattle/boss-battle-status.js";

export const BOSS_INVITATIONS_PATH =
  "/api/bosses/invitations?direction=incoming&status=pending";
const identifier = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const text = (value) =>
  typeof value === "string" ? value.trim().slice(0, 80) : "";

// An exact expired invitation and terminal battle are affirmative evidence;
// absence from a possibly truncated list is not.
export function isFinishedInvitation(raw, pending) {
  if (
    !Array.isArray(raw?.items) ||
    raw.success === false ||
    raw.partial === true ||
    raw.error ||
    !pending
  )
    return false;
  const matches = raw.items.filter(
    (item) => item?.invitationId === pending.invitationId,
  );
  if (matches.length !== 1) return false;
  const item = matches[0];
  return (
    item.battleId === pending.battleId &&
    item.bossId === pending.bossId &&
    item.status === "expired" &&
    ["won", "lost", "expired", "surrendered"].includes(
      normalizeBossBattleStatus(item.battleStatus),
    )
  );
}

// Private account projection. Keep only validated identifiers needed by automation.
export async function projectBossInvitations(raw, getBoss, now = Date.now()) {
  if (!Array.isArray(raw?.items))
    throw new TypeError("invalid_boss_invitations");
  const unique = new Map();
  for (const item of raw.items.slice(0, 100)) {
    if (
      !identifier(item?.invitationId) ||
      !identifier(item.battleId) ||
      !Number.isSafeInteger(item.bossId) ||
      item.bossId <= 0 ||
      String(item.status).toLowerCase() !== "pending"
    )
      continue;
    const invitationExpiry = Date.parse(item.expiresAtUtc);
    const battleExpiry = Date.parse(item.battleExpiresAtUtc);
    const expiresAt =
      Number.isFinite(invitationExpiry) && Number.isFinite(battleExpiry)
        ? Math.min(invitationExpiry, battleExpiry)
        : null;
    const boss = await getBoss(item.bossId);
    // A nickname belongs to the peer, who can differ from the battle leader.
    // Do not associate that name with a leader unless the observed IDs agree.
    const leaderVerified =
      Number.isSafeInteger(item.leaderPlayerId) &&
      item.leaderPlayerId > 0 &&
      item.inviterPlayerId === item.leaderPlayerId &&
      item.peerPlayerId === item.leaderPlayerId;
    unique.set(item.invitationId, {
      invitationId: item.invitationId,
      battleId: item.battleId,
      bossId: item.bossId,
      bossName: text(boss?.name) || `Босс №${item.bossId}`,
      ...(Number.isSafeInteger(item.inviterPlayerId) &&
      item.inviterPlayerId > 0 &&
      item.peerPlayerId === item.inviterPlayerId
        ? { inviterPlayerId: item.inviterPlayerId }
        : {}),
      ...(leaderVerified ? { leaderPlayerId: item.leaderPlayerId } : {}),
      ...(leaderVerified && text(item.peerUsername)
        ? { leaderUsername: text(item.peerUsername) }
        : {}),
      sender:
        text(item.peerNickname) ||
        text(item.peerUsername) ||
        "Отправитель не указан",
      expiresAt,
      battleExpiresAt: Number.isFinite(battleExpiry) ? battleExpiry : null,
      available:
        expiresAt !== null &&
        expiresAt > now &&
        normalizeBossBattleStatus(item.battleStatus) === "active",
    });
  }
  return [...unique.values()];
}
