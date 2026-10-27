import { characterUpgradeQuote } from "../../src/lib/character-stat-upgrades.js";

const fields = [
  "stat",
  "amount",
  "base",
  "dailyUsed",
  "dailyRemaining",
  "dailyLimit",
  "resetAt",
  "currency",
  "nextCost",
  "maxCost",
  "maxPrice",
];

// Quotes are bounded by the last server snapshot; the batch checks them again
// against fresh game data before submitting any upgrade.
export function queuedCharacterRunAdapter({ entry }) {
  const started = (job) =>
    (entry.characterUpgrade.startReceipts ?? []).includes(job.id);
  return {
    validate(args) {
      const expected = args?.quotes;
      if (
        !Array.isArray(expected) ||
        expected.length < 1 ||
        expected.length > 3 ||
        new Set(expected.map((item) => item?.stat)).size !== expected.length
      )
        throw new Error("invalid_character_upgrade");
      const profile = entry.characterUpgrade.profile;
      const quotes = expected.map((item) => {
        const quote = characterUpgradeQuote(profile, item?.stat, item?.amount);
        if (!quote || fields.some((key) => quote[key] !== item[key]))
          throw new Error("character_upgrade_quote_changed");
        return quote;
      });
      for (const currency of ["gold", "pills"]) {
        const total = quotes
          .filter((quote) => quote.currency === currency)
          .reduce((sum, quote) => sum + quote.maxPrice, 0);
        if (!Number.isSafeInteger(total) || total > profile.wallet[currency])
          throw new Error("character_upgrade_insufficient_funds");
      }
      return { quotes };
    },
    dedupeKey: (args) => JSON.stringify(args.quotes),
    async execute(job, { canDispatch }) {
      if (started(job)) return { status: "completed" };
      if (!canDispatch())
        return { status: "retry", reason: "Ожидаем другие действия." };
      try {
        const quotes = job.args.quotes;
        if (quotes.length === 1) {
          const quote = quotes[0];
          entry.characterBatch.start({
            stat: quote.stat,
            amount: quote.amount,
            quote,
            budget: quote.maxPrice,
            queueId: job.id,
          });
        } else entry.characterBatch.startAll(quotes, { queueId: job.id });
        return { status: "completed" };
      } catch {
        return entry.storageFailed
          ? { status: "uncertain" }
          : { status: "failed", reason: "character_upgrade_quote_changed" };
      }
    },
    async reconcile(job) {
      return started(job) ? { status: "completed" } : { status: "retry" };
    },
  };
}
