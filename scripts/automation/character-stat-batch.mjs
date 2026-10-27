import { randomUUID } from "node:crypto";
import { characterUpgradeQuote } from "../../src/lib/character-stat-upgrades.js";
import { characterUpgradeRejection } from "./character-stat-upgrade.mjs";

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
}) {
  let timer = null;
  let working = false;
  let disposed = false;
  let generation = 0;
  const running = () => state.run?.status === "running";
  const save = () => {
    if (persist() === false)
      throw new Error("character_upgrade_storage_unavailable");
  };
  const queue = (delay = 0) => {
    if (disposed || timer != null || !running()) return;
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
  async function tick() {
    if (disposed || working || !running()) return;
    if (!lock()) {
      queue(1000);
      return;
    }
    working = true;
    const run = state.run;
    const turn = generation;
    const allowed = () =>
      !disposed && running() && state.run === run && generation === turn;
    try {
      if (state.pending) {
        finish(
          "uncertain",
          "Необходимо проверить результат предыдущего улучшения.",
        );
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
      const quote = characterUpgradeQuote(profile, part.stat, 1);
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
        quote.nextCost > part.budget - part.spent ||
        quote.balance < quote.nextCost
      ) {
        finish("stopped", "Недостаточно средств или достигнут лимит расходов.");
        return;
      }
      const result = await step(quote, allowed, (confirmed) => {
        run.completed++;
        if (part !== run) part.completed++;
        part.spent += confirmed.nextCost;
      });
      if (!allowed()) return;
      if (result.status === "rejected") {
        finish("stopped", characterUpgradeRejection(result.reason));
        return;
      }
      if (result.status !== "confirmed") {
        finish(
          "uncertain",
          "Результат улучшения не подтверждён; повторная отправка отключена.",
        );
        return;
      }
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
    } catch {
      if (allowed())
        finish(
          state.pending ? "uncertain" : "stopped",
          state.pending
            ? "Результат улучшения не подтверждён."
            : "Не удалось продолжить прокачку. Обновите данные.",
        );
    } finally {
      working = false;
      unlock();
    }
  }
  return {
    running,
    start({ stat, amount, quote, budget }) {
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
        stat,
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
      generation++;
      save();
      queue();
    },
    startAll(quotes) {
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
      generation++;
      save();
      queue();
    },
    stop() {
      finish("stopped", "Прокачка остановлена.");
      if (timer != null) cancel(timer);
      timer = null;
    },
    resume() {
      if (running() && state.pending)
        finish(
          "uncertain",
          "Необходимо проверить результат предыдущего улучшения.",
        );
      else queue();
    },
    dispose() {
      disposed = true;
      generation++;
      if (timer != null) cancel(timer);
      timer = null;
    },
  };
}
