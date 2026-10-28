export function stashCraftCompleted(job, previousStatus, initialized) {
  return (
    job?.type === "stash.craft" &&
    job.status === "completed" &&
    previousStatus !== "completed" &&
    (previousStatus !== undefined || initialized)
  );
}
