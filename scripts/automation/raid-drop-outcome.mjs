import { bossDropIdentity } from "../../src/features/bosses/BossBattle/boss-battle-reference.js";
import { isShopGoalDrop } from "../../src/features/bosses/BossBattle/boss-goal-options.js";
import { isTerminalBossBattle } from "../../src/features/bosses/BossBattle/boss-battle-status.js";

export function raidDropOutcome(subscription, battle) {
  if (!subscription.enabled || !subscription.dropKeys?.length)
    return "finished";
  if (
    !battle ||
    battle.id !== subscription.battleId ||
    !isTerminalBossBattle(battle)
  )
    return "uncertain";
  if (battle.status !== "won") return "finished";
  if (!battle.rewardKnown || battle.rewardFlagsKnown !== true)
    return "reward_unknown";
  if (
    !Array.isArray(battle.grantedDrops) ||
    battle.grantedDrops.some(
      (drop) => typeof drop?.type !== "string" || !drop.type,
    )
  )
    return "uncertain";
  const drops = battle.grantedDrops.filter(isShopGoalDrop);
  if (drops.some((drop) => !bossDropIdentity(drop))) return "uncertain";
  return drops.some((drop) =>
    subscription.dropKeys.includes(bossDropIdentity(drop)),
  )
    ? "finished_drop"
    : "finished";
}
