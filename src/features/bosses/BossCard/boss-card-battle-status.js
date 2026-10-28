import { progressPercent } from "../../../lib/progress-percent.js";
import { isTerminalBossBattle } from "../BossBattle/boss-battle-status.js";

export function activeBattleForBoss(state, bossId) {
  const battle = state?.battle;
  if (
    !battle ||
    state?.boss?.id !== bossId ||
    battle.status !== "active" ||
    isTerminalBossBattle(battle)
  )
    return null;
  return battle;
}

export function bossHealthPercent(battle) {
  return progressPercent(battle?.bossHealth, battle?.bossMaxHealth);
}
