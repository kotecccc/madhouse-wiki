import { normalizeBusinessDetails } from "../../../lib/business-assistant.js";

const currencies = ["gold", "pills", "dollar", "exp"];
const amount = (value) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

const incomeRewards = [
  ["gold", "Монеты", "coin"],
  ["pills", "Таблетки", "pill"],
  ["dollar", "Доллары", "banknote"],
  ["exp", "Опыт", "star"],
];

export function businessIncomeField(income) {
  const rewards = incomeRewards
    .filter(([currency]) =>
      income.some(([key, value]) => key === currency && value > 0),
    )
    .map(([currency, label, icon]) => [
      icon,
      label,
      income.find(([key]) => key === currency)[1],
    ]);
  return {
    id: "income",
    label: "Доход",
    value: income.length ? "Доход —" : "Доход неизвестен",
    content: income.length && rewards.length === 0 ? "Доход —" : undefined,
    rewards: rewards.length ? rewards : undefined,
  };
}

export function normalizeBusinessState(raw, business) {
  const details = normalizeBusinessDetails(raw, business);
  if (!details) return null;
  const income = raw.currentIncome;
  const rewards =
    income && typeof income === "object" && !Array.isArray(income)
      ? currencies
          .filter((key) => amount(income[key]))
          .map((key) => [key, income[key]])
      : amount(income) && currencies.includes(raw.currency)
        ? [[raw.currency, income]]
        : [];
  return { level: details.level, income: rewards };
}
