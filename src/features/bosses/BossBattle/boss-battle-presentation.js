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

export function isBossAutomationWaiting(state, auto = {}) {
  const raid =
    state.raid?.enabled &&
    (state.raid.bossId == null ||
      Number(state.raid.bossId) === Number(state.boss?.id));
  return Boolean((raid || auto.enabled) && state.battle?.status !== "active");
}

export function bossAutomationEligible(state) {
  return Boolean(
    state.boss &&
    !state.pending &&
    !state.pendingInvitation &&
    !state.purchase &&
    !state.purchaseUncertain &&
    !state.medicineOpen,
  );
}

export function formatBattleCompletedAt(battle) {
  if (!Number.isFinite(battle?.completedAt)) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(battle.completedAt));
}

export function bossExecutionStatus(state, auto = {}) {
  const raid =
    state.raid?.enabled &&
    (state.raid.bossId == null ||
      Number(state.raid.bossId) === Number(state.boss?.id));
  if (state.battle?.status === "active")
    return { label: "Идёт бой", variant: "active" };
  if (raid)
    return {
      label: state.pendingInvitation
        ? "Проверяем вступление"
        : "Ждём приглашений",
      variant: "scheduled",
    };
  if (auto.enabled) return { label: "Ждём боя", variant: "scheduled" };
  if (state.battle?.status === "won")
    return { label: "Победа", variant: "completed" };
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
