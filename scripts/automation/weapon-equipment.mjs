const path = "https://cargohustle.online/api/clothing/by-category/1";
const fail = (status, message) => Object.assign(new Error(message), { status });
export async function weaponEquipment({
  entry,
  args,
  commandId,
  refreshOnly = false,
  fetcher,
  save,
}) {
  if (refreshOnly && entry.equipment?.pending?.type)
    throw fail(409, "inventory_pending");
  if (
    !refreshOnly &&
    (!Number.isSafeInteger(args.weaponId) ||
      args.weaponId <= 0 ||
      typeof args.equip !== "boolean")
  )
    throw fail(400, "invalid_weapon_equipment");
  const headers = {
    Authorization: entry.credential,
    Accept: "application/json",
  };
  async function read() {
    const response = await fetcher(path, {
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw fail(503, "weapon_inventory_unavailable");
    const body = await response.json();
    if (!Array.isArray(body?.items) || body.success === false)
      throw fail(503, "weapon_inventory_unavailable");
    return body.items;
  }
  const items = await read();
  if (refreshOnly) {
    entry.equipment = { pending: null, checked: true };
    save(entry);
    return;
  }
  if (entry.equipment?.pending) throw fail(409, "weapon_equipment_uncertain");
  const item = items.find(
    (item) =>
      Number(item.weaponId ?? item.id) === args.weaponId &&
      (!item.kind || item.kind === "weapon"),
  );
  if (!item || item.owned !== true) throw fail(409, "weapon_not_owned");
  if (args.equip && item.equipped === true) return;
  if (!args.equip && item.equipped !== true)
    throw fail(409, "weapon_equipment_changed");
  entry.equipment = {
    pending: { id: commandId, weaponId: args.weaponId, equip: args.equip },
    checked: false,
  };
  save(entry);
  if (entry.storageFailed) throw fail(503, "automation_storage_unavailable");
  try {
    const response = await fetcher(
      "https://cargohustle.online/api/weapons/select",
      {
        method: args.equip ? "PUT" : "DELETE",
        headers: {
          ...headers,
          ...(args.equip ? { "Content-Type": "application/json" } : {}),
        },
        ...(args.equip
          ? { body: JSON.stringify({ weaponId: args.weaponId }) }
          : {}),
        redirect: "error",
        signal: AbortSignal.timeout(20000),
      },
    );
    if (!response.ok) {
      // A definite client rejection is not an uncertain submission.
      if (response.status >= 400 && response.status < 500) {
        entry.equipment.pending = null;
        save(entry);
      }
      throw fail(503, "weapon_equipment_failed");
    }
    const confirmed = await read();
    const selected = confirmed.find(
      (item) => Number(item.weaponId ?? item.id) === args.weaponId,
    );
    if (!selected || selected.equipped !== args.equip)
      throw fail(409, "weapon_equipment_unconfirmed");
    entry.equipment = { pending: null, checked: true };
    save(entry);
  } catch (error) {
    // Preserve pending state for explicit read-only reconciliation; never replay.
    save(entry);
    throw error;
  }
}
