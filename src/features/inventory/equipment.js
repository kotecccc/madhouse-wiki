export async function sendEquipmentCommand({
  get,
  post,
  item,
  refreshOnly = false,
  makeId = () => crypto.randomUUID(),
}) {
  const state = await get("/api/automation/state", {
    fresh: true,
    revalidate: false,
  });
  if (!refreshOnly && state.equipment?.pending)
    throw new Error("equipment_pending");
  const result = await post("/api/automation/commands", {
    id: makeId(),
    expectedVersion: state.version,
    command: refreshOnly ? "equipment.refresh" : "equipment.weapon",
    args: refreshOnly
      ? {}
      : { weaponId: Number(item.id), equip: !item.equipped },
  });
  if (result.equipment?.pending) throw new Error("equipment_pending");
  return get("/api/clothing/by-category/1", { fresh: true, revalidate: false });
}
