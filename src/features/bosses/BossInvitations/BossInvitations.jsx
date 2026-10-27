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
import { Toast } from "../../../components/ui/Toast/Toast.jsx";
import { bossInvitations } from "../BossBattle/boss-battle-session.js";
import "./BossInvitations.css";

export function BossInvitationsContent({
  state,
  preferredBossId,
  onAccept,
  onReconcile,
}) {
  const items = [...state.items].sort(
    (a, b) =>
      Number(b.bossId === preferredBossId) -
      Number(a.bossId === preferredBossId),
  );
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
      {items.map((item) => (
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
        </BaseCard>
      ))}
    </div>
  );
}

export function BossInvitationsDialog({ preferredBossId, onClose }) {
  const [queueNotice, setQueueNotice] = useState(false);
  const state = useSyncExternalStore(
    bossInvitations.subscribe,
    bossInvitations.getSnapshot,
    bossInvitations.getSnapshot,
  );
  useEffect(() => {
    void bossInvitations.refresh();
  }, []);
  const accept = async (id) => {
    if (await bossInvitations.accept(id)) setQueueNotice(true);
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
        onAccept={(id) => void accept(id)}
        onReconcile={() => void reconcile()}
      />
      {queueNotice && (
        <Toast
          floating
          success
          title="В очереди"
          onDismiss={() => setQueueNotice(false)}
        >
          Приглашение добавлено в очередь.
        </Toast>
      )}
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
