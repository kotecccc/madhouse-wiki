import { AsyncLocalStorage } from "node:async_hooks";

// This context is created inside the Wiki process, never from client input.
const storage = new AsyncLocalStorage();

export function withWorkerLease(owner, now, callback) {
  return storage.run({ owner, now }, callback);
}

export function currentWorkerLease() {
  return storage.getStore() ?? null;
}
