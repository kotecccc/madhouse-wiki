export function workCollectionCompleted(previous, current) {
  return Boolean(
    previous &&
    ["running", "paused"].includes(previous.status) &&
    previous.collectStash &&
    current?.config?.collectStash &&
    Number.isSafeInteger(current.workId) &&
    Number.isFinite(current.startedAt) &&
    previous.workId === current.workId &&
    previous.startedAt === current.startedAt &&
    previous.queueId === current.queueId &&
    current.status === "completed",
  );
}
