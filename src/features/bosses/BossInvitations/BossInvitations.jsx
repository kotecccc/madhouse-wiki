import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { useState, useSyncExternalStore } from "react";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../../components/ui/CardDescription/CardDescription.jsx";
import { Modal } from "../../../components/ui/Modal/Modal.jsx";
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
      {state.blocked && (
        <CardDescription>
          Чтобы принять другое приглашение, завершите текущий бой и остановите
          работающую автоматизацию.
        </CardDescription>
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
              state.blocked ||
              state.unresolved ||
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

export function BossInvitationsButton({ preferredBossId }) {
  const [open, setOpen] = useState(false);
  const sessionStatus = useSyncExternalStore(
    subscribeSession,
    () => readSession().status,
    () => "empty",
  );
  const state = useSyncExternalStore(
    bossInvitations.subscribe,
    bossInvitations.getSnapshot,
    bossInvitations.getSnapshot,
  );
  if (sessionStatus !== "ready") return null;
  const close = () => setOpen(false);
  const accept = async (id) => {
    if (await bossInvitations.accept(id)) close();
  };
  const reconcile = async () => {
    if (await bossInvitations.reconcile()) close();
  };
  return (
    <>
      <Button
        variant="secondary"
        aria-haspopup="dialog"
        onClick={() => {
          setOpen(true);
          void bossInvitations.refresh();
        }}
      >
        Приглашения на босса
      </Button>
      {open && (
        <Modal
          title="Приглашения на босса"
          loading={Boolean(state.pending)}
          contentVariant="inset"
          onClose={close}
          onRefresh={() => bossInvitations.refresh()}
          refreshKey="boss-invitations"
          footer={<Button onClick={close}>Закрыть</Button>}
        >
          <BossInvitationsContent
            state={state}
            preferredBossId={preferredBossId}
            onAccept={(id) => void accept(id)}
            onReconcile={() => void reconcile()}
          />
        </Modal>
      )}
    </>
  );
}
