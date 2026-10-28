// The server reads fresh energy when the queued run begins; no browser budget
// or refill/purchase allowance is needed for MAX.
export function workMaxStartArgs(workId, view) {
  if (!Number.isSafeInteger(workId) || workId <= 0) return null;
  const completed =
    view?.workId === workId &&
    Number.isSafeInteger(view.completedCycles) &&
    view.completedCycles >= 0
      ? view.completedCycles
      : 0;
  if (!Number.isSafeInteger(completed + 1)) return null;
  return {
    workId,
    targetCycles: completed + 1,
    expectedCompletedCycles: completed,
    mode: "energy",
    maxActions: 30000,
    durationHours: null,
    maxBoosters: 0,
    maxDollar: 0,
    allowPurchase: false,
  };
}
