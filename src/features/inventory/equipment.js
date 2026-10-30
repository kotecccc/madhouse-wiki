import { inventoryItems } from "./inventory.js";
import { inventoryActionConfirmed } from "./inventory-queue.js";

export async function sendInventoryCommand({
  post,
  item,
  action,
  type = item?.type,
  zoneId = item?.zoneId,
  makeId = () => crypto.randomUUID(),
  commandId: suppliedCommandId,
  onQueueAccepted,
}) {
  const run = async (stage, fn) => {
    try {
      return await fn();
    } catch (error) {
      error.inventoryStage = stage;
      throw error;
    }
  };
  const price =
    action === "repair"
      ? { currency: "pills", amount: item?.repairCost }
      : item?.facts?.purchasePrice;
  const args = {
    type,
    id: Number(item.id),
    action,
    ...(zoneId != null ? { zoneId: Number(zoneId) } : {}),
    ...(type === "clothing_item" && item?.categoryId != null
      ? { categoryId: Number(item.categoryId) }
      : {}),
    ...(["buy", "repair"].includes(action) ? { price } : {}),
  };
  const commandId = suppliedCommandId ?? makeId();
  const result = await run("command", async () => {
    try {
      return await post("/api/automation/commands", {
        id: commandId,
        // queue.enqueue requires an integer schema value but does not compare it.
        expectedVersion: 0,
        command: "queue.enqueue",
        args: { type: "inventory", action: args },
      });
    } catch (error) {
      if (error && typeof error === "object") error.commandId = commandId;
      throw error;
    }
  });
  try {
    onQueueAccepted?.(result);
  } catch {
    // The command is already accepted; a UI observer failure must not
    // make callers treat it as rejected and offer an unsafe retry.
  }
  return result;
}

export async function reconcileInventoryCommand({
  get,
  commandId,
  item,
  action,
  type = item?.type,
}) {
  const state = await get("/api/automation/state", {
    fresh: true,
    revalidate: false,
  });
  const accepted =
    Array.isArray(state?.receipts) && state.receipts.includes(commandId);
  const mappedId = state?.queueReceiptJobs?.find(
    ([receiptId]) => receiptId === commandId,
  )?.[1];
  const jobId = mappedId ?? commandId;
  const job = state?.queuedActions?.find(
    (entry) =>
      entry.id === jobId &&
      entry.type === "inventory" &&
      entry.args?.type === type &&
      String(entry.args?.id) === String(item?.id) &&
      entry.args?.action === action,
  );
  return {
    accepted,
    state,
    jobId: accepted ? (job?.id ?? null) : null,
  };
}

export async function verifyInventoryAction({
  get,
  item,
  action,
  type = item?.type,
  paths,
  references,
}) {
  const readState = () =>
    get("/api/automation/state", { fresh: true, revalidate: false });
  const hasNoPendingEquipment = (state) =>
    Boolean(
      state?.equipment &&
      Object.hasOwn(state.equipment, "pending") &&
      !state.equipment.pending,
    );

  const before = await readState();
  if (!hasNoPendingEquipment(before)) throw new Error("inventory_pending");

  const inventory = {};
  for (const path of paths)
    inventory[path] = await get(path, {
      fresh: true,
      serverRefresh: "live",
      revalidate: false,
    });

  const after = await readState();
  if (!hasNoPendingEquipment(after)) throw new Error("inventory_pending");
  const refreshedItem = inventoryItems(type, inventory, references).find(
    (entry) => String(entry.id) === String(item?.id),
  );
  return {
    confirmed: inventoryActionConfirmed(refreshedItem, action),
    refreshedItem: refreshedItem ?? null,
  };
}

export function sendEquipmentCommand(options) {
  return sendInventoryCommand({
    ...options,
    type: options.item?.type ?? "weapon",
    action: options.item?.equipped ? "unequip" : "equip",
  });
}

export async function inventoryNeedsCheck(get) {
  try {
    const state = await get("/api/automation/state", {
      fresh: true,
      revalidate: false,
    });
    if (!state.equipment || !("pending" in state.equipment)) return true;
    return Boolean(state.equipment.pending);
  } catch {
    return true;
  }
}
