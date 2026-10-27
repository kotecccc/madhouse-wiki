const positive = (value) => Number.isSafeInteger(value) && value > 0;

export function queuedSubscriptionAdapter({ entry, getBoss, refresh, now }) {
  const started = (job) =>
    (entry.raidSubscription.getSnapshot().startReceipts ?? []).includes(job.id);
  return {
    validate(args) {
      const username =
        typeof args?.leaderUsername === "string"
          ? args.leaderUsername.trim().replace(/^@/, "")
          : "";
      if (
        !positive(args?.bossId) ||
        (!positive(args.leaderPlayerId) &&
          !/^[A-Za-z0-9_]{1,64}$/.test(username)) ||
        (username && !/^[A-Za-z0-9_]{1,64}$/.test(username))
      )
        throw new Error("invalid_subscription");
      return {
        bossId: args.bossId,
        leaderPlayerId: positive(args.leaderPlayerId)
          ? args.leaderPlayerId
          : null,
        leaderUsername: username,
      };
    },
    dedupeKey: (args) =>
      `${args.bossId}:${args.leaderPlayerId ?? args.leaderUsername.toLowerCase()}`,
    async execute(job, { canDispatch }) {
      if (started(job)) return { status: "completed" };
      let matching = null;
      let boss = null;
      try {
        if (job.args.leaderPlayerId) {
          await refresh();
          matching = entry.invitations.items.find(
            (item) =>
              item.leaderPlayerId === job.args.leaderPlayerId &&
              item.bossId === job.args.bossId &&
              item.available &&
              item.expiresAt > now(),
          );
          if (!matching)
            return { status: "retry", reason: "Ожидаем приглашение." };
        } else {
          boss = await getBoss(job.args.bossId);
          if (
            !boss ||
            Number(boss.numericId ?? boss.apiId ?? boss.id) !== job.args.bossId
          )
            return { status: "failed", reason: "unknown_boss" };
        }
        if (!canDispatch()) return { status: "retry" };
        if (
          !entry.raidSubscription.start({
            leaderPlayerId: matching?.leaderPlayerId,
            bossId: job.args.bossId,
            leaderName: matching?.sender ?? job.args.leaderUsername,
            bossName: matching?.bossName ?? boss?.name,
            leaderUsername: matching?.leaderUsername ?? job.args.leaderUsername,
            queueId: job.id,
          })
        )
          return { status: "retry", reason: "Ожидаем другие действия." };
        if (matching)
          entry.raidSubscription.observe(entry.invitations.items, true);
        return { status: "completed" };
      } catch (error) {
        if (started(job) || entry.storageFailed) return { status: "uncertain" };
        if ([401, 403].includes(error.status))
          return { status: "failed", reason: "game_session_required" };
        return {
          status: "retry",
          reason: "Ожидаем игру.",
          retryAfterMs: error.retryAfterMs,
        };
      }
    },
    async reconcile(job) {
      return started(job) ? { status: "completed" } : { status: "retry" };
    },
  };
}
