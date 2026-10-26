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
  lock,
  unlock,
  refresh,
  invitations,
  accept,
  startSolo,
  onChange,
}) {
  let value = {
    ...(saved ?? { enabled: false, status: "stopped", bossId: null }),
    allowSolo: saved?.allowSolo ?? Boolean(startSolo),
  };
  let running = false;
  let ready = !saved?.enabled;
  const publish = (patch) => {
    value = { ...value, ...patch };
    onChange();
  };
  const stop = (status = "stopped", notice = "Рейд остановлен.") => {
    publish({ enabled: false, status, notice, nextCheckAt: null });
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
    start(bossId) {
      if (
        running ||
        value.enabled ||
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
        status: "waiting",
        bossId,
        nextCheckAt: now(),
        postBattleUntil: null,
        notice: "Ждём приглашения на выбранного босса.",
      });
      return true;
    },
    stop,
    canSuspend,
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
      if (!ready || !value.enabled || running) return;
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
        publish({
          status: "waiting",
          nextCheckAt: now() + 30000,
          notice: "Ждём восстановления связи с игрой.",
        });
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
            if (auto.start({ singleBattle: value.allowSolo }))
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
            (current.invitationOnly || value.allowSolo) &&
            auto.start({ singleBattle: value.allowSolo })
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
        let invitationReadFailed = false;
        try {
          await refresh({ force: battleJustEnded || recentBattle });
        } catch (error) {
          if (!value.allowSolo || uncertain()) throw error;
          invitationReadFailed = true;
        }
        if (!value.enabled) return;
        // Failed invitation discovery cannot veto a fresh solo preflight, but
        // stale invitation rows must never trigger an accept after that failure.
        const invitation = (invitationReadFailed ? [] : invitations()).find(
          (item) =>
            item.bossId === value.bossId &&
            item.available &&
            item.expiresAt > now(),
        );
        if (!invitation) {
          if (value.allowSolo && startSolo) {
            publish({
              status: "starting",
              notice:
                "Приглашений нет. Открываем свой бой в рамках заданных лимитов.",
            });
            await startSolo(
              () => value.enabled && goal.getSnapshot()?.status === "active",
            );
            if (!value.enabled) return;
            if (!auto.start({ singleBattle: true }))
              throw new Error("solo_start_unconfirmed");
            publish({
              status: "fighting",
              notice: "Бой идёт. После него снова проверим приглашения.",
            });
            return;
          }
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
        await accept(invitation.invitationId, () => value.enabled);
        if (!value.enabled) return;
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
        if (!auto.start({ singleBattle: value.allowSolo }))
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
