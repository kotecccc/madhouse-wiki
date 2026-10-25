export const BOSS_BATTLE_OUTCOMES = {
  won: "Победа",
  lost: "Поражение",
  expired: "Время боя истекло",
  surrendered: "Бой завершён сдачей",
};

// The shipped boss scene accepts timed_out and presents it as expired.
export function normalizeBossBattleStatus(value) {
  const status = typeof value === "string" ? value.trim().toLowerCase() : "";
  return status === "timed_out" ? "expired" : status;
}
export function isTerminalBossBattle(battle) {
  return Object.hasOwn(
    BOSS_BATTLE_OUTCOMES,
    normalizeBossBattleStatus(battle?.status),
  );
}
