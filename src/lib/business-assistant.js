import {
  findItemBosses,
  getBusinessUpgradeTotals,
} from "./business-upgrades.js";

const CURRENCIES = new Set(["gold", "pills", "dollar"]);

function nonnegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function positiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

export function getBusinessUpgradeQuote(raw) {
  if (!raw || typeof raw !== "object") return null;
  const price = raw.nextUpgradePrice;
  if (!nonnegativeSafeInteger(price)) return null;
  const currency = raw.nextUpgradeCurrency;
  // The game client omits the currency slot for a zero-price upgrade.
  // Only an explicit numeric zero proves this; missing/invalid prices remain unknown.
  if (price === 0 && currency == null) return { currency: null, amount: 0 };
  if (!CURRENCIES.has(currency)) return null;
  return { currency, amount: price };
}

export function normalizeBusinessDetails(raw, business) {
  const apiId = Number(business?.apiId);
  if (
    !raw ||
    typeof raw !== "object" ||
    !positiveSafeInteger(apiId) ||
    raw.id !== apiId
  )
    return null;

  const requiredStock = {};
  let nextRequirements = Array.isArray(raw.requiredItems) ? [] : null;
  if (Array.isArray(raw.requiredItems)) {
    const ambiguous = new Set();
    for (const item of raw.requiredItems) {
      const id = item?.itemId;
      const quantity = item?.playerAmount;
      if (!nonnegativeSafeInteger(item?.requiredAmount))
        nextRequirements = null;
      if (!positiveSafeInteger(id) || !nonnegativeSafeInteger(quantity)) {
        nextRequirements = null;
        continue;
      }
      const key = String(id);
      if (Object.hasOwn(requiredStock, key)) {
        delete requiredStock[key];
        ambiguous.add(key);
        nextRequirements = null;
      } else if (!ambiguous.has(key)) {
        requiredStock[key] = quantity;
        nextRequirements?.push({
          entityId: id,
          requiredAmount: item.requiredAmount,
        });
      }
    }
  }
  return {
    level: nonnegativeSafeInteger(raw.level) ? raw.level : null,
    ...(positiveSafeInteger(raw.maxLevel) ? { maxLevel: raw.maxLevel } : {}),
    quote: getBusinessUpgradeQuote(raw),
    requiredStock,
    nextRequirements,
  };
}

export function normalizeBusinessInventory(raw) {
  const rows = raw?.activityItems;
  const stock = {};
  let complete = Array.isArray(rows);
  const seen = new Set();
  const ambiguous = new Set();
  if (Array.isArray(rows)) {
    for (const item of rows) {
      const id = item?.itemId;
      const quantity = item?.quantity;
      if (!positiveSafeInteger(id) || !nonnegativeSafeInteger(quantity)) {
        complete = false;
        if (positiveSafeInteger(id)) {
          const key = String(id);
          delete stock[key];
          ambiguous.add(key);
        }
        continue;
      }
      const key = String(id);
      if (seen.has(key)) {
        complete = false;
        delete stock[key];
        ambiguous.add(key);
        continue;
      }
      seen.add(key);
      if (!ambiguous.has(key)) stock[key] = quantity;
    }
  }
  return { stock, complete };
}

function validCurrentOverride(value) {
  return nonnegativeSafeInteger(value) ? value : null;
}

function itemBosses(bosses, itemId) {
  const found = findItemBosses(bosses, itemId);
  const target = String(itemId);
  for (const boss of bosses ?? []) {
    const matches = (boss.possibleDrops ?? []).some(
      (drop) =>
        drop?.type === "activity_item" &&
        drop.entityId != null &&
        String(drop.entityId) === target,
    );
    if (matches && !found.some((entry) => entry.id === boss.id))
      found.push(boss);
  }
  return found
    .map((boss) => ({ boss, id: boss?.numericId ?? boss?.apiId ?? boss?.id }))
    .filter(({ id }) => positiveSafeInteger(Number(id)))
    .map(({ boss, id }) => ({
      id: Number(id),
      name: typeof boss.name === "string" ? boss.name : "",
      image: typeof boss.image === "string" ? boss.image : null,
    }));
}

function knownRequirements(upgrade, targetLevel, currentLevel) {
  if (
    positiveSafeInteger(targetLevel) &&
    nonnegativeSafeInteger(currentLevel) &&
    currentLevel >= targetLevel
  )
    return {
      known: true,
      totals: (Array.isArray(upgrade?.items) ? upgrade.items : []).map(
        (item) => ({
          ...item,
          requiredAmount: 0,
        }),
      ),
    };
  if (
    !upgrade ||
    !Array.isArray(upgrade.items) ||
    !positiveSafeInteger(targetLevel) ||
    !nonnegativeSafeInteger(currentLevel) ||
    currentLevel > targetLevel
  )
    return { known: false, totals: [] };
  if (!upgrade.items.length) return { known: false, totals: [] };
  const totals = getBusinessUpgradeTotals(upgrade, targetLevel, currentLevel);
  const known = totals.every((item) =>
    nonnegativeSafeInteger(item.requiredAmount),
  );
  return { known, totals };
}

export function buildBusinessAssistantPlan({
  business,
  upgrade,
  bosses = [],
  config = {},
  resources = {},
} = {}) {
  const businessId = business?.id ?? null;
  const details = resources.details?.[businessId] ?? null;
  const currentOverride = validCurrentOverride(config.currentLevelOverride);
  const currentLevel = currentOverride ?? details?.level ?? null;
  const currentLevelSource =
    currentOverride !== null
      ? "manual"
      : nonnegativeSafeInteger(details?.level)
        ? "game"
        : "unknown";
  const referenceMaxLevel = Math.max(
    0,
    ...(upgrade?.items ?? []).map((item) =>
      Array.isArray(item?.levels) ? item.levels.length : 0,
    ),
  );
  const maxLevel = positiveSafeInteger(business?.maxLevel)
    ? business.maxLevel
    : referenceMaxLevel;
  const inventory = resources.inventory;
  const inventoryKnown = inventory?.complete === true;
  const configuredTarget = config.targetLevel;
  let targetLevel = nonnegativeSafeInteger(configuredTarget)
    ? configuredTarget
    : null;
  if (targetLevel !== null && maxLevel > 0)
    targetLevel = Math.min(targetLevel, maxLevel);

  let req =
    currentLevel === null && upgrade && Array.isArray(upgrade.items)
      ? {
          known: false,
          totals: upgrade.items.map((item) => ({
            ...item,
            requiredAmount: null,
          })),
        }
      : knownRequirements(upgrade, targetLevel, currentLevel);
  let nextLevelOnly = false;
  if (
    !req.known &&
    currentLevelSource === "game" &&
    targetLevel != null &&
    targetLevel > currentLevel &&
    Array.isArray(details?.nextRequirements)
  ) {
    nextLevelOnly = true;
    req = {
      known: true,
      totals: details.nextRequirements.map((item) => {
        const drops = (bosses ?? []).flatMap((boss) => [
          ...(boss.possibleDrops ?? []).filter(
            (drop) => drop.type === "activity_item",
          ),
          ...(boss.dropItems ?? []),
        ]);
        const name = drops.find(
          (drop) => Number(drop.entityId) === item.entityId && drop.name,
        )?.name;
        return {
          ...item,
          name: name || `Предмет ${item.entityId}`,
        };
      }),
    };
  }
  const groupedMaterials = new Map();
  for (const item of req.totals) {
    const entityId = item.entityId ?? null;
    const requiredAmount = item.requiredAmount;
    const key =
      entityId == null ? `unknown:${groupedMaterials.size}` : String(entityId);
    const existing = groupedMaterials.get(key);
    if (existing) {
      if (
        existing.name !== (typeof item.name === "string" ? item.name : "") ||
        !nonnegativeSafeInteger(existing.requiredAmount) ||
        !nonnegativeSafeInteger(requiredAmount)
      ) {
        existing.requiredAmount = null;
        existing.ambiguous = true;
      } else {
        const sum = existing.requiredAmount + requiredAmount;
        existing.requiredAmount = nonnegativeSafeInteger(sum) ? sum : null;
        existing.ambiguous = existing.requiredAmount === null;
      }
      continue;
    }
    groupedMaterials.set(key, {
      entityId,
      name: typeof item.name === "string" ? item.name : "",
      requiredAmount,
      ambiguous: false,
    });
  }
  const materials = [...groupedMaterials.values()].map((item) => {
    const { entityId, requiredAmount, name, ambiguous } = item;
    const owned = inventory?.stock?.[String(entityId)];
    const ownedAmount = nonnegativeSafeInteger(owned)
      ? owned
      : inventoryKnown
        ? 0
        : null;
    const missingAmount =
      requiredAmount === 0
        ? 0
        : nonnegativeSafeInteger(requiredAmount) && ownedAmount !== null
          ? Math.max(0, requiredAmount - ownedAmount)
          : null;
    return {
      entityId,
      name,
      requiredAmount: nonnegativeSafeInteger(requiredAmount)
        ? requiredAmount
        : null,
      ownedAmount,
      missingAmount,
      bosses: itemBosses(bosses, entityId),
      ...(ambiguous ? { ambiguous: true } : {}),
    };
  });

  const quote = details?.quote ?? null;
  const sameLevel =
    currentLevel !== null && targetLevel != null && targetLevel <= currentLevel;
  const currentQuote = details?.level === currentLevel ? quote : null;
  const oneNextLevel =
    currentLevel !== null && targetLevel === currentLevel + 1 && currentQuote;
  const cost = {
    total: sameLevel ? 0 : oneNextLevel ? quote.amount : null,
    currency: sameLevel
      ? (currentQuote?.currency ?? null)
      : oneNextLevel
        ? quote.currency
        : null,
    nextAmount: currentQuote?.amount ?? null,
    nextCurrency: currentQuote?.currency ?? null,
    complete: sameLevel || Boolean(oneNextLevel),
  };
  const notes = [];
  if (currentLevel === null) notes.push("Текущий уровень бизнеса неизвестен.");
  if (!req.known)
    notes.push("Требования для выбранного диапазона известны не полностью.");
  if (nextLevelOnly)
    notes.push(
      "Показаны требования следующего уровня из игры. После улучшения расчёт обновится.",
    );
  if (materials.some((item) => item.ambiguous))
    notes.push("Повторяющиеся требования имеют неоднозначные данные.");
  if (upgrade?.sourceTotals?.some((total) => !total.matches))
    notes.push(
      "В исходных итогах есть расхождения; рассчитаны суммы по уровням.",
    );
  if (!inventoryKnown) notes.push("Полный состав инвентаря неизвестен.");
  if (!cost.complete)
    notes.push("Полную стоимость диапазона рассчитать нельзя.");

  return {
    businessId,
    name: typeof business?.title === "string" ? business.title : "",
    targetLevel,
    config: {
      durationHours:
        config.durationHours === undefined ? 2 : config.durationHours,
      bossChoices: { ...config.bossChoices },
      targetLevel: config.targetLevel ?? null,
      currentLevelOverride: currentOverride,
      maxAttempts: positiveSafeInteger(config.maxAttempts)
        ? config.maxAttempts
        : null,
      ...(config.autoUpgrade === true ? { autoUpgrade: true } : {}),
    },
    currentLevel,
    currentLevelSource,
    achieved:
      currentLevel != null &&
      targetLevel != null &&
      currentLevel >= targetLevel,
    maxLevel,
    materials,
    cost,
    requirementsKnown: req.known,
    inventoryKnown,
    canCreateGoals:
      req.known &&
      inventoryKnown &&
      currentLevel !== null &&
      targetLevel !== null,
    notes,
    sourceNotes: (upgrade?.sourceTotals ?? []).filter(
      (total) => !total.matches,
    ),
    updatedAt: resources.updatedAt ?? null,
  };
}
