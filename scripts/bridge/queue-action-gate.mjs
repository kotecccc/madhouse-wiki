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
    claim({ authorization, method, path }) {
      const context = storage.getStore();
      const job = context?.job;
      if (
        !context?.active ||
        context.used ||
        context.reconcile ||
        typeof context.canDispatch !== "function" ||
        typeof authorization !== "string" ||
        authorization !== context.authorization ||
        job?.type !== "friend.response" ||
        job.status !== "running" ||
        typeof job.id !== "string" ||
        !job.id ||
        !Number.isSafeInteger(job.args?.playerId) ||
        job.args.playerId <= 0 ||
        !["accept", "decline"].includes(job.args.decision)
      )
        return false;
      const accept = job.args.decision === "accept";
      const expectedPath = `/api/friends/requests/${job.args.playerId}${accept ? "/accept" : ""}`;
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
