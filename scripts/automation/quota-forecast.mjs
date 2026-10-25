// Advisory estimate only. Independent participants can change their pace at any
// moment, so this never authorizes speeding up or guarantees a drop.
export function forecastQuota(battle, samples = [], now = Date.now()) {
  if (
    !battle ||
    battle.dropDamageRequired == null ||
    battle.totalDamage == null
  )
    return null;
  const remaining = Math.max(0, battle.dropDamageRequired - battle.totalDamage);
  if (remaining === 0)
    return { remaining, hitsNeeded: 0, secondsNeeded: 0, atRisk: false };
  const valid = samples
    .filter(
      (s) =>
        s.battleId === battle.id &&
        s.participantCount === battle.participantCount &&
        s.at <= now,
    )
    .slice(-12);
  const hits = valid
    .map((s) => s.ownHit)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (hits.length < 2)
    return {
      remaining,
      hitsNeeded: null,
      secondsNeeded: null,
      atRisk: battle.bossHealth < remaining,
    };
  const hitsNeeded = Math.ceil(remaining / Math.min(...hits));
  const cooldown = Math.max(...valid.map((s) => s.cooldownMs ?? 0));
  const secondsNeeded = Math.ceil(
    (Math.max(0, battle.readyAt - now) +
      Math.max(0, hitsNeeded - 1) * (cooldown + 4000) +
      Math.ceil(hitsNeeded / 5) * 10000) /
      1000,
  );
  const rates = [];
  for (let i = 1; i < valid.length; i++) {
    const a = valid[i - 1],
      b = valid[i];
    if (
      b.at - a.at < 1000 ||
      b.bossHealth > a.bossHealth ||
      b.totalDamage < a.totalDamage
    )
      continue;
    rates.push((a.bossHealth - b.bossHealth) / ((b.at - a.at) / 1000));
  }
  const rate = Math.max(0, ...rates);
  const secondsLeft = rate > 0 ? Math.floor(battle.bossHealth / rate) : null;
  const expiry =
    battle.expiresAt == null
      ? null
      : Math.max(0, (battle.expiresAt - now) / 1000);
  return {
    remaining,
    hitsNeeded,
    secondsNeeded,
    secondsLeft,
    atRisk:
      battle.bossHealth < remaining ||
      (secondsLeft != null && secondsNeeded * 1.5 >= secondsLeft) ||
      (expiry != null && secondsNeeded >= expiry),
  };
}
