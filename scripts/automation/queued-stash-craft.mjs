import { randomUUID } from "node:crypto";

// A dispatched craft is never retried. Its durable baseline is compared with
// a fresh game read after a lost response or worker restart.
export function queuedStashCraftAdapter({ entry, fetcher, save }) {
  const pending = () => entry.stashCraft.pending;
  async function read(setId) {
    const response = await fetcher(
      "https://cargohustle.online/api/stash/sets",
      {
        headers: {
          Authorization: entry.credential,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok) throw new Error("stash_read_unavailable");
    const body = await response.json();
    const set = body?.sets?.find((item) => item.setId === setId);
    if (!set || !Number.isSafeInteger(set.craftedCount) || set.craftedCount < 0)
      throw new Error("stash_read_unavailable");
    return set;
  }
  function commit() {
    save(entry);
    if (entry.storageFailed) throw new Error("automation_storage_unavailable");
  }
  async function reconcile(job) {
    if (entry.stashCraft.receipts.includes(job.id))
      return { status: "completed" };
    const checkpoint = pending();
    if (!checkpoint || checkpoint.id !== job.id)
      return { status: "uncertain", reason: "Результат сборки неизвестен." };
    try {
      const set = await read(checkpoint.setId);
      if (set.craftedCount <= checkpoint.before)
        return { status: "uncertain", reason: "Проверяем результат сборки." };
      entry.stashCraft.pending = null;
      entry.stashCraft.receipts = [
        ...entry.stashCraft.receipts.slice(-127),
        job.id,
      ];
      commit();
      return { status: "completed" };
    } catch {
      return { status: "uncertain", reason: "Проверяем результат сборки." };
    }
  }
  return {
    validate(args) {
      if (!Number.isSafeInteger(args?.setId) || args.setId <= 0)
        throw new Error("invalid_stash_set");
      return { setId: args.setId };
    },
    dedupeKey: (args) => String(args.setId),
    async execute(job, { canDispatch }) {
      if (entry.stashCraft.receipts.includes(job.id))
        return { status: "completed" };
      if (pending()) return reconcile(job);
      if (entry.equipment?.pending)
        return {
          status: "retry",
          reason: "Ожидаем сверку предыдущего действия.",
        };
      let set;
      try {
        set = await read(job.args.setId);
      } catch {
        return { status: "retry", reason: "Ожидаем игру." };
      }
      if (set.canCraft !== true)
        return { status: "failed", reason: "Набор пока нельзя собрать." };
      if (!canDispatch()) return { status: "retry" };
      const operationId = randomUUID();
      entry.stashCraft.pending = {
        id: job.id,
        setId: job.args.setId,
        before: set.craftedCount,
        operationId,
      };
      commit();
      try {
        const response = await fetcher(
          "https://cargohustle.online/api/stash/craft",
          {
            method: "POST",
            headers: {
              Authorization: entry.credential,
              Accept: "application/json",
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ setId: job.args.setId, operationId }),
            signal: AbortSignal.timeout(20000),
            canDispatch,
          },
        );
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408 &&
          response.status !== 429
        ) {
          entry.stashCraft.pending = null;
          commit();
          return { status: "failed", reason: "Игра отклонила сборку набора." };
        }
      } catch (error) {
        if (error?.notDispatched) {
          entry.stashCraft.pending = null;
          commit();
          return { status: "retry" };
        }
      }
      return reconcile(job);
    },
    reconcile,
  };
}
