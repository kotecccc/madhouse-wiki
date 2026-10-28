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
    async run(job, reconcile, callback) {
      const context = { active: true, priority: reconcile ? 60 : job.priority };
      try {
        return await storage.run(context, callback);
      } finally {
        context.active = false;
      }
    },
  };
}
