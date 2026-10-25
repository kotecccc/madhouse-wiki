const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const positive = (n) => integer(n) && n > 0;

// Keys established from the shipped work parser bEX/bEU, not catalogue progress.
export function normalizeWorkState(raw, workId) {
  if (
    raw?.success === false ||
    raw?.workId !== workId ||
    !integer(raw.completedCycles) ||
    typeof raw.title !== "string" ||
    !Array.isArray(raw.tasks) ||
    !raw.tasks.length
  )
    throw new Error("Не удалось подтвердить прогресс работёнки.");
  const ids = new Set();
  const tasks = raw.tasks.map((task) => {
    if (
      !positive(task.id) ||
      ids.has(task.id) ||
      !positive(task.required) ||
      !positive(task.energyCost) ||
      !integer(task.progress) ||
      task.progress > task.required ||
      typeof task.canPerform !== "boolean"
    )
      throw new Error("Сервер не передал полный прогресс заданий.");
    ids.add(task.id);
    return {
      id: task.id,
      title: typeof task.title === "string" ? task.title : `Задание ${task.id}`,
      required: task.required,
      progress: task.completed === true ? task.required : task.progress,
      energyCost: task.energyCost,
      canPerform: task.canPerform,
    };
  });
  return {
    workId,
    title: raw.title,
    completedCycles: raw.completedCycles,
    tasks,
  };
}
export function normalizeEnergy(raw) {
  if (!integer(raw?.current) || !positive(raw.max) || raw.current > raw.max)
    throw new Error("Не удалось подтвердить запас энергии.");
  return {
    current: raw.current,
    max: raw.max,
    regenIntervalSeconds: positive(raw.regenIntervalSeconds)
      ? raw.regenIntervalSeconds
      : null,
    secondsToNext: integer(raw.secondsToNext) ? raw.secondsToNext : null,
  };
}
export function normalizeBoosters(bag) {
  return ["small", "full"]
    .map((type) => {
      const value = bag?.boosters?.[type];
      if (
        !value ||
        !integer(value.count) ||
        !positive(value.restoreEnergy) ||
        !integer(value.costDollar) ||
        !integer(value.maxPurchaseQuantity)
      )
        return null;
      return {
        type,
        count: value.count,
        restoreEnergy: value.restoreEnergy,
        costDollar: value.costDollar,
        maxPurchaseQuantity: value.maxPurchaseQuantity,
      };
    })
    .filter(Boolean);
}
export function workEnergyRemaining(view, target) {
  if (!integer(target) || target < view.completedCycles) return 0;
  const cycles = target - view.completedCycles;
  if (!cycles) return 0;
  const full = view.tasks.reduce(
    (sum, task) => sum + task.required * task.energyCost,
    0,
  );
  const partial = view.tasks.reduce(
    (sum, task) => sum + (task.required - task.progress) * task.energyCost,
    0,
  );
  const result = partial + (cycles - 1) * full;
  if (!Number.isSafeInteger(result)) throw new Error("Слишком большая цель.");
  return result;
}
const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
const score = (node) => [node.spent, node.used, node.waste];
function advance(node, index, tasks) {
  const counts = [...node.counts];
  counts[index]--;
  const complete = counts.every((count) => count === 0);
  return {
    ...node,
    counts:
      complete && node.cycles > 1 ? tasks.map((task) => task.required) : counts,
    cycles: node.cycles - (complete ? 1 : 0),
    energy: node.energy - tasks[index].energyCost,
    steps: node.steps + 1,
    parent: node,
    action: { kind: "perform", taskId: tasks[index].id },
  };
}
function children(node, tasks, boosters, config) {
  if (node.steps >= config.maxActions) return [];
  const affordable = tasks.flatMap((task, index) =>
    node.counts[index] > 0 && task.energyCost <= node.energy ? [index] : [],
  );
  if (affordable.length)
    return affordable
      .sort((a, b) => tasks[b].energyCost - tasks[a].energyCost)
      .map((index) => advance(node, index, tasks));
  if (node.used >= config.maxBoosters) return [];
  return boosters.flatMap((booster, index) => {
    const recovery = Math.min(booster.restoreEnergy, config.maxEnergy);
    if (
      recovery <= node.energy ||
      !tasks.some((task, i) => node.counts[i] && task.energyCost <= recovery)
    )
      return [];
    const purchase = node.stock[index] === 0;
    if (purchase && (!config.allowPurchase || booster.maxPurchaseQuantity < 1))
      return [];
    const price = purchase ? booster.costDollar : 0;
    if (node.steps + (purchase ? 2 : 1) > config.maxActions) return [];
    if (node.spent + price > config.maxDollar) return [];
    const stock = [...node.stock];
    if (!purchase) stock[index]--;
    return [
      {
        ...node,
        stock,
        energy: recovery,
        steps: node.steps + (purchase ? 2 : 1),
        spent: node.spent + price,
        used: node.used + 1,
        waste: node.waste + node.energy,
        parent: node,
        action: { kind: "refill", type: booster.type, purchase, price },
      },
    ];
  });
}
function actions(node) {
  const result = [];
  while (node?.action) {
    result.push(node.action);
    node = node.parent;
  }
  return result.reverse();
}
// Exact best-first search when it fits the state budget. A complete feasible
// rollout is retained when the bound is reached, and explicitly marked estimate.
// Objective: banknotes, then item count, then discarded energy; budgets are hard.
export function planWorkFarm(view, config, { maxStates = 12000 } = {}) {
  const cycles = config.targetCycles - view.completedCycles;
  const remainingEnergy = workEnergyRemaining(view, config.targetCycles);
  if (cycles <= 0)
    return {
      actions: [],
      remainingEnergy: 0,
      spentDollar: 0,
      usedBoosters: 0,
      wastedEnergy: 0,
      optimal: true,
      feasible: true,
    };
  if (
    cycles > 1000 ||
    view.tasks.length > 20 ||
    view.tasks.some((task) => task.required > 1000) ||
    remainingEnergy > 10000000
  )
    throw new Error("Уменьшите цель: расчёт превышает допустимый размер.");
  const counts = view.tasks.map((task) => task.required - task.progress);
  if (!counts.some(Boolean))
    throw new Error(
      "Сервер не открыл задания следующего цикла. Обновите работёнку.",
    );
  if (
    view.tasks.some((task, i) => counts[i] && task.energyCost > view.energy.max)
  )
    throw new Error("Задание требует больше энергии, чем её лимит.");
  if (config.mode === "wait") {
    const task = view.tasks
      .filter(
        (task, i) =>
          counts[i] &&
          task.canPerform &&
          task.energyCost <= view.energy.current,
      )
      .sort((a, b) => b.energyCost - a.energyCost)[0];
    return {
      actions: task
        ? [{ kind: "perform", taskId: task.id }]
        : [{ kind: "wait" }],
      remainingEnergy,
      feasible: true,
      optimal: true,
      spentDollar: 0,
      usedBoosters: 0,
      wastedEnergy: 0,
    };
  }
  const boosters = view.boosters;
  const settings = {
    ...config,
    maxEnergy: view.energy.max,
    maxDollar: Math.min(config.maxDollar, view.walletDollar ?? 0),
  };
  const root = {
    counts,
    cycles,
    energy: view.energy.current,
    stock: boosters.map((item) => item.count),
    spent: 0,
    steps: 0,
    used: 0,
    waste: 0,
    parent: null,
  };
  // Find conservative feasible upper bounds first; zero-cost alternatives remain
  // available to the exact search below. Do not claim a lower bound as a quote.
  let best = null;
  for (const preference of ["small", "full"]) {
    let node = root;
    for (
      let i = 0;
      i < Math.min(config.maxActions, 30000) && node.cycles;
      i++
    ) {
      const next = children(node, view.tasks, boosters, settings);
      node =
        next.find((value) => value.action.kind === "perform") ||
        next.find((value) => value.action.type === preference) ||
        next[0];
      if (!node) break;
    }
    if (node?.cycles === 0 && (!best || compare(score(node), score(best)) < 0))
      best = node;
  }
  const heap = [],
    seen = new Map();
  function push(node) {
    let i = heap.length;
    heap.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compare(score(heap[p]), score(node)) <= 0) break;
      heap[i] = heap[p];
      i = p;
    }
    heap[i] = node;
  }
  function pop() {
    const result = heap[0],
      last = heap.pop();
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let c = i * 2 + 1;
        if (
          c + 1 < heap.length &&
          compare(score(heap[c + 1]), score(heap[c])) < 0
        )
          c++;
        if (compare(score(last), score(heap[c])) <= 0) break;
        heap[i] = heap[c];
        i = c;
      }
      heap[i] = last;
    }
    return result;
  }
  push(root);
  let visited = 0,
    optimal = false;
  while (heap.length && visited++ < maxStates) {
    const node = pop();
    if (!node.cycles) {
      best = node;
      optimal = true;
      break;
    }
    if (best && compare(score(node), score(best)) >= 0) continue;
    const key = [
      node.cycles,
      node.energy,
      node.used,
      node.spent,
      node.steps,
      node.counts.join(","),
      node.stock.join(","),
    ].join("|");
    const prior = seen.get(key);
    if (prior && compare(prior, score(node)) <= 0) continue;
    seen.set(key, score(node));
    for (const next of children(node, view.tasks, boosters, settings))
      push(next);
  }
  if (!heap.length && best) optimal = true;
  return best
    ? {
        actions: actions(best),
        remainingEnergy,
        spentDollar: best.spent,
        usedBoosters: best.used,
        wastedEnergy: best.waste,
        optimal,
        feasible: true,
      }
    : {
        actions: [],
        remainingEnergy,
        feasible: false,
        optimal: heap.length === 0,
        spentDollar: null,
        usedBoosters: null,
        wastedEnergy: null,
      };
}
