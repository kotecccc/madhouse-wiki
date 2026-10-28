const INTERVAL_MS = 10000;
const POST_BATTLE_POLL_MS = 1000;
const POST_BATTLE_WINDOW_MS = 4000;

// The account heartbeat owns polling. Intent/checkpoints are persisted by onChange.
export function createRaidWaiter({
  saved,
  now = Date.now,
  state,
  goal,
  auto,
  available,
  priorityActive = () => false,
  canResume = () => true,
  lock,
  unlock,
  refresh,
  invitations,
  accept,
  onChange,
}) {
  let value = {
    ...(saved ?? { enabled: false, status: "stopped", bossId: null }),
    allowSolo: false,
  };
  let running = false;
  let ready = !saved?.enabled;
  const publish = (patch) => {
    value = { ...value, ...patch };
    onChange();
  };
  const stop = (status = "stopped", notice = "Рейд остановлен.") => {
    publish({
      enabled: false,
      userPaused: false,
      resumeRequested: false,
      stopAfterBattle: false,
      status,
      notice,
      nextCheckAt: null,
    });
    auto.stop();
  };
  const uncertain = () => {
    const current = state();
    return Boolean(
      current.pendingInvitation ||
      current.needsRefresh ||
      current.pending ||
      current.error ||
      current.purchase ||
      current.purchaseUncertain ||
      current.medicineOpen,
    );
  };
  const canSuspend = () =>
    !running && !uncertain() && state().battle?.status !== "active";
  return {
    getSnapshot: () => value,
    start(bossId, { queueId = null } = {}) {
      if (
        running ||
        value.enabled ||
        value.userPaused ||
        state().pending ||
        state().pendingInvitation ||
        state().purchase ||
        state().purchaseUncertain
      )
        return false;
      const current = state();
      if (current.battle?.status === "active") return false;
      ready = true;
      publish({
        enabled: true,
        userPaused: false,
        resumeRequested: false,
        stopAfterBattle: false,
        status: "waiting",
        bossId,
        queueId,
        startReceipts: [
          ...new Set(
            [...(value.startReceipts ?? []), value.queueId, queueId].filter(
              Boolean,
            ),
          ),
        ].slice(-128),
        nextCheckAt: now(),
        postBattleUntil: null,
        notice: "Ждём приглашения на выбранного босса.",
      });
      return true;
    },
    stop,
    finishAfterCurrent() {
      if (!value.enabled) return;
      const current = state();
      if (
        current.battle?.status !== "active" &&
        !current.pending &&
        !current.pendingInvitation &&
        !current.needsRefresh &&
        !["starting", "joining", "waiting_confirmation"].includes(value.status)
      ) {
        stop();
        goal.stop({ clearProgress: true });
        return;
      }
      publish({
        enabled: true,
        stopAfterBattle: true,
        status: "finishing",
        nextCheckAt: now(),
        notice: "Завершаем текущий бой; новые рейды начинаться не будут.",
      });
      goal.finishCurrentBattle?.();
      auto.finishCurrent?.();
    },
    pause() {
      if (!value.enabled) return false;
      // Persist the paused marker before stopping the strike engine. A restart
      // must not revive the old enabled auto checkpoint in between these steps.
      publish({
        enabled: false,
        userPaused: true,
        resumeRequested: false,
        status: "paused",
        nextCheckAt: null,
        notice: "Рейд на паузе.",
      });
      auto.stop();
      ready = false;
      return true;
    },
    resumePaused() {
      if (value.enabled && value.stopAfterBattle) {
        if (state().battle?.status !== "active") return false;
        auto.resumeSeries?.({ singleBattle: true });
        goal.resumeSeries?.();
        publish({
          stopAfterBattle: false,
          status: "fighting",
          nextCheckAt: now(),
          notice: "Рейд продолжен.",
        });
        return true;
      }
      if (!value.userPaused) return false;
      publish({ resumeRequested: true, notice: "Продолжаем рейд." });
      return true;
    },
    canSuspend,
    discardSuspended() {
      if ((ready && !value.userPaused) || running) return false;
      ready = false;
      publish({
        enabled: false,
        userPaused: false,
        resumeRequested: false,
        stopAfterBattle: false,
        status: "stopped",
        notice: "Рейд остановлен.",
        nextCheckAt: null,
      });
      return true;
    },
    suspend() {
      if (!canSuspend()) return false;
      ready = false;
      return true;
    },
    resume() {
      if (!value.enabled) return;
      if (uncertain() || value.status === "joining") {
        ready = true;
        publish({
          status: "waiting_confirmation",
          nextCheckAt: now() + 30000,
          notice:
            "Проверяем вступление в рейд. Повторный запрос принятия не отправляется.",
        });
        return;
      }
      ready = true;
      publish({ nextCheckAt: now() });
    },
    async tick() {
      if (
        !running &&
        value.userPaused &&
        value.resumeRequested &&
        canResume()
      ) {
        ready = true;
        publish({
          enabled: true,
          userPaused: false,
          resumeRequested: false,
          status: "waiting",
          nextCheckAt: now(),
        });
      }
      if (!ready || !value.enabled || running) return;
      if (value.stopAfterBattle) {
        const current = state();
        if (current.battle?.status === "active" && !uncertain()) {
          if (auto.getSnapshot().enabled) auto.finishCurrent?.();
          else auto.start({ singleBattle: true });
          return;
        }
        if (!uncertain()) {
          stop();
          goal.stop({ clearProgress: true });
          return;
        }
        if (now() < (value.nextCheckAt ?? 0) || !lock()) return;
        running = true;
        try {
          publish({ nextCheckAt: now() + 30000 });
          await refresh({ force: true });
        } catch {
          // Reconcile by reading; never replay an uncertain join or start.
        } finally {
          running = false;
          unlock();
        }
        return;
      }
      const currentGoal = goal.getSnapshot();
      if (!currentGoal || currentGoal.status !== "active") {
        stop(
          currentGoal?.status ?? "stopped",
          "Рейд завершён по настройкам автобоя.",
        );
        return;
      }
      if (auto.getSnapshot().enabled) return;
      const observedState = state();
      const battleJustEnded =
        value.status === "fighting" &&
        observedState.battle &&
        observedState.battle.status !== "active";
      if (battleJustEnded) {
        publish({
          status: "waiting",
          nextCheckAt: now(),
          postBattleUntil: now() + POST_BATTLE_WINDOW_MS,
          notice: "Бой завершён. Проверяем новые приглашения.",
        });
      }
      if (now() < (value.nextCheckAt ?? 0)) return;
      if (currentGoal.rewardUncertain) {
        publish({
          status: "waiting_confirmation",
          nextCheckAt: now() + 30000,
          notice: "Ждём подтверждения награды рейда.",
        });
        return;
      }
      if (!available()) {
        const priority = priorityActive();
        publish({
          status: "waiting",
          nextCheckAt: now() + (priority ? 1000 : 30000),
          notice: priority
            ? "Ожидаем прокачку характеристик."
            : "Ждём восстановления связи с игрой.",
        });
        if (priority && !uncertain()) return;
        if (lock()) {
          running = true;
          try {
            await refresh();
          } catch {
            /* Only reads are retried while the mode waits. */
          } finally {
            running = false;
            unlock();
          }
        }
        return;
      }
      if (auto.getSnapshot().enabled) return;
      if (!lock()) return;
      running = true;
      try {
        if (uncertain()) {
          publish({
            status: "waiting_confirmation",
            nextCheckAt: now() + 30000,
            notice: "Проверяем состояние рейда без повторного вступления.",
          });
          await refresh();
          if (
            value.enabled &&
            !uncertain() &&
            state().invitationOnly &&
            state().battle?.status === "active"
          ) {
            if (auto.start({ singleBattle: true }))
              publish({ status: "fighting", notice: "Рейд идёт." });
            return;
          }
          // A successful read can clear a stale state error or resolve an
          // expired invitation with no active battle. Continue into the normal
          // invitation read in this tick; otherwise recovery waits another
          // full polling interval despite already having fresh state.
          if (uncertain()) return;
          if (state().battle?.status === "active") return;
          publish({ nextCheckAt: now() });
        }
        const current = state();
        if (current.boss?.id !== value.bossId) throw new Error("boss_changed");
        if (current.battle?.status === "active") {
          if (
            (current.invitationOnly || value.status === "fighting") &&
            auto.start({ singleBattle: true })
          ) {
            publish({ status: "fighting", notice: "Рейд идёт." });
            return;
          }
          throw new Error("active_battle");
        }
        if (now() < (value.nextCheckAt ?? 0)) return;
        publish({
          status: "waiting",
          nextCheckAt: now() + INTERVAL_MS,
          notice: "Ждём приглашения на выбранного босса.",
        });
        const recentBattle = (value.postBattleUntil ?? 0) >= now();
        await refresh({ force: battleJustEnded || recentBattle });
        if (!value.enabled || value.stopAfterBattle) return;
        const invitation = invitations().find(
          (item) =>
            item.bossId === value.bossId &&
            item.available &&
            item.expiresAt > now(),
        );
        if (!invitation) {
          const keepPolling = (value.postBattleUntil ?? 0) >= now();
          publish({
            nextCheckAt:
              now() + (keepPolling ? POST_BATTLE_POLL_MS : INTERVAL_MS),
            ...(keepPolling ? {} : { postBattleUntil: null }),
          });
          return;
        }
        publish({
          status: "joining",
          notice: "Вступаем в рейд по приглашению…",
        });
        await accept(
          invitation.invitationId,
          () => value.enabled && !value.stopAfterBattle,
        );
        if (!value.enabled || value.stopAfterBattle) return;
        const joined = state();
        if (
          uncertain() ||
          !joined.invitationOnly ||
          joined.battle?.id !== invitation.battleId ||
          joined.battle?.status !== "active"
        )
          throw new Error("join_unconfirmed");
        publish({
          status: "fighting",
          postBattleUntil: null,
          notice: "Рейд идёт. После боя ждём следующее приглашение.",
        });
        if (!auto.start({ singleBattle: true }))
          throw new Error("attack_unavailable");
      } catch {
        if (value.enabled)
          publish({
            status: state().pendingInvitation
              ? "waiting_confirmation"
              : "waiting",
            nextCheckAt: now() + 30000,
            notice:
              "Ждём подтверждения состояния рейда. Запрос вступления не повторяется.",
          });
      } finally {
        running = false;
        unlock();
      }
    },
  };
}
