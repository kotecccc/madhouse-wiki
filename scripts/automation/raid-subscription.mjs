const QUIET_MS = 10 * 60 * 1000;
const FRESH_MS = 45 * 1000;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const identifier = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value);
const username = (value) => {
  const name = typeof value === "string" ? value.trim().replace(/^@/, "") : "";
  return /^[A-Za-z0-9_]{1,64}$/.test(name) ? name.toLowerCase() : "";
};

// This coordinator owns intent and transitions, not game POSTs. Every transition
// is saved before calling an effect; uncertain joins are reconciled by reads.
export function createRaidSubscription({
  saved = null,
  now = Date.now,
  persist,
  lock,
  unlock,
  capture,
  suspend,
  join,
  reconcile,
  battle,
  fight,
  restore,
  priorityActive = () => false,
}) {
  let value = saved
    ? structuredClone(saved)
    : { enabled: false, phase: "idle" };
  // Until the first successful read after a worker restart, elapsed time is
  // unobserved. It cannot count towards the quiet period.
  if (
    saved?.checkpoint &&
    value.offlineAt == null &&
    Number.isFinite(value.lastReadAt)
  )
    value.offlineAt = value.lastReadAt;
  let running = false;
  let candidate = null;
  const commit = (patch) => {
    value = { ...value, ...patch };
    if (persist(value) === false)
      throw new Error("subscription_storage_unavailable");
  };
  const matches = (item) =>
    positive(item?.leaderPlayerId) &&
    (positive(value.leaderPlayerId)
      ? item.leaderPlayerId === value.leaderPlayerId
      : Boolean(username(value.leaderUsername)) &&
        username(item.leaderUsername) === username(value.leaderUsername)) &&
    item?.bossId === value.bossId &&
    identifier(item.invitationId) &&
    identifier(item.battleId) &&
    item.available === true &&
    Number.isFinite(item.expiresAt) &&
    item.expiresAt > now();
  const fresh = () =>
    value.offlineAt == null &&
    Number.isFinite(value.lastReadAt) &&
    now() >= value.lastReadAt &&
    now() - value.lastReadAt <= FRESH_MS;
  const nextCandidate = () =>
    fresh() &&
    candidate &&
    matches(candidate) &&
    candidate.invitationId !== value.lastAttemptedInvitationId
      ? candidate
      : null;
  return {
    getSnapshot: () => structuredClone(value),
    start({ leaderPlayerId, bossId, leaderName, bossName, leaderUsername }) {
      if (
        value.enabled ||
        value.checkpoint ||
        (!positive(leaderPlayerId) && !username(leaderUsername)) ||
        !positive(bossId)
      )
        return false;
      candidate = null;
      commit({
        enabled: true,
        phase: "monitoring",
        leaderPlayerId: positive(leaderPlayerId) ? leaderPlayerId : null,
        bossId,
        leaderName:
          typeof leaderName === "string" ? leaderName.slice(0, 80) : "",
        bossName: typeof bossName === "string" ? bossName.slice(0, 80) : "",
        leaderUsername:
          typeof leaderUsername === "string" ? leaderUsername.slice(0, 80) : "",
        lastSeenAt: now(),
        lastReadAt: null,
        offlineAt: null,
        lastAttemptedInvitationId: null,
        checkpoint: null,
      });
      return true;
    },
    stop() {
      if (!value.enabled && !value.checkpoint) return;
      candidate = null;
      const phase = !value.checkpoint
        ? "idle"
        : ["joining", "confirming", "fighting"].includes(value.phase)
          ? value.phase
          : "restoring";
      commit({ enabled: false, phase });
    },
    observe(items, success) {
      if (!value.enabled && !value.checkpoint) return;
      if (!success) {
        candidate = null;
        if (value.offlineAt == null)
          commit({ offlineAt: value.lastReadAt ?? now() });
        return;
      }
      const at = now();
      const offlineDuration =
        value.offlineAt == null ? 0 : Math.max(0, at - value.offlineAt);
      candidate = (Array.isArray(items) ? items : []).find(matches) ?? null;
      commit({
        ...(candidate && !positive(value.leaderPlayerId)
          ? {
              leaderPlayerId: candidate.leaderPlayerId,
              leaderName: candidate.sender || value.leaderName,
            }
          : {}),
        offlineAt: null,
        lastReadAt: at,
        lastSeenAt: candidate ? at : value.lastSeenAt + offlineDuration,
      });
    },
    async tick() {
      if (running || (!value.enabled && !value.checkpoint) || !lock()) return;
      running = true;
      try {
        if (priorityActive()) {
          if (value.phase === "joining") commit({ phase: "confirming" });
          if (value.phase === "confirming") {
            const result = await reconcile(value);
            if (result === "joined") commit({ phase: "fighting" });
            else if (result === "absent")
              commit({ phase: value.enabled ? "waiting" : "restoring" });
          } else if (value.phase === "fighting") await battle(value);
          return;
        }
        if (value.phase === "monitoring") {
          if (!value.enabled || !nextCandidate()) return;
          const checkpoint = capture();
          if (!checkpoint) return;
          commit({ phase: "suspending", checkpoint });
        }
        if (value.phase === "suspending") {
          if (!(await suspend(value.checkpoint))) return;
          commit({ phase: value.enabled ? "waiting" : "restoring" });
        }
        if (value.phase === "joining") commit({ phase: "confirming" });
        if (value.phase === "confirming") {
          const result = await reconcile(value);
          if (result === "joined") commit({ phase: "fighting" });
          else if (result === "absent")
            commit({ phase: value.enabled ? "waiting" : "restoring" });
          else return;
        }
        if (value.phase === "fighting") {
          const current = await battle(value);
          if (current === "uncertain") return;
          if (current === "active") {
            await fight(value);
            return;
          }
          if (current !== "finished") return;
          commit({ phase: value.enabled ? "waiting" : "restoring" });
        }
        if (value.phase === "waiting") {
          if (!value.enabled) commit({ phase: "restoring" });
          else {
            const invitation = nextCandidate();
            if (invitation) {
              commit({
                phase: "joining",
                lastAttemptedInvitationId: invitation.invitationId,
                battleId: invitation.battleId,
              });
              try {
                await join(
                  invitation,
                  () => value.enabled && value.phase === "joining",
                );
              } catch {
                commit({ phase: "confirming" });
                return;
              }
              commit({ phase: "fighting" });
              return;
            }
            if (!fresh() || now() - value.lastSeenAt < QUIET_MS) return;
            commit({ phase: "restoring" });
          }
        }
        if (value.phase === "restoring") {
          // Never interrupt an active or uncertain battle, including after stop.
          const current = await battle(value);
          if (current === "active" || current === "uncertain") return;
          if (!(await restore(value.checkpoint))) return;
          commit({
            phase: value.enabled ? "monitoring" : "idle",
            checkpoint: null,
            battleId: null,
          });
        }
      } finally {
        running = false;
        unlock();
      }
    },
  };
}
