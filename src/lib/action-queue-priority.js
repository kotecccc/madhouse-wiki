// Reconciliation and time-limited invitations share the urgent tier. Aging
// still lets older independent actions advance instead of starving forever.
export function actionQueuePriority(job, now) {
  const urgentInvitation =
    job.type === "invitation.accept" &&
    Number.isFinite(job.args?.expiresAt) &&
    job.args.expiresAt - now <= 60_000;
  return (
    (job.status === "reconciling"
      ? Math.max(job.priority, 60)
      : urgentInvitation
        ? Math.max(job.priority, 59)
        : job.priority) +
    (now - (job.queueOrderAt ?? job.createdAt)) / 60_000
  );
}
