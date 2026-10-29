import { randomUUID } from "node:crypto";
import { characterUpgradeQuote } from "../../src/lib/character-stat-upgrades.js";

const rejectedReasons = new Set([
  "invalid_request",
  "invalid_stat",
  "invalid_amount",
  "not_enough_currency",
  "daily_limit_reached",
  "rage_effect_cap_reached",
  "rage_upgrade_exceeds_effect_cap",
]);
export function characterUpgradeRejection(reason) {
  return (
    {
      not_enough_currency: "Недостаточно валюты.",
      daily_limit_reached: "Достигнут дневной лимит.",
      rage_effect_cap_reached: "Достигнут предел эффекта ярости.",
      rage_upgrade_exceeds_effect_cap:
        "Улучшение превышает предел эффекта ярости.",
    }[reason] || "Игра отклонила улучшение. Обновите данные."
  );
}

// Each operation is quoted again from a fresh profile before dispatch.
// A pending operation is durable before dispatch and is never submitted again.
export async function upgradeCharacterPoint({
  state,
  stat,
  expected,
  getProfile,
  post,
  persist,
  onConfirmed = () => {},
  allowed = () => true,
  operationId = randomUUID,
  runId = null,
}) {
  if (state.pending) throw new Error("character_upgrade_uncertain");
  const profile = await getProfile();
  const quote = characterUpgradeQuote(profile, stat, expected?.amount ?? 1);
  if (
    !quote ||
    !expected ||
    quote.nextCost !== expected.nextCost ||
    quote.currency !== expected.currency ||
    quote.dailyUsed !== expected.dailyUsed ||
    quote.resetAt !== expected.resetAt ||
    quote.base !== expected.base ||
    quote.amount !== expected.amount ||
    quote.maxPrice !== expected.maxPrice
  )
    throw new Error("character_upgrade_quote_changed");
  if (quote.balance < quote.maxPrice)
    throw new Error("character_upgrade_insufficient_funds");
  if (!allowed()) throw new Error("character_upgrade_cancelled");
  const id = operationId();
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error("character_upgrade_invalid_operation");
  state.pending = {
    id,
    stat,
    base: quote.base,
    dailyUsed: quote.dailyUsed,
    resetAt: quote.resetAt,
    currency: quote.currency,
    balance: quote.balance,
    price: quote.maxPrice,
    ...(quote.amount > 1 ? { amount: quote.amount } : {}),
    ...(runId ? { runId } : {}),
  };
  if (persist() === false)
    throw new Error("character_upgrade_storage_unavailable");
  if (!allowed()) {
    state.pending = null;
    if (persist() === false)
      throw new Error("character_upgrade_storage_unavailable");
    throw new Error("character_upgrade_cancelled");
  }
  let response;
  try {
    response = await post({ stat, amount: quote.amount, operationId: id });
  } catch (error) {
    if (error?.notDispatched) {
      state.pending = null;
      if (persist() === false)
        throw new Error("character_upgrade_storage_unavailable", {
          cause: error,
        });
      throw new Error("character_upgrade_cancelled", { cause: error });
    }
    // The request may have reached the game. Leave the checkpoint untouched.
    return { status: "uncertain" };
  }
  const reason = response?.error ?? response?.reason;
  if (response?._explicitRejection === true && rejectedReasons.has(reason)) {
    const pending = state.pending;
    state.pending = null;
    if (persist() === false) {
      state.pending = pending;
      throw new Error("character_upgrade_storage_unavailable");
    }
    return { status: "rejected", reason };
  }
  const after = response?.characterStatsUpgrade?.[stat];
  const base = response?.characterStats?.[stat]?.base;
  const charge = quote.balance - response?.balance?.[quote.currency];
  if (
    !response ||
    response.success === false ||
    response.characterStatsUpgrade?.resetAtUtc !== quote.resetAt ||
    after?.dailyUsed !== quote.dailyUsed + quote.amount ||
    base !== quote.base + quote.amount ||
    !Number.isSafeInteger(charge) ||
    charge < 0 ||
    (quote.amount === 1 ? charge !== quote.nextCost : charge > quote.maxPrice)
  )
    return { status: "uncertain" };
  // Preserve only an explicitly confirmed daily limit in the durable profile.
  // If the response is incomplete, a later live read remains necessary.
  if (
    state.profile?.characterStatsUpgrade?.resetAtUtc === quote.resetAt &&
    after.dailyLimit === quote.dailyLimit &&
    after.dailyRemaining === quote.dailyRemaining - quote.amount &&
    after.dailyUsed + after.dailyRemaining === after.dailyLimit
  ) {
    const previous = state.profile.characterStatsUpgrade[stat];
    const fields = [
      "currency",
      "costPerPoint",
      "nextCost",
      "startCost",
      "maxCost",
      "dailyLimit",
      "dailyUsed",
      "dailyRemaining",
    ];
    state.profile.characterStatsUpgrade[stat] = {
      ...previous,
      ...Object.fromEntries(
        fields
          .filter((key) => after[key] !== undefined)
          .map((key) => [key, after[key]]),
      ),
    };
    state.profile.characterStats[stat] = {
      base,
      total: Number.isSafeInteger(response.characterStats[stat].total)
        ? response.characterStats[stat].total
        : null,
    };
    state.profile.wallet[quote.currency] = response.balance[quote.currency];
  }
  onConfirmed(quote, charge);
  state.pending = null;
  if (persist() === false) {
    state.pending = {
      id,
      stat,
      base: quote.base,
      dailyUsed: quote.dailyUsed,
      resetAt: quote.resetAt,
      currency: quote.currency,
      balance: quote.balance,
      price: quote.maxPrice,
      ...(quote.amount > 1 ? { amount: quote.amount } : {}),
      ...(runId ? { runId } : {}),
    };
    throw new Error("character_upgrade_storage_unavailable");
  }
  return { status: "confirmed" };
}
