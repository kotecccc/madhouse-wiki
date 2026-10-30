import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

export function withReadDiagnostic(context, callback) {
  return storage.run(context, callback);
}

export function currentReadDiagnostic() {
  return storage.getStore() ?? null;
}
