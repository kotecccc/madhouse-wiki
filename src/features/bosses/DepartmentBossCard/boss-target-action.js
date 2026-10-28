import { remainingBossWins } from "./boss-target-status.js";

export function bossTargetAction(boss, targets) {
  const bossId = Number(boss?.numericId ?? boss?.apiId);
  const kills = (targets ?? []).filter(
    (target) => target.category === "bosses",
  );
  const remaining = remainingBossWins(kills);
  if (!Number.isSafeInteger(bossId) || bossId <= 0 || !remaining) return null;
  return {
    remaining,
    settings: {
      bossId,
      kind: "battles",
      targetCount: remaining,
      countWins: true,
      durationHours: null,
      maxAttempts: null,
    },
  };
}

export function battleCountLabel(count) {
  const lastTwo = count % 100;
  const last = count % 10;
  const word =
    lastTwo >= 11 && lastTwo <= 14
      ? "боёв"
      : last === 1
        ? "бой"
        : last >= 2 && last <= 4
          ? "боя"
          : "боёв";
  return `${count} ${word}`;
}
