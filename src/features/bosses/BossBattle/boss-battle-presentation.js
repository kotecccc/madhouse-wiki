import { isTerminalBossBattle } from "./boss-battle-status.js";

export function healingErrorNotice(notice) {
  return [
    "Лечимся…",
    "Покупаем одну аптечку…",
    "Результат удара проверяется. Автоматического повтора не будет.",
  ].includes(notice)
    ? null
    : notice || null;
}

export function canQueueBossBattleStart(
  state,
  { preview = false, automationRunning = false } = {},
) {
  return Boolean(
    !preview &&
    !automationRunning &&
    !state.invitationOnly &&
    !state.pending &&
    !state.needsRefresh &&
    !state.purchase &&
    !state.purchaseUncertain &&
    !state.queuedBattleActions?.some((job) => job.type === "battle.start") &&
    (state.battle ? isTerminalBossBattle(state.battle) : state.canStart),
  );
}

export function queuedBattleAction(state, type, battleId) {
  const actions =
    (state.manualBattleActionJobs?.length
      ? state.manualBattleActionJobs
      : state.queuedBattleActions
    )?.filter(
      (job) =>
        job.type === type &&
        (job.args?.bossId == null ||
          Number(job.args.bossId) === Number(state.boss?.id)) &&
        (battleId == null || job.args?.battleId === battleId),
    ) ?? [];
  return (
    actions.find((job) => job.status === "reconciling") ?? actions[0] ?? null
  );
}

export function queuedBattleActionNotice(job) {
  if (!job) return null;
  const reasonMessages = {
    unsent_retry_budget:
      "Повтор остановлен после подтверждённых неотправленных попыток.",
    battle_finished: "Этот бой уже завершён.",
    unknown_boss: "Босс недоступен.",
    game_request_rejected: "Игровой сервер отклонил действие.",
    dependency_failed: "Предыдущее действие не выполнено.",
    game_session_required: "Требуется войти в игру.",
    work_result_unresolved: "Результат предыдущего действия не подтверждён.",
  };
  const blockMessages = {
    credentials: "Требуется войти в игру.",
    storage: "Ожидаем доступности сервера.",
    action: "Ожидаем завершения других действий.",
    dependency: "Ожидаем подтверждения предыдущего действия.",
    game: "Ожидаем доступности игры.",
    rate: "Ожидаем окончания ограничения запросов.",
  };
  const reason =
    reasonMessages[job.reason] ||
    job.reason ||
    blockMessages[job.blockedBy] ||
    null;
  const displayedReason =
    typeof reason === "string" && /^[a-z0-9_]+$/.test(reason)
      ? "Действие остановлено. Подробности доступны в очереди."
      : reason;
  if (job.status === "reconciling")
    return `Результат действия не подтверждён. ${displayedReason || "Проверяем состояние игры."} Повтор не будет отправлен до подтверждения.`;
  if (job.status === "paused")
    return displayedReason || "Действие приостановлено. Проверьте очередь.";
  if (job.status === "failed")
    return displayedReason || "Действие остановлено. Проверьте очередь.";
  if (displayedReason) return displayedReason;
  if (job.status === "queued") return "Действие ожидает отправки в игру.";
  if (job.status === "waiting")
    return "Ожидаем возможности выполнить действие.";
  if (job.status === "running") return "Действие выполняется.";
  return null;
}

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
  const parts = new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(battle.completedAt));
  const values = Object.fromEntries(
    parts.map(({ type, value }) => [type, value]),
  );
  return `${values.hour}:${values.minute} ${values.day}.${values.month}`;
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
  if (auto.enabled && !state.battle && state.unavailableReason)
    return { label: "Босс недоступен", variant: "locked" };
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
