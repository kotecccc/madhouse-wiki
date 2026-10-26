import {
  inventoryAction,
  inventoryRead,
  inventoryWallet,
  inventoryEntityId,
} from "./inventory-actions.mjs";
import { randomUUID } from "node:crypto";

export async function recoverBrokenWeapon({
  entry,
  fetcher,
  save,
  allowed = () => true,
  makeId = randomUUID,
}) {
  if (!allowed() || entry.equipment?.pending) return null;
  const current = await inventoryRead({ entry, type: "weapon", fetcher });
  const equipped = current.items.filter((item) => item.equipped === true);
  if (equipped.length !== 1) return null;
  const weapon = equipped[0];
  if (
    weapon.owned !== true ||
    (weapon.durability?.isBroken !== true && weapon.durability?.current !== 0)
  )
    return null;
  const id = inventoryEntityId("weapon", weapon);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const cost = weapon.durability?.repairCost;
  let wallet;
  try {
    wallet = await inventoryWallet({ entry, body: current.body, fetcher });
  } catch {
    /* Unknown funds never authorize spending. */
  }
  const canRepair =
    Number.isFinite(wallet?.pills) &&
    wallet.pills > 5000 &&
    Number.isFinite(cost) &&
    cost >= 0 &&
    wallet.pills >= cost;
  const run = (action) =>
    inventoryAction({
      entry,
      fetcher,
      save,
      allowed,
      commandId: makeId(),
      args: {
        type: "weapon",
        id,
        action,
        ...(action === "repair"
          ? { automatic: true, price: { currency: "pills", amount: cost } }
          : {}),
      },
    });
  let action = canRepair ? "repair" : "unequip";
  try {
    await run(action);
  } catch (error) {
    // A fresh quote/reserve check can change before submission. No pending means
    // no uncertain spend; only these explicit pre-submit rejections permit removal.
    if (
      action === "repair" &&
      !entry.equipment?.pending &&
      [
        "inventory_auto_repair_reserve",
        "inventory_balance_insufficient",
        "inventory_balance_unknown",
        "inventory_price_changed",
      ].includes(error.message)
    ) {
      action = "unequip";
      await run(action);
    } else throw error;
  }
  return { confirmed: true, action, weaponId: id };
}
