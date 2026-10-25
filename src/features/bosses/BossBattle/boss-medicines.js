export const medicineNames = {
  heal_10: "Аптечка",
  heal_full: "Полная аптечка",
};
export const currencyNames = {
  gold: "Золото",
  dollar: "Доллары",
  pills: "Таблетки",
};
const count = (n) => Number.isSafeInteger(n) && n >= 0;

// Only the two healing items and their quote data belong in this session UI.
export function normalizeMedicines(raw) {
  if (!Array.isArray(raw?.combatItems)) return null;
  return Object.keys(medicineNames).map((type) => {
    const matches = raw.combatItems.filter((item) => item?.type === type);
    const item = matches.length === 1 ? matches[0] : null;
    const prices = [];
    for (const currency of Object.keys(currencyNames)) {
      const quotes = Array.isArray(item?.prices)
        ? item.prices.filter((p) => p?.currency === currency)
        : [];
      if (quotes.length === 1 && count(quotes[0].amount))
        prices.push({ currency, amount: quotes[0].amount });
    }
    return {
      type,
      quantity: count(item?.quantity) ? item.quantity : null,
      maxPurchaseQuantity: count(item?.maxPurchaseQuantity)
        ? Math.min(item.maxPurchaseQuantity, 100)
        : null,
      prices,
    };
  });
}

export function medicinePurchaseQuote(medicines, type, currency, quantity) {
  const item = medicines?.find((entry) => entry.type === type);
  const price = item?.prices.find((entry) => entry.currency === currency);
  if (
    !Object.hasOwn(medicineNames, type) ||
    !Object.hasOwn(currencyNames, currency) ||
    !item ||
    item.quantity === null ||
    !price ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    item.maxPurchaseQuantity === null ||
    quantity > item.maxPurchaseQuantity ||
    !Number.isSafeInteger(price.amount * quantity)
  )
    return null;
  return {
    type,
    currency,
    quantity,
    unitPrice: price.amount,
    total: price.amount * quantity,
  };
}
