import { normalizeWorkStash } from "../../shared/work-stash.js";
import { randomUUID } from "node:crypto";
import {
  normalizeWorkState,
  normalizeEnergy,
  normalizeBoosters,
  planWorkFarm,
  workEnergyRemaining,
} from "../../src/features/works/WorkFarm/work-farm-plan.js";
const nonnegative = (n) => Number.isSafeInteger(n) && n >= 0;
const positive = (n) => nonnegative(n) && n > 0;

// All timers and durable intent live in the account actor. Never replay a POST.
export function createWorkFarm({
  saved = {},
  request,
  getWork,
  getStash,
  onChange,
  now = Date.now,
  schedule = setTimeout,
  cancel = clearTimeout,
  random = Math.random,
}) {
  let record = {
    view: saved.view ?? null,
    run: saved.run ?? null,
    notice: saved.notice ?? null,
    configs: saved.configs ?? {},
    refreshRetryAt: saved.refreshRetryAt ?? null,
  };
  let timer = null,
    generation = 0,
    working = false,
    disposed = false;
  const running = () => record.run?.status === "running";
  const publish = () => onChange?.();
  function clear() {
    if (timer != null) cancel(timer);
    timer = null;
  }
  function finish(status, reason) {
    if (!running()) return;
    generation++;
    clear();
    record.run.status = status;
    record.run.phase = "stopped";
    record.run.reason = reason;
    record.run.nextActionAt = null;
    publish();
  }
  function log(kind, description) {
    const run = record.run;
    run.events = [
      ...(run.events || []).slice(-49),
      { at: now(), kind, description },
    ];
  }
  function checkTime() {
    if (
      running() &&
      record.run.deadlineAt != null &&
      now() >= record.run.deadlineAt
    )
      finish("limited", "Истекло время фарма.");
    return running();
  }
  async function readView(workId, energyOnly = false, includeStash = false) {
    const work = await getWork(workId);
    if (!work) throw new Error("Работёнка отсутствует в справочнике.");
    // open is the public client's state reader, despite its POST transport.
    const [raw, me, bagResult] = await Promise.all([
      request("POST", "/api/works/open", { workId, locale: "ru" }),
      request("GET", "/api/me"),
      (energyOnly ? Promise.resolve(null) : request("GET", "/api/me/bag")).then(
        (bag) => ({ ok: true, bag }),
        () => ({ ok: false, bag: null }),
      ),
    ]);
    let stash = record.view?.workId === workId ? record.view.stash : null;
    if (includeStash && getStash && work.stashSetId != null) {
      try {
        stash = normalizeWorkStash(await getStash(), work.stashSetId, stash);
      } catch {
        /* Inventory failure must not hide the calculator or known counts. */
      }
    }
    const boosters = normalizeBoosters(bagResult.bag);
    return {
      ...normalizeWorkState(raw, workId),
      energy: normalizeEnergy(me.energy),
      boosters,
      stash,
      boostersStatus: energyOnly
        ? "skipped"
        : !bagResult.ok
          ? "error"
          : boosters.length === 2
            ? "ready"
            : "partial",
      walletDollar: nonnegative(me.wallet?.dollar) ? me.wallet.dollar : null,
      updatedAt: now(),
    };
  }
  function budget() {
    const run = record.run;
    return {
      ...run.config,
      maxActions: Math.max(0, run.config.maxActions - run.actionsDone),
      maxBoosters: Math.max(0, run.config.maxBoosters - run.usedBoosters),
      maxDollar: Math.max(0, run.config.maxDollar - run.spentDollar),
    };
  }
  function makePlan() {
    const result = planWorkFarm(record.view, budget());
    record.view.plan = {
      remainingEnergy: result.remainingEnergy,
      spentDollar: result.spentDollar,
      usedBoosters: result.usedBoosters,
      wastedEnergy: result.wastedEnergy,
      optimal: result.optimal,
      feasible: result.feasible,
    };
    return result;
  }
  function queue(delay) {
    if (!running() || disposed || timer != null) return;
    const id = generation;
    record.run.nextActionAt = now() + delay;
    publish();
    timer = schedule(() => {
      timer = null;
      void step(id);
    }, delay);
  }
  async function mutation(kind, path, body, id, details = {}) {
    if (id !== generation || !checkTime() || disposed) return null;
    const run = record.run;
    if (run.actionsDone >= run.config.maxActions) {
      finish("limited", "Достигнут лимит игровых действий.");
      return null;
    }
    if (kind === "buying") run.spentDollar += details.price;
    if (kind === "refilling") run.usedBoosters++;
    // A reserved resource remains spent if the reply is lost. A new run needs
    // explicit user intent and a fresh state read, never an automatic retry.
    run.pending = {
      kind,
      operationId: body.operationId ?? randomUUID(),
      at: now(),
      ...details,
    };
    run.phase = kind;
    run.actionsDone++;
    publish();
    const result = await request("POST", path, body);
    if (result?.success === false && result?.isDuplicate !== true)
      throw new Error("Игра отказала в действии. Фарм остановлен.");
    if (id !== generation || !running()) return null;
    return result;
  }
  async function step(id) {
    if (working || disposed || id !== generation || !checkTime()) return;
    working = true;
    let delay = 1500 + Math.floor(random() * 1501);
    const valid = () => id === generation && !disposed && checkTime();
    try {
      const run = record.run;
      if (
        run.phase === "preparing" ||
        run.phase === "waiting" ||
        !record.view ||
        record.view.workId !== run.workId
      ) {
        const initialEnergyCheck =
          run.phase === "preparing" && run.config.mode === "energy";
        record.run.phase = "checking";
        publish();
        const view = await readView(run.workId, run.config.mode === "energy");
        if (!valid()) return;
        record.view = view;
        if (initialEnergyCheck) {
          run.energyBudget = Math.min(run.energyBudget, view.energy.current);
          run.config.energyBudget = run.energyBudget;
          publish();
        }
      }
      if (!valid()) return;
      if (
        run.config.mode !== "energy" &&
        record.view.completedCycles >= run.targetCycles
      ) {
        finish("completed", "Целевое количество выполнений достигнуто.");
        return;
      }
      if (run.actionsDone >= run.config.maxActions) {
        finish("limited", "Достигнут лимит игровых действий.");
        return;
      }
      if (run.config.mode === "energy") {
        const available = Math.min(
          record.view.energy.current,
          run.energyBudget - run.energySpent,
        );
        const task = record.view.tasks.find(
          (item) =>
            item.canPerform &&
            item.progress < item.required &&
            item.energyCost <= available,
        );
        if (!task) {
          finish(
            "completed",
            "Доступная энергия для выбранной работёнки израсходована.",
          );
          return;
        }
        const before = record.view;
        const operationId = `work-${run.workId}-task-${task.id}-${randomUUID()}`;
        const raw = await mutation(
          "performing",
          "/api/works/tasks/perform",
          { workId: run.workId, taskId: task.id, locale: "ru", operationId },
          id,
          { taskId: task.id },
        );
        if (!valid() || !raw) return;
        const after = normalizeWorkState(raw, run.workId);
        const energy = normalizeEnergy(
          raw.energy
            ? { ...before.energy, ...raw.energy }
            : { ...before.energy, current: raw.playerEnergy },
        );
        const changedTask = after.tasks.find((item) => item.id === task.id);
        const cycleFinished = before.tasks.every((item) =>
          item.id === task.id
            ? item.progress + 1 === item.required
            : item.progress === item.required,
        );
        const confirmed =
          (after.completedCycles === before.completedCycles &&
            changedTask?.progress === task.progress + 1) ||
          (cycleFinished &&
            after.completedCycles === before.completedCycles + 1);
        if (!confirmed || raw.isDuplicate === true)
          throw new Error(
            "Не удалось однозначно подтвердить выполнение задания. Повтор не отправлен.",
          );
        record.view = { ...before, ...after, energy, updatedAt: now() };
        if (after.completedCycles > before.completedCycles && getStash) {
          try {
            const work = await getWork(run.workId);
            const stash = normalizeWorkStash(
              await getStash(),
              work?.stashSetId,
              record.view.stash,
            );
            if (!valid()) return;
            record.view.stash = stash;
          } catch {
            /* Retain the last confirmed inventory on partial failure. */
          }
        }
        run.completedCycles = after.completedCycles;
        run.pending = null;
        run.energySpent += task.energyCost;
        log("perform", `${task.title} · ${task.energyCost} энергии`);
        run.phase = "checking";
        publish();
        return;
      }
      let plan = makePlan();
      if (!plan.feasible) {
        finish(
          "limited",
          "Не хватает разрешённых ресурсов для цели. Увеличьте лимит или выберите ожидание энергии.",
        );
        return;
      }
      let action = plan.actions[0];
      if (!action) throw new Error("Не удалось построить следующий шаг.");
      // Recheck right before restoring energy or spending money. Regeneration,
      // gifts and actions outside the wiki may make a refill unnecessary.
      if (action.kind === "refill") {
        run.phase = "checking";
        publish();
        const view = await readView(run.workId);
        if (!valid()) return;
        record.view = view;
        if (view.completedCycles >= run.targetCycles) {
          finish("completed", "Целевое количество выполнений достигнуто.");
          return;
        }
        plan = makePlan();
        action = plan.actions[0];
        if (!plan.feasible || !action) {
          finish("limited", "Ресурсы изменились. Проверьте расчёт и лимиты.");
          return;
        }
      }
      const before = record.view;
      if (action.kind === "wait") {
        const needed = Math.min(
          ...before.tasks
            .filter((task) => task.progress < task.required)
            .map((task) => task.energyCost),
        );
        if (before.energy.current >= needed)
          throw new Error("Сервер не разрешил выполнение доступных заданий.");
        const interval = before.energy.regenIntervalSeconds,
          next = before.energy.secondsToNext;
        if (!positive(interval) || !nonnegative(next))
          throw new Error("Сервер не передал время восстановления энергии.");
        delay = Math.max(
          1000,
          Math.min(
            3600000,
            (next +
              Math.max(0, needed - before.energy.current - 1) * interval) *
              1000,
          ),
        );
        run.phase = "waiting";
        publish();
        return;
      }
      if (action.kind === "perform") {
        const task = before.tasks.find((task) => task.id === action.taskId);
        if (
          !task?.canPerform ||
          task.progress >= task.required ||
          task.energyCost > before.energy.current
        )
          throw new Error("Задание недоступно. Обновите прогресс работёнки.");
        const operationId = `work-${run.workId}-task-${task.id}-${randomUUID()}`;
        const raw = await mutation(
          "performing",
          "/api/works/tasks/perform",
          { workId: run.workId, taskId: task.id, locale: "ru", operationId },
          id,
          { taskId: task.id },
        );
        if (!valid() || !raw) return;
        const after = normalizeWorkState(raw, run.workId);
        const energy = normalizeEnergy(
          raw.energy
            ? { ...before.energy, ...raw.energy }
            : { ...before.energy, current: raw.playerEnergy },
        );
        const sameDefinition =
          after.tasks.length === before.tasks.length &&
          before.tasks.every((prior) =>
            after.tasks.some(
              (task) =>
                task.id === prior.id &&
                task.required === prior.required &&
                task.energyCost === prior.energyCost,
            ),
          );
        const changedTask = after.tasks.find((value) => value.id === task.id);
        const cycleFinished = before.tasks.every((value) =>
          value.id === task.id
            ? value.progress + 1 === value.required
            : value.progress === value.required,
        );
        const confirmed =
          (after.completedCycles === before.completedCycles &&
            changedTask?.progress === task.progress + 1) ||
          (cycleFinished &&
            after.completedCycles === before.completedCycles + 1);
        if (!sameDefinition || !confirmed || raw.isDuplicate === true)
          throw new Error(
            "Не удалось однозначно подтвердить выполнение задания. Повтор не отправлен.",
          );
        record.view = { ...before, ...after, energy, updatedAt: now() };
        if (after.completedCycles > before.completedCycles && getStash) {
          try {
            const work = await getWork(run.workId);
            const stash = normalizeWorkStash(
              await getStash(),
              work?.stashSetId,
              record.view.stash,
            );
            if (!valid()) return;
            record.view.stash = stash;
          } catch {
            /* Retain the last confirmed inventory on partial failure. */
          }
        }
        run.completedCycles = after.completedCycles;
        run.pending = null;
        run.energySpent += task.energyCost;
        log("perform", `${task.title} · ${task.energyCost} энергии`);
        if (after.completedCycles >= run.targetCycles) {
          finish("completed", "Целевое количество выполнений достигнуто.");
          return;
        }
        run.phase = after.tasks.every((task) => task.progress === task.required)
          ? "preparing"
          : "ready";
        publish();
      } else if (action.kind === "refill") {
        const booster = before.boosters.find(
          (item) => item.type === action.type,
        );
        if (!booster || run.usedBoosters >= run.config.maxBoosters) {
          finish("limited", "Достигнут лимит дефибрилляторов.");
          return;
        }
        if (action.purchase) {
          if (
            !run.config.allowPurchase ||
            booster.maxPurchaseQuantity < 1 ||
            before.walletDollar == null ||
            action.price !== booster.costDollar ||
            run.spentDollar + action.price > run.config.maxDollar ||
            before.walletDollar < action.price
          ) {
            finish("limited", "Покупка выходит за разрешённый бюджет.");
            return;
          }
          const result = await mutation(
            "buying",
            "/api/me/bag/boosters/buy",
            { type: action.type, quantity: 1, operationId: randomUUID() },
            id,
            { price: action.price, type: action.type },
          );
          if (!valid() || !result) return;
          const refreshed = await readView(run.workId);
          if (!valid()) return;
          if (
            refreshed.boosters.find((item) => item.type === action.type)
              ?.count !==
              booster.count + 1 ||
            refreshed.walletDollar !== before.walletDollar - action.price
          )
            throw new Error(
              "Не удалось подтвердить покупку. Повторная покупка не отправлена.",
            );
          record.view = refreshed;
          run.pending = null;
          run.phase = "ready";
          log(
            "buy",
            `Куплен дефибриллятор ${action.type} · ${action.price} купюр`,
          );
          publish();
        } else {
          if (booster.count < 1)
            throw new Error("Дефибриллятора больше нет в инвентаре.");
          const result = await mutation(
            "refilling",
            "/api/me/bag/boosters/use",
            { type: action.type },
            id,
            { type: action.type },
          );
          if (!valid() || !result) return;
          const refreshed = await readView(run.workId);
          if (!valid()) return;
          if (
            refreshed.boosters.find((item) => item.type === action.type)
              ?.count !==
              booster.count - 1 ||
            refreshed.energy.current <
              Math.min(booster.restoreEnergy, refreshed.energy.max)
          )
            throw new Error(
              "Не удалось подтвердить восстановление энергии. Повтор не отправлен.",
            );
          run.wastedEnergy += Math.max(
            0,
            before.energy.current -
              Math.max(0, refreshed.energy.current - booster.restoreEnergy),
          );
          record.view = refreshed;
          run.pending = null;
          run.phase = "ready";
          log("refill", `Использован дефибриллятор ${action.type}`);
          publish();
        }
      }
    } catch (error) {
      if (id === generation)
        finish(
          "error",
          error.message ||
            "Не удалось выполнить действие. Проверьте состояние вручную.",
        );
    } finally {
      working = false;
      if (id === generation && running()) queue(delay);
    }
  }
  function validate(args) {
    if (
      !positive(args.workId) ||
      !positive(args.targetCycles) ||
      !positive(args.maxActions) ||
      args.maxActions > 30000 ||
      (args.durationHours != null && ![1, 2, 4].includes(args.durationHours)) ||
      !["wait", "boosters", "energy"].includes(args.mode) ||
      !nonnegative(args.maxBoosters) ||
      args.maxBoosters > 1000 ||
      !nonnegative(args.maxDollar) ||
      typeof args.allowPurchase !== "boolean"
    )
      throw new Error("Проверьте цель и лимиты фарма.");
  }
  return {
    running,
    getSnapshot: () => record,
    exportState: () => record,
    async refresh(workId, { manual = false } = {}) {
      if (
        manual &&
        record.refreshRetryAt != null &&
        now() < record.refreshRetryAt
      ) {
        const seconds = Math.ceil((record.refreshRetryAt - now()) / 1000);
        throw new Error(`Повторное обновление доступно через ${seconds} сек.`);
      }
      if (running() || working)
        throw new Error(
          "Сначала остановите фарм и дождитесь текущего запроса.",
        );
      if (manual) {
        record.refreshRetryAt = now() + 60_000;
        publish();
      }
      working = true;
      try {
        record.view = await readView(workId, false, true);
        record.notice = null;
      } catch (error) {
        record.notice = error.message;
        throw error;
      } finally {
        working = false;
        publish();
      }
    },
    async plan(args) {
      validate(args);
      if (running() || working)
        throw new Error("Сначала остановите текущий фарм.");
      working = true;
      try {
        const view = await readView(args.workId, false, true);
        const plan = planWorkFarm(view, args);
        record.configs[args.workId] = { ...args };
        record.view = {
          ...view,
          plan: {
            remainingEnergy: plan.remainingEnergy,
            spentDollar: plan.spentDollar,
            usedBoosters: plan.usedBoosters,
            wastedEnergy: plan.wastedEnergy,
            optimal: plan.optimal,
            feasible: plan.feasible,
          },
        };
        record.notice = null;
      } finally {
        working = false;
        publish();
      }
    },
    start(args) {
      if (running() || working)
        throw new Error("Фарм уже запущен или запрос ещё выполняется.");
      if (
        !positive(args.workId) ||
        !positive(args.targetCycles) ||
        !positive(args.maxActions) ||
        args.maxActions > 30000 ||
        (args.durationHours != null &&
          ![1, 2, 4].includes(args.durationHours)) ||
        !["wait", "boosters", "energy"].includes(args.mode) ||
        !nonnegative(args.maxBoosters) ||
        args.maxBoosters > 1000 ||
        !nonnegative(args.maxDollar) ||
        typeof args.allowPurchase !== "boolean"
      )
        throw new Error("Проверьте цель и лимиты фарма.");
      if (!record.view || record.view.workId !== args.workId)
        throw new Error("Сначала загрузите состояние работёнки.");
      if (args.targetCycles - record.view.completedCycles > 1000)
        throw new Error(
          "За один запуск можно запланировать не более 1000 выполнений.",
        );
      if (
        args.mode === "boosters" &&
        (record.view.boosters.length !== 2 || record.view.walletDollar == null)
      )
        throw new Error("Не удалось подтвердить цены и запас дефибрилляторов.");
      if (args.mode === "energy" && !positive(record.view.energy?.current))
        throw new Error(
          "Для режима расхода энергии нужен положительный запас энергии.",
        );
      const config =
        args.mode === "energy"
          ? {
              ...args,
              energyBudget: record.view.energy.current,
              maxBoosters: 0,
              maxDollar: 0,
              allowPurchase: false,
            }
          : { ...args };
      record.configs[args.workId] = config;
      generation++;
      record.run = {
        workId: args.workId,
        title: record.view.title,
        targetCycles: args.targetCycles,
        completedCycles: record.view.completedCycles,
        config,
        energyBudget: config.energyBudget ?? null,
        startedAt: now(),
        deadlineAt:
          args.durationHours == null
            ? null
            : now() + args.durationHours * 3600000,
        status: "running",
        phase: "preparing",
        actionsDone: 0,
        usedBoosters: 0,
        spentDollar: 0,
        energySpent: 0,
        wastedEnergy: 0,
        pending: null,
        events: [],
        reason: null,
      };
      record.notice = null;
      publish();
      queue(0);
    },
    stop() {
      finish("stopped", "Фарм остановлен пользователем.");
    },
    tick() {
      checkTime();
    },
    resume() {
      if (!running()) return;
      if (record.run.pending) {
        finish(
          "error",
          "Перед перезапуском выполнялся игровой запрос. Автоматический повтор запрещён; проверьте результат вручную.",
        );
        return;
      }
      if (!checkTime()) return;
      record.run.phase = "preparing";
      queue(0);
    },
    dispose() {
      disposed = true;
      generation++;
      clear();
    },
  };
}
export { workEnergyRemaining };
