/** Permit only the checkpointed weapon maintenance selected by the combat worker. */
export function createWeaponRecoveryFetch({ fetcher, gate, entry, allowed }) {
  return (url, init = {}) => {
    const method = String(init.method || "GET").toUpperCase();
    if (!gate || method === "GET") return fetcher(url, init);
    const pending = entry.equipment?.pending;
    const path = new URL(url).pathname;
    const authorization = new Headers(init.headers).get("authorization");
    const repair = pending?.action === "repair";
    const valid =
      pending?.type === "weapon" &&
      Number.isSafeInteger(pending.entityId) &&
      pending.entityId > 0 &&
      ((repair && method === "POST" && path === "/api/weapons/repair") ||
        (pending.action === "unequip" &&
          method === "DELETE" &&
          path === "/api/weapons/select"));
    let body;
    try {
      body = init.body == null ? null : JSON.parse(init.body);
    } catch {
      body = null;
    }
    if (
      !valid ||
      (repair
        ? !body ||
          Object.keys(body).sort().join(",") !== "operationId,weaponId" ||
          body.weaponId !== pending.entityId ||
          body.operationId !== pending.operationId
        : init.body != null)
    )
      throw new Error("weapon_checkpoint_missing");
    let used = false;
    const permit = (request) => {
      const current = entry.equipment?.pending;
      if (
        used ||
        request.authorization !== authorization ||
        request.method !== method ||
        request.path !== path ||
        request.body !== init.body ||
        current?.id !== pending.id ||
        current?.operationId !== pending.operationId ||
        current?.entityId !== pending.entityId ||
        current?.action !== pending.action ||
        !allowed() ||
        (init.canDispatch && !init.canDispatch())
      )
        return false;
      used = true;
      return true;
    };
    return gate.runWork(permit, () => fetcher(url, init));
  };
}
