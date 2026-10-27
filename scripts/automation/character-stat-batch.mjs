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
      const profile = await read();
      if (!allowed()) return;
      const quote = characterUpgradeQuote(profile, run.stat, 1);
      if (
        !quote ||
        quote.resetAt !== run.resetAt ||
        Date.parse(run.resetAt) <= now()
      ) {
        finish(
          "stopped",
          "Лимит или стоимость изменились. Обновите данные и запустите заново.",
        );
        return;
      }
      if (
        quote.currency !== run.currency ||
        quote.nextCost > run.budget - run.spent ||
        quote.balance < quote.nextCost
      ) {
        finish("stopped", "Недостаточно средств или достигнут лимит расходов.");
        return;
      }
      const result = await step(quote, allowed, (confirmed) => {
        run.completed++;
        run.spent += confirmed.nextCost;
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
      if (run.completed >= run.target) {
        finish("completed", "Прокачка завершена.");
        return;
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
