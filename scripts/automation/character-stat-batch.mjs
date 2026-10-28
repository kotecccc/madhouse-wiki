import { randomUUID } from "node:crypto";
import { characterUpgradeQuote } from "../../src/lib/character-stat-upgrades.js";
import { characterUpgradeRejection } from "./character-stat-upgrade.mjs";
import { retryDelay } from "./action-queue.mjs";

// A batch is durable intent, executed one point at a time on the server. Each
// confirmed point and its spend are committed with the cleared checkpoint.
export function createCharacterStatBatch({
  state,
  read,
  step,
  persist,
  lock,
  unlock,
  schedule = setTimeout,
  cancel = clearTimeout,
  now = Date.now,
  random = Math.random,
}) {
  let timer = null;
  let working = false;
  let disposed = false;
  let generation = 0;
  const running = () => state.run?.status === "running";
  const recovering = () =>
    Boolean(state.pending?.runId && state.pending.runId === state.run?.id);
  const save = () => {
    if (persist() === false)
      throw new Error("character_upgrade_storage_unavailable");
  };
  const queue = (delay = 0) => {
    if (disposed || timer != null || (!running() && !recovering())) return;
    timer = schedule(() => {
      timer = null;
      // A failed durable write must not become an unhandled worker rejection.
      void tick().catch(() => {});
    }, delay);
  };
  const finish = (status, reason) => {
    if (!running()) return;
    state.run.status = status;
    state.run.reason = reason;
    generation++;
    save();
  };
  const wait = (reason, error) => {
    const run = state.run;
    run.phase = state.pending ? "reconciling" : "waiting";
    run.reason = reason;
    run.failures = (run.failures ?? 0) + 1;
    const delay = Math.max(
      retryDelay(run.failures - 1, random),
      error?.retryAfterMs ?? 0,
    );
    run.nextRetryAt = now() + delay;
    save();
    queue(delay);
  };
  async function tick() {
    if (disposed || working || (!running() && !recovering())) return;
    if (!lock()) {
      queue(1000);
      return;
    }
    working = true;
    const run = state.run;
    const turn = generation;
    const allowed = () =>
      !disposed &&
      (running() || recovering()) &&
      state.run === run &&
      generation === turn;
    try {
      if (state.pending) {
        const pending = state.pending;
        if (pending.runId !== run.id) {
          finish(
            "uncertain",
            "Необходимо проверить результат предыдущего улучшения.",
          );
          return;
        }
        const profile = await read();
        if (!allowed()) return;
        const part = run.items ? run.items[run.index] : run;
        const amount = pending.amount ?? 1;
        const charge = pending.balance - profile.wallet?.[pending.currency];
        if (
          part.stat !== pending.stat ||
          profile.characterStatsUpgrade?.resetAtUtc !== pending.resetAt ||
          profile.characterStatsUpgrade?.[pending.stat]?.dailyUsed !==
            pending.dailyUsed + amount ||
          profile.characterStats?.[pending.stat]?.base !==
            pending.base + amount ||
          !Number.isSafeInteger(charge) ||
          charge < 0 ||
          (amount === 1 ? charge !== pending.price : charge > pending.price)
        ) {
          wait("Проверяем результат улучшения.");
          return;
        }
        run.completed += amount;
        if (part !== run) part.completed += amount;
        part.spent += charge;
        state.pending = null;
        run.phase = "ready";
        run.reason = run.status === "stopped" ? "Прокачка остановлена." : null;
        run.failures = 0;
        run.nextRetryAt = null;
        save();
        if (running()) queue(0);
        return;
      }
      const part = run.items ? run.items[run.index] : run;
      if (part.completed >= part.target) {
        if (run.items && run.index + 1 < run.items.length) {
          run.index++;
          save();
          queue();
        } else finish("completed", "Прокачка завершена.");
        return;
      }
      const profile = await read();
      if (!allowed()) return;
      const amount = run.bulk ? part.target - part.completed : 1;
      const quote = characterUpgradeQuote(profile, part.stat, amount);
      if (part.expected && part.completed === 0) {
        const current = characterUpgradeQuote(profile, part.stat, part.target);
        const fields = [
          "stat",
          "base",
          "dailyUsed",
          "dailyRemaining",
          "dailyLimit",
          "resetAt",
          "currency",
          "nextCost",
          "maxCost",
          "maxPrice",
          "amount",
        ];
        if (
          !current ||
          fields.some((field) => current[field] !== part.expected[field])
        ) {
          finish(
            "stopped",
            "Стоимость или лимит изменились. Проверьте данные и запустите прокачку заново.",
          );
          return;
        }
      }
      if (
        !quote ||
        quote.resetAt !== part.resetAt ||
        Date.parse(part.resetAt) <= now()
      ) {
        finish(
          "stopped",
          "Лимит или стоимость изменились. Обновите данные и запустите заново.",
        );
        return;
      }
      if (
        quote.currency !== part.currency ||
        quote.maxPrice > part.budget - part.spent ||
        quote.balance < quote.maxPrice
      ) {
        finish("stopped", "Недостаточно средств или достигнут лимит расходов.");
        return;
      }
      const result = await step(
        quote,
        allowed,
        (confirmed, charge = confirmed.nextCost) => {
          run.completed += confirmed.amount;
          if (part !== run) part.completed += confirmed.amount;
          part.spent += charge;
        },
        run.id,
      );
      if (!allowed()) return;
      if (result.status === "rejected") {
        finish("stopped", characterUpgradeRejection(result.reason));
        return;
      }
      if (result.status !== "confirmed") {
        if (recovering()) wait("Проверяем результат улучшения.");
        else
          finish(
            "uncertain",
            "Результат улучшения не подтверждён; повторная отправка отключена.",
          );
        return;
      }
      run.failures = 0;
      run.nextRetryAt = null;
      run.phase = "ready";
      // A failed read cannot undo the durable confirmation or replay the POST.
      try {
        await read();
      } catch {
        // The next tick or explicit refresh will obtain the current view.
      }
      if (!allowed()) return;
      if (part.completed >= part.target) {
        if (run.items && run.index + 1 < run.items.length) {
          run.index++;
          save();
        } else {
          finish("completed", "Прокачка завершена.");
          return;
        }
      }
      queue(1500);
    } catch (error) {
      if (allowed()) {
        if (
          [
            "character_upgrade_quote_changed",
            "character_upgrade_insufficient_funds",
            "character_upgrade_invalid_operation",
          ].includes(error.message)
        )
          finish(
            "stopped",
            "Стоимость или лимит изменились. Проверьте данные.",
          );
        else if (state.pending && !recovering())
          finish("uncertain", "Результат улучшения не подтверждён.");
        else
          wait(
            state.pending ? "Проверяем результат улучшения." : "Ожидаем игру.",
            error,
          );
      }
    } finally {
      working = false;
      unlock();
    }
  }
  return {
    running,
    start({ stat, amount, quote, budget, queueId = null, bulk = false }) {
      if (
        disposed ||
        running() ||
        state.pending ||
        !quote ||
        quote.stat !== stat ||
        quote.amount !== amount ||
        !Number.isSafeInteger(amount) ||
        amount < 1 ||
        !Number.isSafeInteger(budget) ||
        budget < 0 ||
        budget !== quote.maxPrice ||
        Date.parse(quote.resetAt) <= now()
      )
        throw new Error("character_batch_invalid");
      state.run = {
        id: randomUUID(),
        queueId,
        stat,
        ...(bulk && amount > 1 ? { bulk: true } : {}),
        target: amount,
        expected: structuredClone(quote),
        completed: 0,
        spent: 0,
        budget,
        currency: quote.currency,
        resetAt: quote.resetAt,
        status: "running",
        reason: null,
      };
      if (queueId && !(state.startReceipts ?? []).includes(queueId))
        state.startReceipts = [
          ...(state.startReceipts ?? []).slice(-127),
          queueId,
        ];
      generation++;
      save();
      queue();
    },
    startAll(quotes, { queueId = null } = {}) {
      if (
        disposed ||
        running() ||
        state.pending ||
        !Array.isArray(quotes) ||
        !quotes.length ||
        new Set(quotes.map((q) => q.stat)).size !== quotes.length ||
        quotes.some(
          (q) =>
            !q ||
            !Number.isSafeInteger(q.amount) ||
            q.amount < 1 ||
            !Number.isSafeInteger(q.maxPrice) ||
            q.maxPrice < 0 ||
            Date.parse(q.resetAt) <= now(),
        )
      )
        throw new Error("character_batch_invalid");
      state.run = {
        id: randomUUID(),
        queueId,
        items: quotes.map((q) => ({
          stat: q.stat,
          target: q.amount,
          expected: structuredClone(q),
          completed: 0,
          spent: 0,
          budget: q.maxPrice,
          currency: q.currency,
          resetAt: q.resetAt,
        })),
        index: 0,
        target: quotes.reduce((sum, q) => sum + q.amount, 0),
        completed: 0,
        status: "running",
        reason: null,
      };
      if (queueId && !(state.startReceipts ?? []).includes(queueId))
        state.startReceipts = [
          ...(state.startReceipts ?? []).slice(-127),
          queueId,
        ];
      generation++;
      save();
      queue();
    },
    stop() {
      finish("stopped", "Прокачка остановлена.");
      if (timer != null) cancel(timer);
      timer = null;
      if (recovering()) queue(0);
    },
    resume() {
      if (running() && state.pending && !recovering())
        finish(
          "uncertain",
          "Необходимо проверить результат предыдущего улучшения.",
        );
      else queue(Math.max(0, (state.run?.nextRetryAt ?? now()) - now()));
    },
    recovering,
    dispose() {
      disposed = true;
      generation++;
      if (timer != null) cancel(timer);
      timer = null;
    },
  };
}
