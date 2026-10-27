// The floor runner owns the durable work; this intent only starts it once.
export function queuedFloorRunAdapter({ entry }) {
  const started = (job) => entry.floorRunner.hasStarted(job.id);
  return {
    validate: () => ({}),
    dedupeKey: () => "floor",
    async execute(job, { canDispatch }) {
      if (started(job)) return { status: "completed" };
      if (!canDispatch() || entry.floorActions.hasOtherWork())
        return { status: "retry", reason: "Ожидаем другие действия." };
      try {
        entry.floorRunner.start({ queueId: job.id });
        return { status: "completed" };
      } catch (error) {
        if (error.message === "floor_run_active")
          return { status: "retry", reason: "Ожидаем другие действия." };
        return { status: "uncertain", reason: "Проверяем результат." };
      }
    },
    async reconcile(job) {
      return started(job) ? { status: "completed" } : { status: "retry" };
    },
  };
}
