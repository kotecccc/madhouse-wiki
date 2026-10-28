import { AsyncLocalStorage } from "node:async_hooks";

/** In-process permission for one already-persisted queue attempt. */
export function createQueueActionGate() {
  const storage = new AsyncLocalStorage();
  return Object.freeze({
    capture() {
      const context = storage.getStore();
      return (callback) =>
        context ? storage.run(context, callback) : callback();
    },
    async runWork(permit, callback) {
      if (typeof permit !== "function" || typeof callback !== "function")
        throw new TypeError("work_permit_required");
      const context = { workPermit: permit, active: true };
      try {
        return await storage.run(context, callback);
      } finally {
        context.active = false;
      }
    },
    async run(job, reconcile, authorization, callback, canDispatch) {
      if (typeof callback !== "function")
        throw new TypeError("callback_required");
      const context = {
        job,
        reconcile,
        authorization,
        canDispatch,
        active: true,
        used: false,
      };
      try {
        return await storage.run(context, callback);
      } finally {
        context.active = false;
      }
    },
    claim({ authorization, method, path, body }) {
      const context = storage.getStore();
      if (context?.active && typeof context.workPermit === "function")
        return (
          context.workPermit({ authorization, method, path, body }) === true
        );
      const job = context?.job;
      if (
        !context?.active ||
        context.used ||
        context.reconcile ||
        typeof context.canDispatch !== "function" ||
        typeof authorization !== "string" ||
        authorization !== context.authorization ||
        !["friend.response", "friend.remove"].includes(job?.type) ||
        job.status !== "running" ||
        typeof job.id !== "string" ||
        !job.id ||
        !Number.isSafeInteger(job.args?.playerId) ||
        job.args.playerId <= 0 ||
        (job.type === "friend.response" &&
          !["accept", "decline"].includes(job.args.decision))
      )
        return false;
      const accept =
        job.type === "friend.response" && job.args.decision === "accept";
      const expectedPath =
        job.type === "friend.remove"
          ? `/api/friends/${job.args.playerId}`
          : `/api/friends/requests/${job.args.playerId}${accept ? "/accept" : ""}`;
      if (path !== expectedPath || method !== (accept ? "POST" : "DELETE"))
        return false;
      try {
        if (context.canDispatch() !== true) return false;
      } catch {
        return false;
      }
      context.used = true;
      return true;
    },
  });
}
