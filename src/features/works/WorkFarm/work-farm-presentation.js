import { workEnergyRemaining } from "./work-farm-plan.js";

// A projection of the current confirmed task state, never an execution queue.
// MAX follows the runner's first-affordable task order and cannot add refills.
export function previewWorkTasks(
  view,
  { mode, targetCycles, energyBudget, maxActions = 30000 },
) {
  if (!view?.tasks?.length) return null;
  const counts = view.tasks.map(() => 0);
  const limit = Math.min(30000, Math.max(0, maxActions));
  const energyOnly = mode === "energy";
  if (energyOnly && (!Number.isSafeInteger(energyBudget) || !view.energy))
    return null;
  if (!energyOnly && !Number.isSafeInteger(targetCycles)) return null;
  let cycles = energyOnly
    ? Infinity
    : Math.max(0, targetCycles - view.completedCycles);
  let remaining = view.tasks.map((task) => task.required - task.progress);
  if (cycles > 0 && remaining.every((count) => count === 0)) return null;
  let energy = energyOnly
    ? Math.min(energyBudget, view.energy.current)
    : Infinity;
  for (let actions = 0; actions < limit && cycles > 0; actions++) {
    const indexes = view.tasks.map((_, index) => index);
    if (!energyOnly)
      indexes.sort(
        (a, b) => view.tasks[b].energyCost - view.tasks[a].energyCost,
      );
    const index = indexes.find(
      (i) =>
        remaining[i] > 0 &&
        (!energyOnly || view.tasks[i].canPerform) &&
        view.tasks[i].energyCost <= energy,
    );
    if (index == null) break;
    counts[index]++;
    remaining[index]--;
    energy -= view.tasks[index].energyCost;
    if (remaining.every((count) => count === 0)) {
      cycles--;
      remaining = view.tasks.map((task) => task.required);
    }
  }
  const items = view.tasks.flatMap((task, index) =>
    counts[index] > 0
      ? [
          {
            id: task.id,
            title: task.title,
            count: counts[index],
            energy: counts[index] * task.energyCost,
          },
        ]
      : [],
  );
  return { items, energy: items.reduce((sum, task) => sum + task.energy, 0) };
}

export function workFarmProgress(run, view) {
  const unknown = { value: 0, max: null, percent: null };
  if (!run) return unknown;
  const value = run.energySpent ?? 0;
  let max;
  if (run.config?.mode === "energy") {
    if (!Number.isFinite(run.energyBudget)) return unknown;
    max = run.energyBudget;
  } else {
    if (view?.workId !== run.workId) return unknown;
    // Historical completed cycles are not work performed by this run. Energy
    // spent plus the remaining task cost also accounts for partial cycles.
    max = value + workEnergyRemaining(view, run.targetCycles);
  }
  if (max === 0) return { value: 1, max: 1, percent: 100 };
  return {
    value: Math.min(value, max),
    max,
    percent: Math.floor(Math.min(1, Math.max(0, value / max)) * 100),
  };
}
