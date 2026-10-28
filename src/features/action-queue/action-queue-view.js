import { workFarmProgress } from "../works/WorkFarm/work-farm-presentation.js";
import { actionQueuePriority } from "../../lib/action-queue-priority.js";

const visible = new Set([
  "queued",
  "waiting",
  "running",
  "reconciling",
  "paused",
  "failed",
  "completed",
]);
const phases = {
  queued: "В очереди",
  waiting: "Ожидает игру",
  running: "Выполняется",
  reconciling: "Проверяем результат",
  paused: "На паузе",
  failed: "Остановлено",
  completed: "Выполнено",
};
const handoffTypes = new Set([
  "work.start",
  "character.start",
  "business.start",
  "floor.start",
  "auto.start",
  "raid.start",
  "subscription.start",
]);
const failureMessages = {
  game_request_rejected: "Игра отклонила запрос",
  dependency_failed: "Предыдущее действие не выполнено",
  game_session_required: "Требуется вход",
  inventory_price_changed: "Цена изменилась",
  inventory_balance_insufficient: "Недостаточно средств",
  inventory_balance_unknown: "Баланс неизвестен",
  inventory_item_not_buyable: "Предмет недоступен",
  inventory_item_not_owned: "Предмет отсутствует",
  inventory_equipment_changed: "Экипировка изменилась",
  inventory_weapon_broken: "Оружие сломано",
  inventory_action_failed: "Игра отклонила действие",
  work_booster_unavailable: "Дефибриллятор недоступен",
  friend_leader_unverified: "Ведущий не подтверждён",
  too_many_friend_requests: "Слишком много заявок",
  unknown_boss: "Босс недоступен",
  battle_finished: "Бой завершён",
  healing_not_needed: "Здоровье восстановлено",
  healing_unavailable: "Аптечка отсутствует",
  healing_limit: "Лимит аптечек исчерпан",
  healing_budget: "Лимит покупки исчерпан",
  invitation_expired: "Приглашение недоступно",
  business_stock_changed: "План изменился",
  business_missing_unknown: "Проверьте план бизнеса",
  business_run_limit_required: "Не указан лимит сбора",
  invalid_automation_goal: "Проверьте цель боя",
  character_upgrade_quote_changed: "Стоимость или лимит изменились",
};
const actions = {
  buy: "Покупка",
  equip: "Экипировка",
  unequip: "Снять",
  repair: "Ремонт",
};

// These cards project existing account actors; they do not own progress.
export function actionQueueCards(state, catalogue = {}) {
  if (!state) return [];
  const cards = [];
  const addActor = (key, title, command, detail, progress, image) =>
    cards.push({
      id: key,
      title,
      status: detail || "Выполняется",
      command,
      progress,
      image,
      actor: true,
      destination: key,
    });
  const floor = state.floorRunner;
  const business = state.businessAssistant?.run;
  const work = state.workFarm?.run;
  const character = state.characterUpgrade?.run;
  const raid = state.raid;
  const subscription = state.subscription;
  const buddy = state.buddy;
  if (subscription?.enabled || subscription?.hasSuspendedGoal)
    addActor(
      "subscription",
      "Подписка на рейды",
      subscription.enabled ? "subscription.stop" : null,
      subscription.enabled ? null : "Завершаем рейд",
    );
  if (subscription?.enabled || subscription?.hasSuspendedGoal)
    cards.at(-1).raidTarget = {
      leaderPlayerId: subscription.leaderPlayerId ?? null,
      leaderUsername: subscription.leaderUsername ?? "",
      bossId: subscription.bossId ?? null,
    };
  if (buddy?.enabled || buddy?.hasSuspendedGoal)
    addActor(
      "buddy",
      "Помощь Buddy",
      buddy.enabled ? "buddy.stop" : null,
      buddy.enabled ? null : "Завершаем рейд",
    );
  if (buddy?.enabled || buddy?.hasSuspendedGoal) cards.at(-1).focusBuddy = true;
  if (subscription?.suspendedAuto || buddy?.suspendedAuto)
    addActor("auto", "Автобой", "auto.stop", "Ожидает рейд");
  if (subscription?.suspendedStandaloneGoal || buddy?.suspendedStandaloneGoal)
    addActor("goal", "Цель боя", "goal.stop", "Ожидает рейд");
  if (floor?.status === "running" || floor?.status === "paused")
    addActor(
      "floor",
      "Открытие этажа",
      "floor.stop",
      floor.reason || (floor.status === "paused" ? "Приостановлено" : null),
    );
  if (floor?.status === "running" || floor?.status === "paused")
    cards.at(-1).floorTarget = floor.target ?? null;
  else {
    if (raid?.enabled || raid?.userPaused) {
      addActor(
        "raid",
        "Рейды",
        "raid.stop",
        raid.resumeRequested
          ? "Продолжаем"
          : raid.userPaused
            ? "На паузе"
            : raid.stopAfterBattle
              ? "Завершает бой"
              : raid.notice === "Ожидаем выполнение работёнки."
                ? "Ожидает фарм"
                : null,
      );
      if (subscription?.hasSuspendedGoal || buddy?.hasSuspendedGoal) {
        cards.at(-1).status = "Ожидает рейд";
      } else if (!raid.resumeRequested && !raid.stopAfterBattle) {
        cards.at(-1).pauseCommand = raid.userPaused
          ? "raid.resume"
          : "raid.pause";
      }
    }
    if (["running", "paused"].includes(business?.status)) {
      addActor(
        "business",
        business.name || "Прокачка бизнеса",
        "business.run.stop",
        business.resumeRequested
          ? "Продолжаем"
          : business.status === "paused"
            ? "На паузе"
            : business.phase === "retrying"
              ? "Ожидает игру"
              : null,
      );
      cards.at(-1).businessId = business.businessId;
      if (subscription?.hasSuspendedGoal || buddy?.hasSuspendedGoal) {
        cards.at(-1).status = "Ожидает рейд";
      } else if (!business.resumeRequested && !business.stopRequested)
        cards.at(-1).pauseCommand =
          business.status === "paused"
            ? "business.run.resume"
            : "business.run.pause";
    } else if (
      !(raid?.enabled || raid?.userPaused) &&
      !subscription?.hasSuspendedGoal &&
      !buddy?.hasSuspendedGoal &&
      (state.auto?.enabled || state.auto?.userPaused)
    ) {
      const boss = state.battle?.boss;
      const goal = state.goal;
      const progress =
        Number.isFinite(goal?.progress) &&
        Number.isFinite(goal?.target) &&
        goal.target > 0
          ? { value: goal.progress, max: goal.target }
          : null;
      addActor(
        "auto",
        boss?.nameRu || boss?.name || "Автобой",
        "auto.stop",
        state.auto?.resumeRequested
          ? "Продолжаем"
          : state.auto?.userPaused
            ? "На паузе"
            : state.auto?.phase === "yielding"
              ? "Ожидает фарм"
              : null,
        progress,
        boss?.image,
      );
      const card = cards.at(-1);
      if (!state.auto?.resumeRequested)
        card.pauseCommand = state.auto?.userPaused
          ? "auto.resume"
          : "auto.pause";
    } else if (
      !(raid?.enabled || raid?.userPaused) &&
      !subscription?.hasSuspendedGoal &&
      !buddy?.hasSuspendedGoal &&
      state.goal?.status === "active"
    ) {
      addActor("goal", "Цель боя", "goal.stop", "Ожидает запуска");
    }
    if (
      ["running", "paused"].includes(work?.status) ||
      (work?.status === "stopped" && work.pending)
    ) {
      const ref = catalogue.works?.find(
        (item) =>
          Number(item.workId ?? item.numericId ?? item.apiId) === work.workId,
      );
      const view = state.workFarm?.view;
      const progress =
        work.queuedCycles == null &&
        (work.config?.mode === "energy" ||
          (view && view.workId === work.workId && Array.isArray(view.tasks)))
          ? workFarmProgress(work, view)
          : null;
      addActor(
        "work",
        ref?.title ||
          ref?.nameRu ||
          ref?.name ||
          work.title ||
          "Фарм работёнки",
        "work.stop",
        work.status === "paused"
          ? "На паузе"
          : work.phase === "waiting"
            ? "Ожидает энергию"
            : work.phase === "retrying"
              ? "Ожидает игру"
              : work.phase === "queued"
                ? "Ожидает другие действия"
                : null,
        progress?.max != null
          ? { value: progress.value, max: progress.max }
          : null,
        ref?.image,
      );
      const card = cards.at(-1);
      card.work = ref;
      if (work.status === "stopped") {
        card.status = "Проверяем результат";
        card.command = null;
      } else if (subscription?.hasSuspendedGoal || buddy?.hasSuspendedGoal) {
        card.status = "Ожидает рейд";
      } else {
        card.pauseCommand =
          work.status === "paused" ? "work.resume" : "work.pause";
      }
    }
  }
  if (
    character?.status === "running" ||
    character?.status === "uncertain" ||
    (character?.status === "stopped" &&
      character?.id != null &&
      state.characterUpgrade?.pending?.runId === character?.id)
  )
    addActor(
      "character",
      "Прокачка характеристик",
      ["stopped", "uncertain"].includes(character.status)
        ? null
        : "character.stop",
      character.status === "uncertain" || character.phase === "reconciling"
        ? "Проверяем результат"
        : character.phase === "waiting"
          ? "Ожидает игру"
          : null,
      Number.isFinite(character.completed) &&
        Number.isFinite(character.target) &&
        character.target > 0
        ? { value: character.completed, max: character.target }
        : null,
    );
  const time = state.serverTime ?? Date.now();
  const ready = (job) =>
    ["queued", "waiting", "reconciling"].includes(job.status) &&
    job.eligible !== false &&
    !job.blockedBy &&
    (job.nextAt ?? 0) <= time;
  const terminalActor = (job) => {
    const actor =
      job.type === "work.start"
        ? work
        : job.type === "character.start"
          ? character
          : job.type === "business.start"
            ? business
            : job.type === "floor.start"
              ? floor
              : null;
    if (
      actor?.queueId !== job.id ||
      !["completed", "limited", "stopped", "error"].includes(actor.status) ||
      actor.pending ||
      actor.pendingUpgrade ||
      (job.type === "character.start" && state.characterUpgrade?.pending)
    )
      return null;
    return actor;
  };
  const recentCompleted = new Set(
    (state.queuedActions || [])
      .filter((job) => job.status === "completed" && !job.dismissed)
      .sort(
        (a, b) => (a.finishedAt ?? a.createdAt) - (b.finishedAt ?? b.createdAt),
      )
      .slice(-5)
      .map((job) => job.id),
  );
  const queued = (state.queuedActions || [])
    .filter(
      (job) =>
        visible.has(job.status) &&
        !job.dismissed &&
        (job.status !== "completed" ||
          recentCompleted.has(job.id) ||
          terminalActor(job)) &&
        !(job.type === "auto.start" && state.auto?.queueId === job.id) &&
        !(job.type === "raid.start" && state.raid?.queueId === job.id) &&
        !(
          job.type === "business.start" &&
          business?.queueId === job.id &&
          !terminalActor(job)
        ) &&
        !(
          job.type === "floor.start" &&
          floor?.queueId === job.id &&
          !terminalActor(job)
        ) &&
        !(
          job.type === "work.start" &&
          work?.queueId === job.id &&
          !terminalActor(job)
        ) &&
        !(
          job.type === "character.start" &&
          character?.queueId === job.id &&
          !terminalActor(job)
        ) &&
        !(
          job.type === "subscription.start" && subscription?.queueId === job.id
        ),
    )
    .sort(
      (a, b) =>
        Number(ready(b)) - Number(ready(a)) ||
        actionQueuePriority(b, time) - actionQueuePriority(a, time) ||
        a.createdAt - b.createdAt,
    );
  let position = 0;
  for (const job of queued) {
    const finishedActor = terminalActor(job);
    const validDeadline = (value) =>
      Number.isFinite(value) && value > 0 && value <= 8_640_000_000_000_000;
    const retryDeadline = Math.max(
      validDeadline(job.nextAt) ? job.nextAt : 0,
      validDeadline(state.queueNotBefore) ? state.queueNotBefore : 0,
    );
    const item = catalogue.inventoryItems?.find(
      (ref) =>
        ref.type === job.args?.type &&
        Number(ref.id) === job.args.id &&
        (ref.type !== "ornament" || ref.zoneId === job.args.zoneId),
    );
    const queuedWork = ["work.start", "work.booster"].includes(job.type)
      ? catalogue.works?.find(
          (ref) =>
            Number(ref.workId ?? ref.numericId ?? ref.apiId) ===
            job.args.workId,
        )
      : null;
    const bossId = job.args?.bossId ?? job.args?.settings?.bossId;
    const queuedBoss = catalogue.bosses?.find(
      (ref) =>
        String(ref.id) === String(bossId) ||
        Number(ref.numericId ?? ref.apiId) === Number(bossId),
    );
    cards.push({
      id: job.id,
      title:
        job.type === "character.start"
          ? "Прокачка характеристик"
          : job.type === "subscription.start"
            ? "Подписка на рейды"
            : job.type === "work.start"
              ? queuedWork?.title ||
                queuedWork?.nameRu ||
                queuedWork?.name ||
                "Фарм работёнки"
              : job.type === "floor.start"
                ? "Открытие этажа"
                : job.type === "auto.start"
                  ? "Автобой"
                  : job.type === "raid.start"
                    ? "Рейды"
                    : job.type === "business.start"
                      ? "Прокачка бизнеса"
                      : job.type === "invitation.accept"
                        ? "Принять приглашение"
                        : job.type === "battle.buy"
                          ? "Покупка аптечек"
                          : job.type === "battle.heal"
                            ? "Лечение"
                            : job.type === "battle.attack"
                              ? "Удар по боссу"
                              : job.type === "battle.start"
                                ? "Нападение на босса"
                                : job.type === "friend.request"
                                  ? job.args.username
                                    ? `@${job.args.username}`
                                    : "Ведущий рейда"
                                  : [
                                        "friend.remove",
                                        "friend.favorite",
                                        "friend.buddy",
                                      ].includes(job.type)
                                    ? job.args.name || "Друг"
                                    : job.type === "work.booster"
                                      ? "Дефибриллятор"
                                      : item?.name ||
                                        actions[job.args?.action] ||
                                        "Действие",
      status:
        job.status === "completed"
          ? finishedActor
            ? {
                completed: "Выполнено",
                limited: "Достигнут лимит",
                stopped: "Остановлено",
                error: "Не удалось выполнить",
              }[finishedActor.status]
            : handoffTypes.has(job.type)
              ? "Передано исполнителю"
              : phases.completed
          : job.status === "failed" && job.reason === "dependency_failed"
            ? failureMessages.dependency_failed
            : state.gameHealth?.status === "credentials_invalid" ||
                job.reason === "game_session_required"
              ? "Требуется вход"
              : job.cancelRequested
                ? "Ожидаем результат"
                : job.status === "failed"
                  ? failureMessages[job.reason] || "Не удалось выполнить"
                  : job.reason === "Ожидаем приглашение."
                    ? "Ожидает приглашение"
                    : job.status === "running"
                      ? phases.running
                      : job.blockedBy === "credentials"
                        ? "Требуется вход"
                        : job.blockedBy === "storage"
                          ? "Ожидает сервер"
                          : job.blockedBy === "action"
                            ? "Ожидает другие действия"
                            : job.blockedBy === "dependency"
                              ? "Ожидает подтверждения действия"
                              : job.blockedBy === "game"
                                ? "Ожидает игру"
                                : job.blockedBy === "rate"
                                  ? "Ожидает очередь"
                                  : job.eligible === false
                                    ? [
                                        "work.booster",
                                        "work.start",
                                        "character.start",
                                        "subscription.start",
                                        "battle.start",
                                        "battle.attack",
                                        "battle.heal",
                                        "battle.buy",
                                        "invitation.accept",
                                        "business.start",
                                        "floor.start",
                                        "auto.start",
                                        "raid.start",
                                      ].includes(job.type)
                                      ? "Ожидает другие действия"
                                      : "Ожидает окончания боя"
                                    : phases[job.status] || "Ожидание",
      detail:
        job.type === "character.start"
          ? job.args.quotes
              ?.map(
                (quote) =>
                  ({
                    madness: "Безумие",
                    aggression: "Агрессия",
                    rage: "Ярость",
                  })[quote.stat],
              )
              .filter(Boolean)
              .join(", ") || null
          : job.type === "subscription.start"
            ? job.args.leaderUsername
              ? `@${job.args.leaderUsername}`
              : null
            : job.type === "friend.request"
              ? "Заявка в друзья"
              : job.type === "friend.favorite"
                ? job.args.enabled
                  ? "В избранное"
                  : "Убрать из избранного"
                : job.type === "friend.buddy"
                  ? job.args.enabled
                    ? "Добавить в Buddy"
                    : "Убрать из Buddy"
                  : job.type === "friend.remove"
                    ? "Удаление друга"
                    : job.type === "work.booster"
                      ? job.args.type === "full"
                        ? "Полный"
                        : "Малый"
                      : queuedBoss?.name
                        ? queuedBoss.name
                        : item?.name
                          ? actions[job.args?.action]
                          : null,
      image: queuedWork?.image || queuedBoss?.image || item?.image,
      destination: job.type,
      inventoryTarget:
        job.type === "inventory"
          ? { type: job.args?.type, id: job.args?.id }
          : null,
      work: queuedWork,
      businessId: job.args?.businessId,
      bossId,
      raidTarget:
        job.type === "subscription.start"
          ? {
              leaderPlayerId: job.args?.leaderPlayerId ?? null,
              leaderUsername: job.args?.leaderUsername ?? "",
              bossId: job.args?.bossId ?? null,
            }
          : job.type === "friend.request"
            ? {
                leaderPlayerId: job.args?.playerId ?? null,
                leaderUsername: job.args?.username ?? "",
                bossId: null,
              }
            : null,
      friendTarget: [
        "friend.remove",
        "friend.favorite",
        "friend.buddy",
      ].includes(job.type)
        ? { playerId: job.args?.playerId ?? null }
        : null,
      floorTarget: job.type === "floor.start" ? (floor?.target ?? null) : null,
      command:
        job.status === "completed"
          ? "queue.dismiss"
          : job.cancelRequested
            ? null
            : "queue.cancel",
      retryAt:
        ["queued", "waiting", "reconciling"].includes(job.status) &&
        retryDeadline > time &&
        !["credentials", "storage", "dependency"].includes(job.blockedBy) &&
        job.reason !== "game_session_required" &&
        state.gameHealth?.status !== "credentials_invalid"
          ? retryDeadline
          : null,
      retryIsReconciliation: job.status === "reconciling",
      position: ready(job) ? ++position : null,
      actor: false,
    });
  }
  return cards;
}
