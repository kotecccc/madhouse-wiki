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
  const eventLog = (
    result,
    friendId = value.activeFriendId,
    bossId = value.bossId,
  ) =>
    value.mode === "buddy"
      ? [
          { at: now(), playerId: friendId, bossId, type: "raid", result },
          ...(value.log ?? []),
        ].slice(0, 30)
      : value.log;
  const matches = (item) => {
    const identity =
      value.mode === "buddy"
        ? positive(item?.inviterPlayerId) &&
          (value.friendIds ?? []).includes(item.inviterPlayerId)
        : positive(item?.leaderPlayerId) &&
          (positive(value.leaderPlayerId)
            ? item.leaderPlayerId === value.leaderPlayerId
            : Boolean(username(value.leaderUsername)) &&
              username(item.leaderUsername) ===
                username(value.leaderUsername)) &&
          item?.bossId === value.bossId;
    return (
      identity &&
      positive(item?.bossId) &&
      identifier(item.invitationId) &&
      identifier(item.battleId) &&
      item.available === true &&
      Number.isFinite(item.expiresAt) &&
      item.expiresAt > now()
    );
  };
  const fresh = () =>
    value.offlineAt == null &&
    Number.isFinite(value.lastReadAt) &&
    now() >= value.lastReadAt &&
    now() - value.lastReadAt <= FRESH_MS;
  const nextCandidate = () =>
    fresh() &&
    candidate &&
    matches(candidate) &&
    candidate.invitationId !== value.lastAttemptedInvitationId &&
    !(
      value.mode === "buddy" &&
      (value.attemptedInvitations ?? []).some(
        (item) => item.id === candidate.invitationId && item.expiresAt > now(),
      )
    )
      ? candidate
      : null;
  return {
    getSnapshot: () => structuredClone(value),
    start({
      leaderPlayerId,
      bossId,
      leaderName,
      bossName,
      leaderUsername,
      queueId = null,
    }) {
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
        mode: "subscription",
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
        queueId,
        startReceipts: queueId
          ? [
              ...(value.startReceipts ?? [])
                .filter((id) => id !== queueId)
                .slice(-127),
              queueId,
            ]
          : (value.startReceipts ?? []),
      });
      return true;
    },
    setBuddyFriends(friendIds) {
      if (
        !Array.isArray(friendIds) ||
        friendIds.length > 100 ||
        !friendIds.every(positive) ||
        new Set(friendIds).size !== friendIds.length
      )
        return false;
      if ((value.enabled || value.checkpoint) && value.mode !== "buddy")
        return false;
      candidate = null;
      if (!friendIds.length) {
        if (value.mode === "buddy") {
          const phase = !value.checkpoint
            ? "idle"
            : ["joining", "confirming", "fighting"].includes(value.phase)
              ? value.phase
              : "restoring";
          commit({ enabled: false, friendIds: [], phase });
        }
        return true;
      }
      if (value.mode !== "buddy" || (!value.enabled && !value.checkpoint)) {
        commit({
          mode: "buddy",
          enabled: true,
          friendIds: [...friendIds],
          phase: "monitoring",
          lastReadAt: null,
          lastSeenAt: now(),
          offlineAt: null,
          lastAttemptedInvitationId: null,
          checkpoint: null,
          battleId: null,
          bossId: null,
        });
      } else commit({ enabled: true, friendIds: [...friendIds] });
      return true;
    },
    discardFloorCheckpoint() {
      if (!value.checkpoint?.floorOwned) return;
      commit({
        checkpoint: {
          ...value.checkpoint,
          floorOwned: false,
          bossId: null,
          goal: null,
          auto: null,
          raidEnabled: false,
          businessRunning: false,
          workRunning: false,
        },
      });
    },
    discardWorkCheckpoint() {
      if (!value.checkpoint?.workRunning) return false;
      commit({
        checkpoint: {
          ...value.checkpoint,
          workRunning: false,
          workCancelled: true,
        },
      });
      return true;
    },
    discardBusinessCheckpoint({ ownsGoal = false, paused = false } = {}) {
      if (!value.checkpoint?.businessRunning && !(value.checkpoint && paused))
        return false;
      const clearGoal =
        ownsGoal &&
        !value.checkpoint.raidEnabled &&
        !value.checkpoint.raidPaused;
      commit({
        checkpoint: {
          ...value.checkpoint,
          businessRunning: false,
          businessPaused: false,
          businessCancelled: true,
          ...(clearGoal ? { bossId: null, goal: null, auto: null } : {}),
        },
      });
      return true;
    },
    discardRaidCheckpoint({ paused = false } = {}) {
      if (!value.checkpoint?.raidEnabled && !(value.checkpoint && paused))
        return false;
      const clearGoal =
        !value.checkpoint.businessRunning && !value.checkpoint.businessPaused;
      commit({
        checkpoint: {
          ...value.checkpoint,
          raidEnabled: false,
          raidPaused: false,
          raidCancelled: true,
          ...(clearGoal ? { bossId: null, goal: null, auto: null } : {}),
        },
      });
      return true;
    },
    discardAutoCheckpoint({ paused = false } = {}) {
      const checkpoint = value.checkpoint;
      if (
        (!checkpoint?.auto?.enabled && !(checkpoint && paused)) ||
        checkpoint.raidEnabled ||
        checkpoint.raidPaused ||
        checkpoint.businessRunning ||
        checkpoint.businessPaused
      )
        return false;
      commit({
        checkpoint: {
          ...checkpoint,
          bossId: null,
          goal: null,
          auto: null,
          autoPaused: false,
          autoCancelled: true,
        },
      });
      return true;
    },
    discardGoalCheckpoint() {
      const checkpoint = value.checkpoint;
      if (
        !checkpoint?.goal ||
        checkpoint.auto?.enabled ||
        checkpoint.autoPaused ||
        checkpoint.raidEnabled ||
        checkpoint.raidPaused ||
        checkpoint.businessRunning ||
        checkpoint.businessPaused
      )
        return false;
      commit({
        checkpoint: {
          ...checkpoint,
          bossId: null,
          goal: null,
          goalCancelled: true,
        },
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
      const eligible = (Array.isArray(items) ? items : []).filter(
        (item) =>
          matches(item) &&
          (value.mode !== "buddy" ||
            !(value.attemptedInvitations ?? []).some(
              (old) => old.id === item.invitationId && old.expiresAt > now(),
            )),
      );
      if (value.mode === "buddy")
        eligible.sort(
          (a, b) =>
            value.friendIds.indexOf(a.inviterPlayerId) -
              value.friendIds.indexOf(b.inviterPlayerId) ||
            a.expiresAt - b.expiresAt ||
            a.invitationId.localeCompare(b.invitationId),
        );
      candidate =
        value.mode === "buddy" &&
        eligible.some(
          (item) => item.inviterPlayerId !== value.lastServedFriendId,
        )
          ? eligible.find(
              (item) => item.inviterPlayerId !== value.lastServedFriendId,
            )
          : (eligible[0] ?? null);
      commit({
        ...(candidate &&
        value.mode !== "buddy" &&
        !positive(value.leaderPlayerId)
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
          if (result === "joined")
            commit({
              phase: "fighting",
              ...(value.mode === "buddy" ? { log: eventLog("joined") } : {}),
            });
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
          commit({
            phase: value.enabled ? "waiting" : "restoring",
            ...(value.mode === "buddy" ? { log: eventLog("finished") } : {}),
          });
        }
        if (value.phase === "waiting") {
          if (!value.enabled) commit({ phase: "restoring" });
          else {
            const invitation = nextCandidate();
            if (invitation) {
              const attempted = (value.attemptedInvitations ?? []).filter(
                (item) => item.expiresAt > now(),
              );
              if (value.mode === "buddy" && attempted.length >= 1000) return;
              commit({
                phase: "joining",
                lastAttemptedInvitationId: invitation.invitationId,
                battleId: invitation.battleId,
                ...(value.mode === "buddy"
                  ? {
                      bossId: invitation.bossId,
                      activeFriendId: invitation.inviterPlayerId,
                      lastServedFriendId: invitation.inviterPlayerId,
                      attemptedInvitations: [
                        ...attempted,
                        {
                          id: invitation.invitationId,
                          expiresAt: invitation.expiresAt,
                        },
                      ],
                    }
                  : {}),
              });
              try {
                await join(
                  invitation,
                  () =>
                    value.enabled &&
                    value.phase === "joining" &&
                    (value.mode !== "buddy" ||
                      value.friendIds.includes(invitation.inviterPlayerId)),
                );
              } catch {
                commit({
                  phase: "confirming",
                  ...(value.mode === "buddy"
                    ? { log: eventLog("uncertain") }
                    : {}),
                });
                return;
              }
              commit({
                phase: "fighting",
                ...(value.mode === "buddy" ? { log: eventLog("joined") } : {}),
              });
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
