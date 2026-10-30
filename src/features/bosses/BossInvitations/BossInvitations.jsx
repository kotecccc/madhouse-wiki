import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
import {
  automationState,
  bossInvitations,
} from "../BossBattle/boss-battle-session.js";
import "./BossInvitations.css";

const queueBlockNotices = {
  credentials: "Требуется войти в игру.",
  storage: "Ожидаем доступности сервера.",
  action: "Ожидаем завершения других действий.",
  dependency: "Ожидаем подтверждения предыдущего действия.",
  game: "Ожидаем доступности игры.",
  rate: "Ожидаем окончания ограничения запросов.",
};

function queuedInvitationNotice(job) {
  if (!job) return null;
  const reason = job.reason || queueBlockNotices[job.blockedBy];
  if (job.status === "reconciling")
    return `Результат вступления не подтверждён. ${reason || "Проверяем состояние игры."} Повтор не будет отправлен до подтверждения.`;
  if (reason) return reason;
  if (job.status === "queued") return "Принятие ожидает отправки в игру.";
  if (job.status === "waiting")
    return "Ожидаем возможности принять приглашение.";
  if (job.status === "running") return "Принятие приглашения выполняется.";
  return null;
}

export function BossInvitationsContent({
  state,
  preferredBossId,
  queuedJobs = [],
  onAccept,
  onReconcile,
}) {
  const items = [...state.items].sort(
    (a, b) =>
      Number(b.bossId === preferredBossId) -
      Number(a.bossId === preferredBossId),
  );
  const unresolvedJob = queuedJobs.find((job) => job.status === "reconciling");
  return (
    <div className="boss-invitations-list">
      <CardDescription>
        Друзья уже начали бой — присоединитесь к их рейду. Автобой можно
        включить после вступления.
      </CardDescription>
      {state.notice && (
        <CardDescription role="status">{state.notice}</CardDescription>
      )}
      <ErrorToast message={state.error} />
      {state.unresolved && (
        <>
          <ErrorToast message="Результат вступления пока не подтверждён. Проверка обновит состояние и не отправит принятие повторно." />
          {queuedInvitationNotice(unresolvedJob) && (
            <CardDescription role="status">
              {queuedInvitationNotice(unresolvedJob)}
            </CardDescription>
          )}
          <Button disabled={state.pending} onClick={onReconcile}>
            Проверить вступление
          </Button>
        </>
      )}
      {!state.loaded && (
        <CardDescription>
          {state.pending
            ? "Загрузка приглашений…"
            : "Обновите список приглашений."}
        </CardDescription>
      )}
      {state.loaded && items.length === 0 && (
        <CardDescription>Входящих приглашений нет.</CardDescription>
      )}
      {items.map((item) => {
        const queuedJob = queuedJobs.find(
          (job) => job.args?.invitationId === item.invitationId,
        );
        const queueNotice = queuedInvitationNotice(queuedJob);
        return (
          <BaseCard key={item.invitationId}>
            <CardTitle>{item.bossName}</CardTitle>
            <CardDescription>Зовёт: {item.sender}</CardDescription>
            {!item.available && (
              <CardDescription>Приглашение больше недоступно.</CardDescription>
            )}
            <Button
              variant="primary"
              disabled={
                state.pending ||
                state.queuedIds?.includes(item.invitationId) ||
                !item.available
              }
              onClick={() => onAccept(item.invitationId)}
            >
              Принять и открыть бой
            </Button>
            {queueNotice && (
              <CardDescription role="status">{queueNotice}</CardDescription>
            )}
          </BaseCard>
        );
      })}
    </div>
  );
}

export function BossInvitationsDialog({ preferredBossId, onClose }) {
  const state = useSyncExternalStore(
    bossInvitations.subscribe,
    bossInvitations.getSnapshot,
    bossInvitations.getSnapshot,
  );
  const automation = useSyncExternalStore(
    automationState.subscribe,
    automationState.getSnapshot,
    automationState.getSnapshot,
  );
  const queuedJobs = (automation.data?.queuedActions ?? []).filter(
    (job) =>
      job.type === "invitation.accept" &&
      ["queued", "waiting", "running", "reconciling"].includes(job.status),
  );
  useEffect(() => {
    void bossInvitations.refresh();
  }, []);
  const accept = async (id) => {
    await bossInvitations.accept(id);
  };
  const reconcile = async () => {
    if (await bossInvitations.reconcile()) onClose();
  };
  return (
    <Modal
      title="Приглашения на босса"
      loading={Boolean(state.pending)}
      contentVariant="inset"
      onClose={onClose}
      onRefresh={() => bossInvitations.refresh()}
      refreshKey="boss-invitations"
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <BossInvitationsContent
        state={state}
        preferredBossId={preferredBossId}
        queuedJobs={queuedJobs}
        onAccept={(id) => void accept(id)}
        onReconcile={() => void reconcile()}
      />
    </Modal>
  );
}

export function BossInvitationsButton({ preferredBossId }) {
  const [open, setOpen] = useState(false);
  const sessionStatus = useSyncExternalStore(
    subscribeSession,
    () => readSession().status,
    () => "empty",
  );
  if (sessionStatus !== "ready") return null;
  return (
    <>
      <Button
        variant="secondary"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        Приглашения на босса
      </Button>
      {open && (
        <BossInvitationsDialog
          preferredBossId={preferredBossId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}
