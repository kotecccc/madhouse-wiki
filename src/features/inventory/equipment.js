export async function sendInventoryCommand({
  get,
  post,
  item,
  action,
  refreshOnly = false,
  type = item?.type,
  zoneId = item?.zoneId,
  makeId = () => crypto.randomUUID(),
}) {
  const run = async (stage, fn) => {
    try {
      return await fn();
    } catch (error) {
      error.inventoryStage = stage;
      throw error;
    }
  };
  const state = await run("state", () =>
    get("/api/automation/state", {
      fresh: true,
      revalidate: false,
    }),
  );
  const price =
    action === "repair"
      ? { currency: "pills", amount: item?.repairCost }
      : item?.facts?.purchasePrice;
  const args = refreshOnly
    ? { type, ...(zoneId != null ? { zoneId: Number(zoneId) } : {}) }
    : {
        type,
        id: Number(item.id),
        action,
        ...(zoneId != null ? { zoneId: Number(zoneId) } : {}),
        ...(["buy", "repair"].includes(action) ? { price } : {}),
      };
  const result = await run("command", () =>
    post("/api/automation/commands", {
      id: makeId(),
      expectedVersion: state.version,
      command: refreshOnly ? "inventory.refresh" : "inventory.action",
      args,
    }),
  );
  if (result.equipment?.pending) throw new Error("inventory_pending");
  const paths = result.equipment?.paths || [];
  for (const path of paths)
    await run("inventory", () => get(path, { fresh: true, revalidate: false }));
  if (paths.length)
    await run("profile", () =>
      get("/api/me", { fresh: true, revalidate: false }),
    );
  return result;
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
