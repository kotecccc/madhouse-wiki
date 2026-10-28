import { useEffect, useRef, useState } from "react";
import {
  getSessionJson,
  postSessionJson,
} from "../../../shared/session-api.js";
import { authorizeRequest } from "../../../shared/auth-session.js";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { ApprovableButton } from "../../components/ui/ConfirmButton/ConfirmButton.jsx";
import { CardActionMenu } from "../../components/ui/CardActionMenu/CardActionMenu.jsx";
import { Disclosure } from "../../components/ui/Disclosure/Disclosure.jsx";
import { Pill } from "../../components/ui/Pill/Pill.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { ImageCard } from "../../components/ui/ImageCard/ImageCard.jsx";
import { Icon } from "../../components/ui/Icon/Icon.jsx";
import { Skeleton } from "../../components/ui/Skeleton/Skeleton.jsx";
import { sendFriendCommand } from "./friend-commands.js";
import { normalizeFriend } from "./friends.js";

async function loadIncoming(signal) {
  const items = new Map();
  const seen = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({ limit: "100" });
    if (cursor) params.set("cursor", cursor);
    const data = await getSessionJson(
      `/api/friends/requests/incoming?${params}`,
      { signal, fresh: true, serverRefresh: "live", revalidate: false },
    );
    if (
      !Array.isArray(data?.items) ||
      !Object.hasOwn(data, "nextCursor") ||
      data.error ||
      data.partial ||
      data.success === false
    )
      throw new Error("incomplete");
    for (const row of data.items) {
      const player = normalizeFriend(row?.player);
      items.set(player.playerId, player);
    }
    cursor = data.nextCursor;
    if (cursor == null || cursor === "") return [...items.values()];
    if (typeof cursor !== "string" || seen.has(cursor))
      throw new Error("incomplete");
    seen.add(cursor);
  }
  throw new Error("incomplete");
}

function RequestCard({ player, pending, busy, send }) {
  const [anchor, setAnchor] = useState(null);
  const [closing, setClosing] = useState(false);
  const name = player.nickname || player.username || "Игрок";
  const finish = () => {
    setAnchor(null);
    setClosing(false);
  };
  const close = () => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches)
      finish();
    else setClosing(true);
  };
  const open = (event) => {
    if (event.target.closest("button, input, select, a, [role=dialog]")) return;
    if (anchor) close();
    else {
      setClosing(false);
      setAnchor(event.currentTarget);
    }
  };
  return (
    <BaseCard
      as="article"
      padding="12"
      state={anchor ? "menu-active" : undefined}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-expanded={Boolean(anchor)}
      aria-label={`Действия: ${name}`}
      onClick={open}
      onKeyDown={(event) => {
        if (
          event.target !== event.currentTarget ||
          !["Enter", " "].includes(event.key)
        )
          return;
        event.preventDefault();
        open(event);
      }}
    >
      <div className="friends-card-content">
        <div className="friends-card-heading">
          <div className="friends-identity">
            <div
              className="friends-avatar"
              aria-label={
                player.isOnline === true
                  ? "В сети"
                  : player.isOnline === false
                    ? "Не в сети"
                    : "Статус неизвестен"
              }
            >
              <ImageCard
                variant="avatar"
                src={player.avatarUrl}
                alt=""
                size={48}
                imageSize={48}
              />
              {player.isOnline === true && (
                <span
                  className="ui-status-list-dot ui-status-list-dot--success friends-status-dot"
                  aria-hidden="true"
                />
              )}
            </div>
            <div className="friends-name">
              <CardTitle>{name}</CardTitle>
              {player.username && (
                <CardDescription>@{player.username}</CardDescription>
              )}
            </div>
          </div>
          {player.level != null && (
            <Pill size="xs" dot={false}>
              {new Intl.NumberFormat("ru-RU").format(player.level)} ур.
            </Pill>
          )}
        </div>
        <div className="friends-stats">
          {[
            ["madness", "Безумие"],
            ["aggression", "Агрессия"],
            ["rage", "Ярость"],
          ].map(([key, label]) => {
            const value =
              player[key] == null
                ? "—"
                : new Intl.NumberFormat("ru-RU").format(player[key]);
            return (
              <CardDescription
                className="friends-stat"
                key={key}
                aria-label={`${label}: ${value}`}
              >
                <Icon type={key} size="text" /> <span>{value}</span>
              </CardDescription>
            );
          })}
        </div>
        {pending && (
          <CardDescription role="status">Проверяем заявку</CardDescription>
        )}
      </div>
      {anchor && (
        <CardActionMenu
          anchor={anchor}
          label={`Действия: ${name}`}
          preferFit
          onClose={close}
          closing={closing}
          onClosed={finish}
        >
          <Button
            variant="menu-item"
            icon="check"
            disabled={busy || pending}
            onClick={() => {
              finish();
              void send(player, "accept");
            }}
          >
            Принять заявку
          </Button>
          <ApprovableButton
            variant="menu-item"
            icon="close"
            confirmationKey={`decline:${player.playerId}`}
            confirmationLabel="Точно отклонить?"
            disabled={busy || pending}
            onClick={() => {
              finish();
              void send(player, "decline");
            }}
          >
            Отклонить заявку
          </ApprovableButton>
        </CardActionMenu>
      )}
    </BaseCard>
  );
}

export function FriendsRequests({
  active,
  refreshGeneration = 0,
  automation,
  onAutomation,
  onNotice,
}) {
  const [requests, setRequests] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(null);
  const lock = useRef(false);
  useEffect(() => {
    if (!active) return undefined;
    const controller = new AbortController();
    let timer;
    const load = async () => {
      try {
        const items = await loadIncoming(controller.signal);
        if (!controller.signal.aborted) {
          setRequests(items);
          setError(false);
        }
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
      if (!controller.signal.aborted) timer = setTimeout(load, 15000);
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, refreshGeneration]);
  const pendingIds = new Set(
    (automation?.queuedActions ?? [])
      .filter(
        (job) =>
          job.type === "friend.response" &&
          ["queued", "waiting", "running", "reconciling"].includes(job.status),
      )
      .map((job) => job.args?.playerId),
  );
  if (automation?.friendResponse?.pending?.args?.playerId)
    pendingIds.add(automation.friendResponse.pending.args.playerId);
  const send = async (player, decision) => {
    await sendMany([player], decision);
  };
  const sendMany = async (players, decision) => {
    if (lock.current) return;
    lock.current = true;
    setBusy("batch");
    let submitted = 0;
    const remaining = players.filter(
      (player) => !pendingIds.has(player.playerId),
    );
    try {
      const originalCredential = authorizeRequest({
        url: "/api/automation/state",
      }).headers.Authorization;
      for (const player of remaining) {
        if (
          authorizeRequest({ url: "/api/automation/state" }).headers
            .Authorization !== originalCredential
        )
          throw new Error("session_changed");
        const result = await sendFriendCommand({
          get: getSessionJson,
          post: postSessionJson,
          authorize: () => {
            const credential = authorizeRequest({
              url: "/api/automation/state",
            }).headers.Authorization;
            if (credential !== originalCredential)
              throw new Error("session_changed");
            return credential;
          },
          makeId: () => crypto.randomUUID(),
          command: "friends.respond",
          args: {
            playerId: player.playerId,
            name: player.nickname || player.username || "Игрок",
            decision,
          },
        });
        submitted++;
        setRequests((current) =>
          current.filter((item) => item.playerId !== player.playerId),
        );
        onAutomation?.(result);
      }
      onNotice?.({
        success: true,
        message: `Обработано заявок: ${submitted}.${players.length > remaining.length ? ` Уже обрабатываются: ${players.length - remaining.length}.` : ""}`,
      });
    } catch {
      onNotice?.({
        success: false,
        message: `Обработано заявок: ${submitted} из ${remaining.length}. Проверьте оставшиеся заявки.`,
      });
    } finally {
      setBusy(null);
      lock.current = false;
    }
  };
  if (loading) return <Skeleton variant="control" />;
  if (!requests.length) return null;
  return (
    <Disclosure
      title="Заявки в друзья"
      separated
      leading={<Icon type="user-plus" size="medium" />}
      status={<CardDescription size="xs">{requests.length}</CardDescription>}
      footer={
        requests.length > 0 && (
          <div className="friends-request-actions">
            <ApprovableButton
              icon="close"
              confirmationKey={JSON.stringify(
                requests
                  .filter((player) => !pendingIds.has(player.playerId))
                  .map((player) => player.playerId)
                  .sort((a, b) => a - b),
              )}
              confirmationLabel="Точно отклонить все?"
              disabled={
                busy !== null ||
                error ||
                requests.every((player) => pendingIds.has(player.playerId))
              }
              onClick={() => void sendMany(requests, "decline")}
            >
              Отклонить все
            </ApprovableButton>
            <Button
              icon="check"
              disabled={
                busy !== null ||
                error ||
                requests.every((player) => pendingIds.has(player.playerId))
              }
              onClick={() => void sendMany(requests, "accept")}
            >
              Принять все
            </Button>
          </div>
        )
      }
    >
      <div className="friends-list">
        {requests.map((player) => {
          const pending = pendingIds.has(player.playerId);
          return (
            <RequestCard
              key={player.playerId}
              player={player}
              pending={pending}
              busy={busy !== null}
              send={send}
            />
          );
        })}
      </div>
    </Disclosure>
  );
}
