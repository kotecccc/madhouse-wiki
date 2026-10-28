import { actionQueuePriority } from "../../src/lib/action-queue-priority.js";

// Durable user intentions. Adapters must prove that a failed attempt did not
// dispatch a mutation before returning retry; unknown outcomes are reconciled.
const delays = [
  10_000, 30_000, 60_000, 300_000, 300_000, 300_000, 900_000, 1_200_000,
  1_800_000, 3_600_000,
];
const active = new Set([
  "queued",
  "waiting",
  "running",
  "reconciling",
  "paused",
]);
const runnable = new Set(["queued", "waiting", "reconciling"]);
const clone = (value) => structuredClone(value);

export function retryDelay(attempt, random = Math.random) {
  const base = delays[Math.min(Math.max(attempt, 0), delays.length - 1)];
  // Never retry sooner than the nominal interval. Spread accounts over 25%.
  return Math.min(
    3_600_000,
    Math.round(base * (1 + Math.max(0, Math.min(1, random())) * 0.25)),
  );
}

export function createActionQueue({
  saved = [],
  adapters,
  persist,
  now = Date.now,
  random = Math.random,
  allowed = () => true,
  ready = () => true,
  eligible = () => true,
  blockedBy = () => null,
  onAttempt = () => {},
  onResult = () => {},
  runInContext = (_entry, _reconcile, run) => run(),
  limit = 100,
}) {
  let entries = Array.isArray(saved) ? clone(saved) : [];
  let working = false;
  // A crash after marking running may have occurred after dispatch. Only the
  // adapter's read-only reconciliation can resolve this state.
  for (const entry of entries) {
    if (entry.status === "running") {
      entry.status = "reconciling";
      entry.nextAt = now();
    }
  }
  function commit() {
    if (persist(clone(entries)) === false)
      throw new Error("action_queue_storage_unavailable");
  }
  function add({ id, type, args, priority = 0, dependsOn = [] }) {
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9_-]{8,80}$/.test(id) ||
      !adapters[type] ||
      !Number.isSafeInteger(priority)
    )
      throw new Error("invalid_action_queue_entry");
    const existing = entries.find((entry) => entry.id === id);
    if (existing) return clone(existing);
    if (
      !Array.isArray(dependsOn) ||
      dependsOn.length > 10 ||
      new Set(dependsOn).size !== dependsOn.length ||
      dependsOn.some(
        (dependency) =>
          typeof dependency !== "string" ||
          dependency === id ||
          !entries.some((item) => item.id === dependency),
      )
    )
      throw new Error("invalid_action_queue_dependency");
    const normalized = adapters[type].validate(clone(args));
    const key = adapters[type].dedupeKey?.(normalized);
    if (key != null) {
      const equivalent = entries.find(
        (item) =>
          item.type === type &&
          active.has(item.status) &&
          !item.cancelRequested &&
          JSON.stringify(item.dependsOn ?? []) === JSON.stringify(dependsOn) &&
          adapters[type].dedupeKey(item.args) === key,
      );
      if (equivalent) return clone(equivalent);
    }
    const priorEntries = entries;
    const superseded = [];
    for (const item of entries) {
      if (
        item.type === type &&
        active.has(item.status) &&
        adapters[type].supersedes?.(normalized, item.args)
      ) {
        superseded.push([item, clone(item)]);
        item.cancelRequested = true;
        if (!["running", "reconciling"].includes(item.status)) {
          item.status = "cancelled";
          item.nextAt = null;
        }
      }
    }
    const restoreSuperseded = () => {
      for (const [item, previous] of superseded) {
        for (const key of Object.keys(item)) delete item[key];
        Object.assign(item, previous);
      }
    };
    if (entries.filter((entry) => active.has(entry.status)).length >= limit) {
      restoreSuperseded();
      throw new Error("action_queue_full");
    }
    // Active/uncertain checkpoints are never evicted. Completed history is
    // bounded to the same order of magnitude as command receipts so account
    // storage cannot fill up during normal long-term use.
    const terminal = entries
      .filter((item) => !active.has(item.status))
      .slice(-128);
    const retained = new Set(terminal);
    const referenced = new Set([
      ...dependsOn,
      ...entries
        .filter((item) => active.has(item.status))
        .flatMap((item) => item.dependsOn ?? []),
    ]);
    entries = entries.filter(
      (item) =>
        active.has(item.status) ||
        retained.has(item) ||
        referenced.has(item.id),
    );
    const entry = {
      id,
      type,
      args: normalized,
      priority,
      ...(dependsOn.length ? { dependsOn: [...dependsOn] } : {}),
      createdAt: now(),
      status: "queued",
      attempts: 0,
      nextAt: now(),
      reason: null,
    };
    entries.push(entry);
    try {
      commit();
    } catch (error) {
      entries = priorEntries;
      restoreSuperseded();
      throw error;
    }
    return clone(entry);
  }
  function stop(id, pause = false) {
    const entry = entries.find((item) => item.id === id);
    if (!entry) return false;
    if (entry.status === "failed") {
      entry.dismissed = true;
      commit();
      return true;
    }
    if (!active.has(entry.status)) return false;
    // A submitted operation remains visible until its outcome is reconciled.
    // Stopping cannot undo an already dispatched game operation.
    entry.cancelRequested = true;
    entry.pauseRequested = pause;
    if (entry.status !== "running" && entry.status !== "reconciling") {
      entry.status = pause ? "paused" : "cancelled";
      entry.nextAt = null;
    }
    commit();
    return true;
  }
  function dismiss(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry || !["completed", "failed"].includes(entry.status)) return false;
    entry.dismissed = true;
    commit();
    return true;
  }
  function resume(id) {
    const entry = entries.find((item) => item.id === id);
    if (!entry || entry.status !== "paused") return false;
    entry.cancelRequested = false;
    entry.pauseRequested = false;
    entry.status = "queued";
    entry.nextAt = now();
    commit();
    return true;
  }
  function hasDue() {
    return (
      !working &&
      entries.some(
        (item) =>
          runnable.has(item.status) &&
          (item.nextAt ?? 0) <= now() &&
          adapters[item.type] &&
          dependenciesConfirmed(item) &&
          eligible(item) &&
          allowed(item),
      ) &&
      ready()
    );
  }
  function dependenciesConfirmed(item) {
    return (item.dependsOn ?? []).every((id) =>
      entries.some(
        (dependency) =>
          dependency.id === id && dependency.status === "completed",
      ),
    );
  }
  async function tick() {
    if (!hasDue()) return;
    const entry = entries
      .filter(
        (item) =>
          runnable.has(item.status) &&
          (item.nextAt ?? 0) <= now() &&
          adapters[item.type] &&
          dependenciesConfirmed(item) &&
          eligible(item) &&
          allowed(item),
      )
      .sort(
        (a, b) =>
          actionQueuePriority(b, now()) - actionQueuePriority(a, now()) ||
          a.createdAt - b.createdAt,
      )[0];
    if (!entry) return;
    const adapter = adapters[entry.type];
    const reconcile = entry.status === "reconciling";
    working = true;
    try {
      if (!reconcile) {
        entry.status = "running";
        entry.nextAt = null;
        commit();
      }
      const canDispatch = () =>
        allowed(entry) &&
        eligible(entry) &&
        dependenciesConfirmed(entry) &&
        !entry.cancelRequested;
      onAttempt();
      const result = await runInContext(entry, reconcile, () =>
        reconcile
          ? adapter.reconcile(clone(entry), { canDispatch })
          : adapter.execute(clone(entry), { canDispatch }),
      );
      if (
        !result ||
        !["completed", "retry", "uncertain", "failed"].includes(result.status)
      )
        throw new Error("invalid_action_queue_result");
      onResult(result);
      if (result.status === "completed") {
        entry.status = "completed";
        entry.nextAt = null;
        entry.reason = null;
      } else if (result.status === "failed") {
        entry.status = "failed";
        entry.nextAt = null;
        entry.reason = result.reason ?? null;
      } else if (result.status === "retry" && entry.cancelRequested) {
        entry.status = entry.pauseRequested ? "paused" : "cancelled";
        entry.nextAt = null;
      } else {
        // A retry result is permitted only when the adapter has proved that
        // the operation was not submitted, including during reconciliation.
        entry.status =
          result.status === "uncertain" ? "reconciling" : "waiting";
        const delay = Math.max(
          retryDelay(entry.attempts, random),
          result.retryAfterMs ?? 0,
        );
        entry.attempts++;
        entry.nextAt = now() + delay;
        entry.reason = result.reason ?? null;
      }
      commit();
    } catch {
      // An exception can arise after dispatch. Do not assume it was unsent.
      entry.status = "reconciling";
      entry.reason = null;
      entry.nextAt = now() + retryDelay(entry.attempts++, random);
      commit();
    } finally {
      working = false;
    }
  }
  return {
    add,
    stop,
    dismiss,
    resume,
    tick,
    hasDue,
    snapshot: () =>
      entries.map((entry) => ({
        ...clone(entry),
        eligible: Boolean(dependenciesConfirmed(entry) && eligible(entry)),
        blockedBy: dependenciesConfirmed(entry)
          ? blockedBy(entry)
          : "dependency",
      })),
  };
}
