import {
  INVENTORY_ACTION_TYPES,
  inventoryAction,
  inventoryEntityId,
  inventoryEquipped,
  inventoryPrice,
  inventoryRead,
  inventoryReadPath,
} from "./inventory-actions.mjs";

export function queuedInventoryAdapter({ entry, fetcher, save }) {
  async function reconcile(job) {
    try {
      const { items, path } = await inventoryRead({
        entry,
        type: job.args.type,
        zoneId: job.args.zoneId,
        fetcher,
      });
      const item = items.find(
        (value) => inventoryEntityId(job.args.type, value) === job.args.id,
      );
      const confirmed =
        item &&
        (job.args.action === "buy"
          ? item.owned === true
          : job.args.action === "repair"
            ? Number.isFinite(item.durability?.current) &&
              item.durability.current > 0 &&
              item.durability.current === item.durability.max &&
              item.durability.isBroken !== true
            : inventoryEquipped(job.args.type, item) ===
              (job.args.action === "equip"));
      if (!confirmed)
        return { status: "uncertain", reason: "Проверяем результат." };
      if (entry.equipment?.pending?.id === job.id) {
        entry.equipment = { pending: null, checked: true, paths: [path] };
        save(entry);
        if (entry.storageFailed)
          throw new Error("automation_storage_unavailable");
      }
      return { status: "completed" };
    } catch (error) {
      return {
        status: "uncertain",
        reason: [401, 403].includes(error.status)
          ? "game_session_required"
          : "Ожидаем игру.",
        retryAfterMs: error.retryAfterMs,
      };
    }
  }
  return {
    dedupeKey: (args) => JSON.stringify(args),
    validate(args) {
      if (
        !args ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        !INVENTORY_ACTION_TYPES[args.type] ||
        !Number.isSafeInteger(args.id) ||
        args.id <= 0 ||
        !["buy", "equip", "unequip", "repair"].includes(args.action) ||
        (args.action === "repair" && args.type !== "weapon") ||
        (args.action === "unequip" && !INVENTORY_ACTION_TYPES[args.type].remove)
      )
        throw new Error("invalid_inventory_action");
      inventoryReadPath(args.type, args.zoneId);
      const price = ["buy", "repair"].includes(args.action)
        ? inventoryPrice(args.price)
        : null;
      if (["buy", "repair"].includes(args.action) && !price)
        throw new Error("invalid_inventory_price");
      return {
        type: args.type,
        id: args.id,
        action: args.action,
        ...(args.zoneId != null ? { zoneId: args.zoneId } : {}),
        ...(price ? { price } : {}),
      };
    },
    async execute(job, { canDispatch }) {
      if (entry.equipment?.pending) {
        const previous = entry.equipment.pending;
        const oldArgs = previous.type
          ? {
              type: previous.type,
              id: previous.entityId,
              action: previous.action,
              zoneId: previous.zoneId,
            }
          : {
              type: "weapon",
              id: previous.weaponId,
              action: previous.equip ? "equip" : "unequip",
            };
        if (
          !INVENTORY_ACTION_TYPES[oldArgs.type] ||
          !Number.isSafeInteger(oldArgs.id) ||
          !["buy", "equip", "unequip", "repair"].includes(oldArgs.action)
        )
          return {
            status: "retry",
            reason: "Ожидаем сверку предыдущего действия.",
          };
        const result = await reconcile({ id: previous.id, args: oldArgs });
        if (result.status !== "completed")
          return {
            status: "retry",
            reason: result.reason,
            retryAfterMs: result.retryAfterMs,
          };
        if (
          job.args.action === "buy" &&
          oldArgs.action === "buy" &&
          job.args.type === oldArgs.type &&
          job.args.id === oldArgs.id &&
          (job.args.zoneId ?? null) === (oldArgs.zoneId ?? null)
        )
          return { status: "completed" };
      }
      try {
        await inventoryAction({
          entry,
          args: job.args,
          commandId: job.id,
          fetcher,
          save,
          allowed: canDispatch,
        });
        return { status: "completed" };
      } catch (error) {
        if (entry.equipment?.pending?.id === job.id)
          return {
            status: "uncertain",
            reason: "Проверяем результат.",
            retryAfterMs: error.retryAfterMs,
          };
        if (error.message === "inventory_action_cancelled")
          return { status: "retry" };
        if ([401, 403].includes(error.status))
          return { status: "failed", reason: "game_session_required" };
        if (error.status === 429)
          return {
            status: "retry",
            reason: "Ожидаем игру.",
            retryAfterMs: error.retryAfterMs,
          };
        // A 4xx response is flattened by the existing executor to this error;
        // never retry a rejected mutation as if it were a failed preflight.
        if (
          error.message === "inventory_action_failed" ||
          (error.status && error.status < 500)
        )
          return { status: "failed", reason: error.message };
        return {
          status: "retry",
          reason: "Ожидаем игру.",
          retryAfterMs: error.retryAfterMs,
        };
      }
    },
    reconcile,
  };
}
