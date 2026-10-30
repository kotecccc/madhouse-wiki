const activeStatuses = new Set([
  "queued",
  "waiting",
  "running",
  "reconciling",
  "paused",
]);

const itemKey = (type, id) => `${type}:${id}`;

export function inventoryQueueItemKey(item) {
  return itemKey(item?.type, item?.id);
}

export function isInventoryJobActive(job) {
  return Boolean(job?.missing || (job && activeStatuses.has(job.status)));
}

export function inventoryActionConfirmed(item, action) {
  if (!item) return false;
  if (action === "buy") return item.status === "owned";
  if (action === "equip") return item.equipped === true;
  if (action === "unequip") return item.equipped === false;
  return (
    action === "repair" &&
    Number.isFinite(item.durability) &&
    Number.isFinite(item.durabilityMax) &&
    item.durabilityMax > 0 &&
    item.durability === item.durabilityMax &&
    item.isBroken !== true
  );
}

export function inventoryPendingActionForItem(state, item) {
  const pending = state?.equipment?.pending;
  if (!pending) return null;
  const type = pending.type ?? "weapon";
  const id = pending.entityId ?? pending.weaponId;
  if (type !== item?.type || id == null || String(id) !== String(item?.id))
    return null;
  return (
    pending.action ??
    (typeof pending.equip === "boolean"
      ? pending.equip
        ? "equip"
        : "unequip"
      : null)
  );
}

function queueCause(job) {
  const causes = [];
  if (job.reason) causes.push(job.reason);
  const blockerLabels = {
    action: "Ожидает завершения другого действия",
    credentials: "Проверьте игровую сессию",
    dependency: "Ожидает связанное действие",
    game: "Игра временно недоступна",
    rate: "Ожидает следующего разрешённого действия",
    storage: "Серверное хранилище временно недоступно",
  };
  if (job.blockedBy)
    causes.push(blockerLabels[job.blockedBy] ?? "Ожидает освобождения очереди");
  return causes.length ? causes.join(" · ") : null;
}

export function inventoryQueueStatus(job) {
  if (!job) return null;
  switch (job.status) {
    case "queued":
    case "waiting":
      return {
        title: "Ожидает выполнения",
        description: queueCause(job),
      };
    case "running":
      return { title: "Выполняется" };
    case "reconciling":
      return {
        title: "Проверяем результат",
        description:
          queueCause(job) || "Результат действия пока не подтверждён.",
      };
    case "paused":
      return {
        title: "Действие приостановлено",
        description: queueCause(job),
      };
    case "failed":
      return {
        title: "Не удалось выполнить действие",
        description: queueCause(job),
      };
    case "cancelled":
      return { title: "Действие отменено" };
    case "completed":
      return null;
    default:
      return null;
  }
}

export function inventoryJobForItem(state, item, trackedJobId = null) {
  const pending = state?.equipment?.pending;
  const pendingItemId = pending?.entityId ?? pending?.weaponId;
  if (
    pendingItemId != null &&
    (pending.type ?? "weapon") === item?.type &&
    String(pendingItemId) === String(item?.id)
  )
    return {
      missing: true,
      pending: true,
      action: inventoryPendingActionForItem(state, item),
    };
  const jobs = state?.queuedActions;
  if (!Array.isArray(jobs)) return trackedJobId ? { missing: true } : null;
  const matching = jobs.filter(
    (job) =>
      !job.dismissed &&
      job.type === "inventory" &&
      job.args?.type === item?.type &&
      String(job.args?.id) === String(item?.id),
  );
  if (trackedJobId) {
    const tracked = jobs.find((job) => job.id === trackedJobId);
    if (!tracked) return { missing: true };
    if (tracked && activeStatuses.has(tracked.status)) return tracked;
    const active = matching.find((job) => activeStatuses.has(job.status));
    if (active) return active;
    const latest = latestInventoryJob(matching);
    if (latest) return latest.status === "failed" ? latest : null;
    return tracked ? null : { missing: true };
  }
  const active = matching.find((job) => activeStatuses.has(job.status));
  if (active) return active;
  const latest = latestInventoryJob(matching);
  return latest?.status === "failed" ? latest : null;
}

function latestInventoryJob(jobs) {
  return jobs.reduce((latest, job, index) => {
    if (!latest) return { job, index };
    const timestamp = job.finishedAt ?? job.createdAt ?? 0;
    const latestTimestamp = latest.job.finishedAt ?? latest.job.createdAt ?? 0;
    return timestamp > latestTimestamp ||
      (timestamp === latestTimestamp && index > latest.index)
      ? { job, index }
      : latest;
  }, null)?.job;
}

export function inventoryJobStatusForItem(state, item, trackedJobId = null) {
  const job = inventoryJobForItem(state, item, trackedJobId);
  if (job?.missing)
    return {
      uncertain: true,
      canCheck: !job.pending,
      title: "Не удалось проверить результат",
      description: job.pending
        ? "Сервер ещё хранит неопределённую операцию. Дождитесь её сверки; не повторяйте действие."
        : "Проверьте инвентарь. Не повторяйте действие, пока результат не подтверждён.",
    };
  return inventoryQueueStatus(job);
}
