// Reconciliation and time-limited invitations share the urgent tier. Aging
// still lets older independent actions advance instead of starving forever.
export function actionQueuePriority(job, now) {
  return (
    (job.status === "reconciling" ? Math.max(job.priority, 60) : job.priority) +
    (now - job.createdAt) / 60_000
  );
}
