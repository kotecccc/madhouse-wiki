export function formatBattleCountdown(expiresAt, now) {
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now)) return null;
  const total = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours ? `${hours}:${clock}` : clock;
}

const eventFields = [
  "localKey",
  "isSelf",
  "kind",
  "invitedCount",
  "invitedBySelf",
  "confirmed",
  "turn",
  "at",
  "actor",
  "damage",
  "critical",
  "itemType",
  "healthRestored",
];
export function sameBattleEvent(left, right) {
  return (
    left === right ||
    Boolean(
      left && right && eventFields.every((key) => left[key] === right[key]),
    )
  );
}
export function sameBattleEvents(left, right) {
  return (
    left === right ||
    (left.length === right.length &&
      left.every((event, index) => sameBattleEvent(event, right[index])))
  );
}

export function bossExecutionStatus(state, auto = {}) {
  const raid =
    state.raid?.enabled &&
    (state.raid.bossId == null ||
      Number(state.raid.bossId) === Number(state.boss?.id));
  if (state.battle?.status === "active")
    return { label: "Бой идёт", variant: "active" };
  if (raid && state.raid.status === "joining")
    return { label: "Вступаем в бой", variant: "scheduled" };
  if (state.battle?.status === "won")
    return state.battle.rewardKnown === true
      ? { label: "Победа", variant: "completed" }
      : { label: "Получаем награду", variant: "scheduled" };
  if (raid && state.raid.status === "waiting_confirmation")
    return {
      label: state.pendingInvitation ? "Проверяем вступление" : "Обновляем бой",
      variant: "scheduled",
    };
  if (raid) return { label: "Ждём приглашения", variant: "scheduled" };
  if (auto.enabled)
    return { label: "Ждём следующего боя", variant: "scheduled" };
  if (state.battle?.status === "lost")
    return { label: "Поражение", variant: "locked" };
  if (state.battle) return { label: "Бой завершён", variant: "unknown" };
  return null;
}

export function goalProgressPresentation(goal, now) {
  if (goal?.status !== "active") return null;
  const icon =
    goal.kind === "business_items"
      ? "business"
      : goal.kind === "drops"
        ? "loot"
        : goal.kind === "time"
          ? "timer"
          : "combat";
  const progress =
    goal.kind === "time"
      ? null
      : `${goal.progress ?? 0} из ${goal.target ?? goal.targetCount ?? 0}`;
  const timer =
    goal.deadlineAt != null
      ? formatBattleCountdown(goal.deadlineAt, now)
      : goal.remainingSeconds != null
        ? formatBattleCountdown(goal.remainingSeconds * 1000, 0)
        : null;
  return { icon, progress, timer };
}
