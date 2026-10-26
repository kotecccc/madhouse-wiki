import { randomUUID } from "node:crypto";

const positive = (value) => Number.isSafeInteger(value) && value > 0;
const nonnegative = (value) => Number.isSafeInteger(value) && value >= 0;
const currencies = new Set(["gold", "pills", "dollar"]);

// One verified level per operation. A lost response remains durable and can
// only be resolved by reading the business again; the POST is never replayed.
export async function advanceBusinessUpgrade({
  run,
  businessId,
  get,
  post,
  persist,
  allowed = () => true,
  operationId = randomUUID,
}) {
  if (!positive(businessId) || !run || !positive(run.targetLevel))
    throw new Error("business_upgrade_invalid");
  const read = async () => {
    const detail = await get(`/api/businesses/${businessId}`);
    if (detail?.id !== businessId || !nonnegative(detail.level))
      throw new Error("business_upgrade_state_unknown");
    return detail;
  };
  async function reconcile(pending) {
    let detail;
    try {
      detail = await read();
    } catch {
      return { status: "uncertain" };
    }
    if (detail.level !== pending.fromLevel + 1) return { status: "uncertain" };
    run.pendingUpgrade = null;
    run.lastUpgrade = { fromLevel: pending.fromLevel, toLevel: detail.level };
    if (persist() === false) {
      run.pendingUpgrade = pending;
      delete run.lastUpgrade;
      throw new Error("business_upgrade_storage_unavailable");
    }
    return { status: "confirmed", level: detail.level };
  }
  if (run.pendingUpgrade) {
    if (
      run.pendingUpgrade.businessId !== businessId ||
      !nonnegative(run.pendingUpgrade.fromLevel) ||
      typeof run.pendingUpgrade.operationId !== "string" ||
      !/^[A-Za-z0-9_-]{1,120}$/.test(run.pendingUpgrade.operationId)
    )
      throw new Error("business_upgrade_checkpoint_invalid");
    return reconcile(run.pendingUpgrade);
  }
  const detail = await read();
  if (detail.level >= run.targetLevel)
    return { status: "complete", level: detail.level };
  if (detail.canUpgrade !== true)
    throw new Error("business_upgrade_availability_unknown");
  const currency = detail.nextUpgradeCurrency ?? detail.currency;
  if (!currencies.has(currency) || !nonnegative(detail.nextUpgradePrice))
    throw new Error("business_upgrade_quote_unknown");
  if (!Array.isArray(detail.requiredItems))
    throw new Error("business_upgrade_requirements_unknown");
  const seen = new Set();
  for (const item of detail.requiredItems) {
    if (
      !positive(item?.itemId) ||
      !nonnegative(item.requiredAmount) ||
      !nonnegative(item.playerAmount) ||
      seen.has(item.itemId)
    )
      throw new Error("business_upgrade_requirements_unknown");
    seen.add(item.itemId);
    if (item.playerAmount < item.requiredAmount)
      return { status: "materials_missing" };
  }
  const me = await get("/api/me");
  const balance = me?.wallet?.[currency];
  if (!nonnegative(balance))
    throw new Error("business_upgrade_balance_unknown");
  if (balance < detail.nextUpgradePrice)
    return { status: "funds_missing", currency };
  if (!allowed()) return { status: "stopped" };
  const id = operationId();
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,120}$/.test(id))
    throw new Error("business_upgrade_operation_invalid");
  run.pendingUpgrade = {
    businessId,
    fromLevel: detail.level,
    operationId: id,
    price: detail.nextUpgradePrice,
    currency,
  };
  if (persist() === false)
    throw new Error("business_upgrade_storage_unavailable");
  const releaseUnsent = () => {
    const pending = run.pendingUpgrade;
    run.pendingUpgrade = null;
    if (persist() === false) {
      run.pendingUpgrade = pending;
      throw new Error("business_upgrade_storage_unavailable");
    }
    return { status: "stopped" };
  };
  if (!allowed()) return releaseUnsent();
  try {
    await post(`/api/businesses/${businessId}/upgrade`, {
      operationId: run.pendingUpgrade.operationId,
    });
  } catch (error) {
    if (error?.notDispatched) return releaseUnsent();
    // Read-only reconciliation below is safe even after a lost response.
  }
  return reconcile(run.pendingUpgrade);
}
