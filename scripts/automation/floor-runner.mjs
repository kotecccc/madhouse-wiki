// Coordinates existing durable workers; a lost launch result is never replayed.
export function createFloorRunner({
  saved,
  plan,
  launch,
  observe,
  stopOwned,
  persist,
  now = Date.now,
  priorityActive = () => false,
}) {
  const record = saved
    ? structuredClone(saved)
    : { status: "stopped", phase: "idle", target: null, reason: null };
  let working = false;
  let generation = 0;
  let disposed = false;
  if (record.status === "running" && record.phase === "launching") {
    record.status = "paused";
    record.reason =
      "Запуск цели не подтверждён после перезапуска. Проверьте состояние перед продолжением.";
  }
  const publish = () => {
    if (persist(record) === false) throw new Error("floor_storage_unavailable");
  };
  return {
    getSnapshot: () => record,
    dispose() {
      disposed = true;
      generation++;
    },
    start() {
      if (
        working ||
        record.status === "running" ||
        record.phase === "launching"
      )
        throw new Error("floor_run_active");
      generation++;
      Object.assign(record, {
        status: "running",
        phase: "planning",
        target: null,
        lastCompleted: null,
        reason: null,
        startedAt: now(),
        nextCheckAt: 0,
      });
      publish();
    },
    stop() {
      generation++;
      record.status = "stopped";
      if (record.phase === "launching") {
        record.reason =
          "Запуск цели не подтверждён; повторная отправка остановлена.";
      } else {
        record.phase = "idle";
        record.reason = null;
      }
      try {
        publish();
      } finally {
        stopOwned(record.target);
      }
    },
    async tick() {
      if (
        disposed ||
        working ||
        record.status !== "running" ||
        now() < (record.nextCheckAt ?? 0)
      )
        return;
      const current = generation;
      const valid = () =>
        !disposed && current === generation && record.status === "running";
      working = true;
      try {
        if (record.phase === "executing") {
          const state = await observe(record.target);
          if (!valid()) return;
          if (state === "running") {
            record.nextCheckAt = now() + 15000;
            publish();
            return;
          }
          if (state !== "completed" && state !== "partial") {
            record.status = "paused";
            record.reason =
              "Цель остановилась или её результат не подтверждён.";
            publish();
            return;
          }
          record.lastCompleted =
            state === "partial"
              ? { ...record.target, required: record.target.current + 1 }
              : record.target;
          record.phase = "planning";
          record.target = null;
          publish();
        }
        const next = await plan();
        if (!valid() || priorityActive()) return;
        if (next.status !== "ready") {
          record.reason = next.reason;
          record.nextCheckAt = now() + 60000;
          publish();
          return;
        }
        if (
          record.lastCompleted?.kind === next.kind &&
          record.lastCompleted?.apiId === next.apiId &&
          next.current < record.lastCompleted.required
        ) {
          record.reason =
            "Ожидаем подтверждения прогресса после завершённой цели.";
          record.nextCheckAt = now() + 60000;
          publish();
          return;
        }
        record.lastCompleted = null;
        record.target = next;
        record.phase = "launching";
        record.reason = null;
        publish();
        if (!valid()) return;
        await launch(next, valid);
        if (!valid()) {
          stopOwned(next);
          return;
        }
        record.phase = "executing";
        record.nextCheckAt = now() + 15000;
        publish();
      } catch {
        if (valid()) {
          if (record.phase === "launching") {
            record.status = "paused";
            record.reason =
              "Запуск цели не подтверждён; повторная отправка остановлена.";
          } else {
            record.reason =
              "Не удалось обновить данные игры. Повторим проверку.";
            record.nextCheckAt = now() + 60000;
          }
          publish();
        }
      } finally {
        working = false;
      }
    },
  };
}
