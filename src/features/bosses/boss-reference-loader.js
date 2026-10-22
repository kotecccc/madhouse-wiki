// One shared read/import per visible boss; completed data lives in server SQLite.
export function createBossReferenceLoader({
  readSaved,
  importReference,
  onReference = () => {},
}) {
  const entries = new Map();
  function entry(id) {
    if (!entries.has(id))
      entries.set(id, {
        snapshot: { boss: null, status: "idle" },
        listeners: new Set(),
        read: false,
        attempted: false,
        pending: null,
      });
    return entries.get(id);
  }
  function publish(id, boss, status) {
    const current = entry(id);
    current.snapshot = { boss: boss || current.snapshot.boss, status };
    if (boss) onReference(boss);
    for (const listener of current.listeners) listener();
  }
  function ensure(id, authenticated = false) {
    const current = entry(id);
    if (current.snapshot.boss?.rewardPreviewCaptured)
      return Promise.resolve(current.snapshot.boss);
    if (current.pending)
      return current.pending.then(() =>
        authenticated &&
        !current.attempted &&
        !current.snapshot.boss?.rewardPreviewCaptured
          ? ensure(id, true)
          : current.snapshot.boss,
      );
    if (current.read && (!authenticated || current.attempted))
      return Promise.resolve(current.snapshot.boss);
    current.pending = (async () => {
      if (!current.read) {
        current.read = true;
        try {
          const result = await readSaved(id);
          if (result?.boss) publish(id, result.boss, "ready");
        } catch {
          /* A ready session may still initialize a missing runtime store. */
        }
      }
      if (
        !current.snapshot.boss?.rewardPreviewCaptured &&
        authenticated &&
        !current.attempted
      ) {
        current.attempted = true;
        publish(id, null, "loading");
        try {
          const result = await importReference(id);
          if (!result?.boss?.rewardPreviewCaptured)
            throw new Error("Reference not persisted");
          publish(id, result.boss, "ready");
        } catch {
          publish(id, null, "error");
        }
      }
      return current.snapshot.boss;
    })().finally(() => {
      current.pending = null;
    });
    return current.pending;
  }
  return {
    ensure,
    snapshot: (id) => entry(id).snapshot,
    subscribe(id, listener) {
      entry(id).listeners.add(listener);
      return () => entry(id).listeners.delete(listener);
    },
  };
}
