import { useEffect, useState, useSyncExternalStore } from "react";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { bossBattle } from "../BossBattle/boss-battle-session.js";
import { formatBattleCountdown } from "../BossBattle/boss-battle-presentation.js";
import { activeBattleForBoss } from "./boss-card-battle-status.js";

export function BossBattleStatus({ bossId, className }) {
  const state = useSyncExternalStore(
    bossBattle.subscribe,
    bossBattle.getSnapshot,
    bossBattle.getSnapshot,
  );
  const battle = activeBattleForBoss(state, bossId);
  const expiresAt = battle?.expiresAt;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt == null) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  if (!battle) return null;
  const expired = battle.expiresAt != null && battle.expiresAt <= now;
  const countdown = expired
    ? null
    : formatBattleCountdown(battle.expiresAt, now);
  const label = expired
    ? "Время истекло"
    : `Идёт${countdown ? ` · ${countdown}` : ""}`;

  return (
    <Pill
      className={className}
      variant={expired ? "scheduled" : "active"}
      size="xs"
      dot={!expired}
      title={countdown ? `До окончания боя: ${countdown}` : label}
      aria-label={label}
    >
      {label}
    </Pill>
  );
}
