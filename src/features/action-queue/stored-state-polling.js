const pendingStatus = new Set(["queued", "waiting", "running", "reconciling"]);

export function storedQueuePresence(saved) {
  if (saved?.presence === "present") return "present";
  if (saved?.presence === "missing" || saved?.snapshotStatus === "missing")
    return "missing";
  return "unknown";
}

/** Poll only the local stored-state API while this consumer remains active. */
export function startStoredStatePolling({
  readStored,
  onPresent,
  onMissing,
  onUnavailable,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let stopped = false;
  let timer;
  let generation = 0;

  const schedule = (delay) => {
    if (!stopped) timer = setTimer(poll, delay);
  };

  async function poll() {
    const startedAt = generation;
    try {
      const saved = await readStored();
      if (stopped) return;
      if (startedAt !== generation) {
        schedule(15000);
        return;
      }
      if (saved?.presence === "present") {
        if (!Array.isArray(saved.data?.queuedActions)) {
          onUnavailable(new Error("invalid_stored_queue"));
          schedule(15000);
          return;
        }
        onPresent(saved.data);
        schedule(
          saved.data?.queuedActions?.some((job) =>
            pendingStatus.has(job.status),
          )
            ? 3000
            : 15000,
        );
      } else {
        onMissing(saved);
        schedule(15000);
      }
    } catch (error) {
      if (stopped) return;
      if (startedAt !== generation) {
        schedule(15000);
        return;
      }
      if (error?.status === 404)
        onMissing({ presence: "unknown", snapshotStatus: "missing" });
      else onUnavailable(error);
      schedule(15000);
    }
  }

  void poll();
  return {
    invalidate() {
      generation += 1;
    },
    stop() {
      stopped = true;
      clearTimer(timer);
    },
  };
}
