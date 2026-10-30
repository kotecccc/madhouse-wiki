import { AsyncLocalStorage } from "node:async_hooks";

// Async work scheduled by an adapter may outlive the queue attempt. Once the
// attempt ends it must use its own background priority, not inherit urgency.
export function createRequestPriorityContext() {
  const storage = new AsyncLocalStorage();
  return {
    current() {
      const context = storage.getStore();
      return context?.active ? context.priority : null;
    },
    capture() {
      const context = storage.getStore();
      return () => (context?.active ? context.reservation : null);
    },
    noteUnsentMutation() {
      const context = storage.getStore();
      if (context?.active) context.unsentMutation = true;
    },
    async run(job, reconcile, callback, reservation) {
      const context = {
        active: true,
        priority: reconcile ? 60 : job.priority,
        reservation,
      };
      try {
        const result = await storage.run(context, callback);
        return context.unsentMutation && result?.status === "retry"
          ? { ...result, unsentMutation: true }
          : result;
      } finally {
        context.active = false;
      }
    },
  };
}
