import { randomUUID } from "node:crypto";
import {
  normalizeBoosters,
  normalizeEnergy,
} from "../../src/features/works/WorkFarm/work-farm-plan.js";

export function queuedEnergyBoosterAdapter({ entry, fetcher, save }) {
  const commit = () => {
    save(entry);
    if (entry.storageFailed) throw new Error("storage_unavailable");
  };
  const read = async (path) => {
    const response = await fetcher(`https://cargohustle.online${path}`, {
      headers: {
        Authorization: entry.credential,
        Accept: "application/json",
        "X-Madhouse-Snapshot-Refresh": "live",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error("read_unavailable");
    return response.json();
  };
  const view = async (type) => {
    const [me, bag] = await Promise.all([read("/api/me"), read("/api/me/bag")]);
    const booster = normalizeBoosters(bag).find((item) => item.type === type);
    const energy = normalizeEnergy(me.energy);
    if (!booster) throw new Error("read_unavailable");
    const dollar =
      Number.isSafeInteger(me.wallet?.dollar) && me.wallet.dollar >= 0
        ? me.wallet.dollar
        : null;
    return { booster, energy, dollar };
  };
  const post = async (path, body, canDispatch) =>
    fetcher(`https://cargohustle.online${path}`, {
      method: "POST",
      headers: {
        Authorization: entry.credential,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(20000),
      canDispatch,
    });
  const done = (id) => entry.energyBooster.receipts.includes(id);
  async function reconcile(job) {
    if (done(job.id)) return { status: "completed" };
    const pending = entry.energyBooster.pending;
    if (!pending || pending.id !== job.id)
      return { status: "uncertain", reason: "Проверяем результат." };
    if (pending.phase === "purchased") {
      if (job.cancelRequested) {
        entry.energyBooster.pending = null;
        commit();
      }
      return { status: "retry" };
    }
    try {
      const current = await view(pending.type);
      if (
        pending.phase === "buying" &&
        current.booster.count === pending.count + 1 &&
        current.dollar === pending.dollar - pending.price
      ) {
        entry.energyBooster.pending = job.cancelRequested
          ? null
          : { ...pending, phase: "purchased" };
        commit();
        return { status: "retry" };
      }
      if (
        pending.phase === "using" &&
        current.booster.count === pending.count - 1 &&
        current.energy.current >=
          Math.min(pending.restoreEnergy, current.energy.max)
      ) {
        entry.energyBooster.pending = null;
        entry.energyBooster.receipts = [
          ...entry.energyBooster.receipts.slice(-127),
          job.id,
        ];
        commit();
        return { status: "completed" };
      }
    } catch {
      /* Keep the checkpoint until the game confirms the result. */
    }
    return {
      status: "uncertain",
      reason: "Проверяем результат дефибриллятора.",
    };
  }
  async function execute(job, { canDispatch }) {
    if (done(job.id)) return { status: "completed" };
    let pending = entry.energyBooster.pending;
    if (pending && pending.id !== job.id)
      return {
        status: "retry",
        reason: "Ожидаем проверку предыдущего действия.",
      };
    if (pending && pending.phase !== "purchased") return reconcile(job);
    let current;
    try {
      current = await view(job.args.type);
    } catch {
      return { status: "retry", reason: "Ожидаем игру." };
    }
    if (
      current.energy.current >=
      Math.min(current.booster.restoreEnergy, current.energy.max)
    ) {
      if (pending) {
        entry.energyBooster.pending = null;
        commit();
      }
      return { status: "failed", reason: "energy_already_full" };
    }
    if (!canDispatch()) return { status: "retry" };
    if (current.booster.count === 0) {
      if (pending)
        return {
          status: "uncertain",
          reason: "Проверяем купленный дефибриллятор.",
        };
      if (
        job.args.maxPrice == null ||
        current.booster.costDollar !== job.args.maxPrice ||
        current.booster.maxPurchaseQuantity < 1 ||
        current.dollar == null ||
        current.dollar < current.booster.costDollar
      )
        return {
          status: "failed",
          reason: "energy_booster_quote_changed",
        };
      const operationId = randomUUID();
      entry.energyBooster.pending = {
        id: job.id,
        type: job.args.type,
        phase: "buying",
        count: current.booster.count,
        dollar: current.dollar,
        price: current.booster.costDollar,
        operationId,
      };
      commit();
      try {
        await post(
          "/api/me/bag/boosters/buy",
          { type: job.args.type, quantity: 1, operationId },
          canDispatch,
        );
      } catch (error) {
        if (error?.notDispatched) {
          entry.energyBooster.pending = null;
          commit();
          return { status: "retry" };
        }
      }
      return reconcile(job);
    }
    entry.energyBooster.pending = {
      id: job.id,
      type: job.args.type,
      phase: "using",
      count: current.booster.count,
      restoreEnergy: current.booster.restoreEnergy,
    };
    commit();
    try {
      await post(
        "/api/me/bag/boosters/use",
        { type: job.args.type },
        canDispatch,
      );
    } catch (error) {
      if (error?.notDispatched) {
        entry.energyBooster.pending = null;
        commit();
        return { status: "retry" };
      }
    }
    return reconcile(job);
  }
  const wrap =
    (method, blockedStatus) =>
    async (...args) => {
      const running = entry.workFarm.running();
      if (running && !entry.workFarm.suspendForManual())
        return { status: blockedStatus };
      try {
        return await method(...args);
      } finally {
        if (running) entry.workFarm.resume();
      }
    };
  return {
    validate(args) {
      if (
        !["small", "full"].includes(args?.type) ||
        (args.maxPrice != null &&
          (!Number.isSafeInteger(args.maxPrice) || args.maxPrice < 0))
      )
        throw new Error("invalid_energy_booster");
      return { type: args.type, maxPrice: args.maxPrice ?? null };
    },
    dedupeKey: (args) => args.type,
    execute: wrap(execute, "retry"),
    reconcile: wrap(reconcile, "uncertain"),
  };
}
