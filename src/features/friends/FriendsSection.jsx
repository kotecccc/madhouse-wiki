import { useEffect, useRef, useState } from "react";
import {
  getSessionJson,
  postSessionJson,
} from "../../../shared/session-api.js";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { CardActionMenu } from "../../components/ui/CardActionMenu/CardActionMenu.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { Divider } from "../../components/ui/Divider/Divider.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { Skeleton } from "../../components/ui/Skeleton/Skeleton.jsx";
import { ErrorToast } from "../../components/ui/ErrorToast/ErrorToast.jsx";
import { Input } from "../../components/ui/Input/Input.jsx";
import { MenuSelect } from "../../components/ui/MenuSelect/MenuSelect.jsx";
import { SegmentedControl } from "../../components/ui/SegmentedControl/SegmentedControl.jsx";
import { ImageCard } from "../../components/ui/ImageCard/ImageCard.jsx";
import { Icon } from "../../components/ui/Icon/Icon.jsx";
import { Pill } from "../../components/ui/Pill/Pill.jsx";
import { authorizeRequest } from "../../../shared/auth-session.js";
import { sendFriendCommand } from "./friend-commands.js";
import { loadFriendPage, selectFriends } from "./friends.js";
import { FriendsRequests } from "./FriendsRequests.jsx";
import "../../components/ui/StatusList/StatusList.css";
import "./FriendsSection.css";

const PAGE_SIZE = 20;
const options = [
  { value: "name", label: "По имени", icon: "character" },
  { value: "priority", label: "По приоритету", icon: "sort" },
  { value: "online", label: "По онлайну", icon: "timer" },
  { value: "level", label: "По уровню", icon: "sparkles-2" },
  { value: "madness", label: "По безумию", icon: "madness" },
  { value: "aggression", label: "По агрессии", icon: "aggression" },
  { value: "rage", label: "По ярости", icon: "rage" },
];
function buddyStatus(buddy, playerId) {
  if (buddy?.activeFriendId !== playerId) return "Ждёт";
  return (
    { fighting: "Идёт бой", joining: "Вступает", confirming: "Проверка" }[
      buddy.phase
    ] ?? "Ждёт"
  );
}

const format = (value) =>
  value == null ? "—" : new Intl.NumberFormat("ru-RU").format(value);

const sendCommand = (command, args) =>
  sendFriendCommand({
    get: getSessionJson,
    post: postSessionJson,
    authorize: () =>
      authorizeRequest({ url: "/api/automation/state" }).headers.Authorization,
    makeId: () => crypto.randomUUID(),
    command,
    args,
  });

export function FriendsSection({
  active,
  refreshGeneration = 0,
  onRefreshState,
  onNotice,
  queueFocus = null,
  onQueueFocusHandled,
}) {
  const [state, setState] = useState({ status: "loading", items: [] });

  const [automation, setAutomation] = useState(null);
  const [action, setAction] = useState(null);
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const [menu, setMenu] = useState(null);
  const [menuClosing, setMenuClosing] = useState(false);
  const actionLock = useRef(false);
  const friendFocusRef = useRef(null);
  const friendFocusPending = useRef(null);
  const defaultBuddyTab = useRef(false);
  const [resolveConfirm, setResolveConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(0);
  const pageRequest = useRef(null);
  const seenCursors = useRef(new Set());
  const moreInFlight = useRef(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState(false);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    pageRequest.current = controller;
    seenCursors.current = new Set();
    moreInFlight.current = false;
    setPage(0);
    setPageError(false);
    setLoadingMore(false);
    setState({ status: "loading", items: [], nextCursor: null });
    onRefreshState?.(true);
    void getSessionJson("/api/automation/state", { fresh: true })
      .then((value) => {
        if (!controller.signal.aborted) setAutomation(value);
      })
      .catch(() => {});
    void loadFriendPage(getSessionJson, null, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted)
          setState({ status: "ready", ...result });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setState({ status: "error", items: [], nextCursor: null });
      })
      .finally(() => {
        if (!controller.signal.aborted) onRefreshState?.(false);
      });
    return () => {
      controller.abort();
      onRefreshState?.(false);
    };
  }, [active, refreshGeneration, reload, onRefreshState]);
  async function loadMore() {
    const cursor = state.nextCursor;
    const controller = pageRequest.current;
    if (
      !cursor ||
      !controller ||
      controller.signal.aborted ||
      moreInFlight.current
    )
      return;
    moreInFlight.current = true;
    setLoadingMore(true);
    setPageError(false);
    try {
      const result = await loadFriendPage(
        getSessionJson,
        cursor,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      if (
        seenCursors.current.has(cursor) ||
        (result.nextCursor && seenCursors.current.has(result.nextCursor))
      )
        throw new Error("Повторный курсор списка друзей.");
      seenCursors.current.add(cursor);
      setState((previous) => {
        const items = new Map(
          previous.items.map((item) => [item.playerId, item]),
        );
        for (const item of result.items) items.set(item.playerId, item);
        return {
          ...previous,
          items: [...items.values()],
          nextCursor: result.nextCursor,
        };
      });
    } catch {
      if (!controller.signal.aborted) setPageError(true);
    } finally {
      if (!controller.signal.aborted) {
        moreInFlight.current = false;
        setLoadingMore(false);
      }
    }
  }
  useEffect(() => {
    if (
      !action ||
      actionBusy ||
      actionError ||
      automation?.friendRemoval?.pending
    )
      return;
    const timer = window.setTimeout(() => setAction(null), 10000);
    return () => window.clearTimeout(timer);
  }, [action, actionBusy, actionError, automation?.friendRemoval?.pending]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void getSessionJson("/api/automation/state", {
        fresh: true,
        revalidate: false,
      })
        .then((next) => {
          if (!cancelled)
            setAutomation((previous) =>
              !previous || next.version >= previous.version ? next : previous,
            );
        })
        .catch(() => {});
    }, 10000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [active]);
  const previousRemoval = useRef(null);
  useEffect(() => {
    const current = automation?.friendRemoval?.pending?.playerId ?? null;
    if (previousRemoval.current != null && current == null)
      setReload((value) => value + 1);
    previousRemoval.current = current;
  }, [automation?.friendRemoval?.pending?.playerId]);
  const buddy = automation?.buddy?.mode === "buddy" ? automation.buddy : null;
  const buddyFriends = buddy?.friendIds ?? [];
  const hasBuddy = Boolean(buddy?.enabled && buddyFriends.length);
  useEffect(() => {
    if (!active) {
      defaultBuddyTab.current = false;
      return;
    }
    if (!automation) return;
    if (!defaultBuddyTab.current) {
      defaultBuddyTab.current = true;
      setFilter(hasBuddy ? "buddy" : "all");
      setSort(hasBuddy ? "priority" : "name");
      setPage(0);
    } else if (!hasBuddy && filter === "buddy") {
      setFilter("all");
      setSort((current) => (current === "priority" ? "name" : current));
      setPage(0);
    }
  }, [active, automation, hasBuddy, filter]);
  async function executeAction(target) {
    if (!target || actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    setAction(target);
    setActionError("");
    try {
      const command =
        target.kind === "remove"
          ? "queue.enqueue"
          : target.kind === "buddy"
            ? "buddy.set"
            : "buddy.order";
      const result = await sendCommand(command, (current) =>
        target.kind === "remove"
          ? {
              type: "friend.remove",
              action: {
                playerId: target.player.playerId,
                name:
                  target.player.nickname || target.player.username || "Игрок",
              },
            }
          : target.kind === "order"
            ? { friendIds: target.friendIds }
            : {
                playerId: target.player.playerId,
                enabled: !(
                  current.buddy?.mode === "buddy" &&
                  current.buddy.friendIds?.includes(target.player.playerId)
                ),
              },
      );
      setAutomation(result);
      setAction(null);
      setMenu(null);
      setMenuClosing(false);
      if (target.kind === "remove")
        onNotice?.({ success: true, message: "Действие добавлено в очередь." });
    } catch {
      try {
        const latest = await getSessionJson("/api/automation/state", {
          fresh: true,
          revalidate: false,
        });
        setAutomation(latest);
      } catch {
        /* Keep the last confirmed state. */
      }
      setActionError(
        "Не удалось подтвердить действие. Проверьте состояние друга.",
      );
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }
  async function resolveBuddy(kind) {
    if (resolveConfirm !== kind) {
      setResolveConfirm(kind);
      return;
    }
    if (actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    setActionError("");
    try {
      const next = await sendCommand("buddy.resolve", { kind });
      setAutomation(next);
      setResolveConfirm(null);
    } catch {
      setActionError("Не удалось проверить просьбу. Попробуйте позже.");
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }
  function closeMenu() {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setMenu(null);
      setMenuClosing(false);
    } else setMenuClosing(true);
    setAction(null);
    setActionError("");
  }
  function openMenu(event, player) {
    if (event.target.closest("button, input, select, a, [role=dialog]")) return;
    if (menu?.playerId === player.playerId) {
      closeMenu();
      return;
    }
    setAction(null);
    setActionError("");
    setMenuClosing(false);
    setMenu({ playerId: player.playerId, anchor: event.currentTarget });
  }
  const items = selectFriends(state.items, {
    search,
    filter,
    sort,
    buddyFriends,
  });
  const pageCount = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const shown = items.slice(
    currentPage * PAGE_SIZE,
    (currentPage + 1) * PAGE_SIZE,
  );
  useEffect(() => {
    if (!active || state.status !== "ready" || !queueFocus) return;
    if (queueFocus.kind === "friend" && queueFocus.playerId != null) {
      const player = state.items.find(
        (item) => item.playerId === queueFocus.playerId,
      );
      if (player) {
        setSearch(
          player.nickname || player.username || String(player.playerId),
        );
        setFilter("all");
        setPage(0);
        friendFocusPending.current = player.playerId;
      } else {
        onQueueFocusHandled?.("friend");
      }
    } else if (queueFocus.kind === "buddy") {
      setFilter(hasBuddy ? "buddy" : "all");
      setSort(hasBuddy ? "priority" : "name");
      setPage(0);
      onQueueFocusHandled?.("buddy");
    }
  }, [
    active,
    state.status,
    state.items,
    queueFocus,
    onQueueFocusHandled,
    hasBuddy,
  ]);
  useEffect(() => {
    const playerId = friendFocusPending.current;
    if (
      !active ||
      state.status !== "ready" ||
      playerId == null ||
      !shown.some((item) => item.playerId === playerId)
    )
      return;
    friendFocusRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    friendFocusPending.current = null;
    onQueueFocusHandled?.("friend");
  }, [active, state.status, shown, onQueueFocusHandled]);
  const onlineCount = state.items.filter(
    (friend) => friend.isOnline === true,
  ).length;
  const offlineCount = state.items.filter(
    (friend) => friend.isOnline === false,
  ).length;
  return (
    <section className="friends-section" aria-label="Друзья">
      {state.status === "error" && (
        <>
          <ErrorToast message="Не удалось загрузить друзей. Проверьте подключение к игре." />
          <Button onClick={() => setReload((value) => value + 1)}>
            Повторить
          </Button>
        </>
      )}
      {(state.status === "loading" || state.status === "waiting") && (
        <div className="friends-list" aria-busy="true" role="status">
          <span className="sr-only">Ждём список друзей</span>
          <Skeleton variant="control" />
          <Skeleton variant="control" />
          <div className="friends-filters">
            <Skeleton variant="control" />
            <Skeleton variant="control" />
          </div>
          {[0, 1, 2, 3, 4, 5, 6, 7].map((item) => (
            <Skeleton as="article" key={item} />
          ))}
        </div>
      )}
      {state.status === "ready" && (
        <>
          {state.nextCursor && (
            <CardDescription>
              Поиск, фильтры и сортировка применяются к загруженным друзьям.
            </CardDescription>
          )}
          {automation?.friendRemoval?.pending &&
            !state.items.some(
              (player) =>
                player.playerId === automation.friendRemoval.pending.playerId,
            ) && (
              <CardDescription role="status">
                Проверяем удаление друга.
              </CardDescription>
            )}
          {automation?.buddyHelp?.hasPending && (
            <BaseCard>
              <CardDescription role="status">
                Результат прежней отправки предмета не подтверждён. Проверьте
                его в игре.
              </CardDescription>
              {automation.buddyHelp.pendingBooster && (
                <Button
                  size="sm"
                  variant={
                    resolveConfirm === "booster" ? "warning" : "secondary"
                  }
                  disabled={actionBusy}
                  onClick={() => void resolveBuddy("booster")}
                >
                  {resolveConfirm === "booster"
                    ? "Подтвердить проверку препарата"
                    : "Я проверил препарат"}
                </Button>
              )}
              {automation.buddyHelp.pendingStash && (
                <Button
                  size="sm"
                  variant={resolveConfirm === "stash" ? "warning" : "secondary"}
                  disabled={actionBusy}
                  onClick={() => void resolveBuddy("stash")}
                >
                  {resolveConfirm === "stash"
                    ? "Подтвердить проверку заначки"
                    : "Я проверил заначку"}
                </Button>
              )}
              {actionError && (
                <CardDescription role="alert">{actionError}</CardDescription>
              )}
            </BaseCard>
          )}
          <FriendsRequests
            active={active}
            refreshGeneration={refreshGeneration}
            automation={automation}
            onAutomation={setAutomation}
            onNotice={onNotice}
          />
          <div className="friends-filter-scroll">
            <SegmentedControl
              label="Статус друзей"
              value={filter}
              onChange={(value) => {
                setFilter(value);
                if (value === "buddy" && filter !== "buddy")
                  setSort("priority");
                else if (value !== "buddy" && sort === "priority")
                  setSort("name");
                setPage(0);
              }}
              options={[
                ...(hasBuddy
                  ? [
                      {
                        value: "buddy",
                        label: `Buddy · ${buddyFriends.length}`,
                      },
                    ]
                  : []),
                { value: "all", label: `Все · ${state.items.length}` },
                { value: "online", label: `В сети · ${onlineCount}` },
                { value: "offline", label: `Не в сети · ${offlineCount}` },
              ]}
            />
          </div>
          <div className="friends-filters">
            <Input
              type="search"
              icon="search"
              surface="card"
              aria-label="Найти друга"
              placeholder="Ник или @username"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
            <MenuSelect
              label="Сортировка"
              options={options}
              value={sort}
              onChange={(value) => {
                setSort(value);
                setPage(0);
              }}
            />
          </div>
          {items.length === 0 && (
            <CardDescription>
              {state.items.length
                ? "По выбранным условиям друзья не найдены."
                : "Друзей пока нет."}
            </CardDescription>
          )}
          <div className="friends-list">
            {shown.map((player) => (
              <BaseCard
                as="article"
                padding="12"
                key={player.playerId}
                state={
                  menu?.playerId === player.playerId ? "menu-active" : undefined
                }
                role="button"
                tabIndex={0}
                aria-haspopup="dialog"
                aria-expanded={menu?.playerId === player.playerId}
                aria-label={`Действия: ${player.nickname || player.username || "Игрок"}`}
                onClick={(event) => openMenu(event, player)}
                onKeyDown={(event) => {
                  if (
                    event.target !== event.currentTarget ||
                    !["Enter", " "].includes(event.key)
                  )
                    return;
                  event.preventDefault();
                  openMenu(event, player);
                }}
              >
                <div
                  className="friends-card-content"
                  ref={
                    player.playerId === queueFocus?.playerId
                      ? friendFocusRef
                      : null
                  }
                >
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
                        <CardTitle>
                          {player.nickname || player.username || "Игрок"}
                        </CardTitle>
                        {player.username && (
                          <CardDescription>@{player.username}</CardDescription>
                        )}
                      </div>
                    </div>
                    <div className="friends-statuses">
                      {buddyFriends.includes(player.playerId) && (
                        <Pill
                          variant={
                            buddy?.activeFriendId === player.playerId &&
                            buddy?.phase === "fighting"
                              ? "active"
                              : "scheduled"
                          }
                          size="xs"
                          dot={false}
                        >
                          <Icon
                            type="heart-handshake"
                            size="small"
                            motion={
                              buddy?.activeFriendId === player.playerId &&
                              buddy?.phase === "fighting"
                                ? "pulse"
                                : undefined
                            }
                          />
                          <span>
                            Приоритет{" "}
                            {buddyFriends.indexOf(player.playerId) + 1} ·{" "}
                            {buddyStatus(buddy, player.playerId)}
                          </span>
                        </Pill>
                      )}
                      {player.level != null && (
                        <Pill size="xs" dot={false}>
                          {format(player.level)} ур.
                        </Pill>
                      )}
                    </div>
                  </div>
                  <div className="friends-stats">
                    {[
                      ["madness", "Безумие"],
                      ["aggression", "Агрессия"],
                      ["rage", "Ярость"],
                    ].map(([key, label]) => (
                      <CardDescription
                        className="friends-stat"
                        key={key}
                        aria-label={`${label}: ${format(player[key])}`}
                      >
                        <Icon type={key} size="text" />{" "}
                        <span>{format(player[key])}</span>
                      </CardDescription>
                    ))}
                  </div>
                  {action?.player.playerId === player.playerId &&
                    actionError && (
                      <CardDescription role="alert">
                        {actionError}
                      </CardDescription>
                    )}
                  {automation?.friendRemoval?.pending?.playerId ===
                    player.playerId && (
                    <CardDescription role="status">
                      Проверяем удаление.
                    </CardDescription>
                  )}
                </div>
                {menu?.playerId === player.playerId && (
                  <CardActionMenu
                    anchor={menu.anchor}
                    preferFit
                    label={`Действия: ${player.nickname || player.username || "Игрок"}`}
                    onClose={closeMenu}
                    closing={menuClosing}
                    onClosed={() => {
                      setMenu(null);
                      setMenuClosing(false);
                    }}
                  >
                    <Button
                      variant="menu-item"
                      icon="heart-handshake"
                      menuValue={
                        buddyFriends.includes(player.playerId)
                          ? buddyStatus(buddy, player.playerId)
                          : "Выключен"
                      }
                      disabled={actionBusy || !automation}
                      onClick={() =>
                        void executeAction({ player, kind: "buddy" })
                      }
                    >
                      {buddyFriends.includes(player.playerId)
                        ? "Выключить Buddy"
                        : "Включить Buddy"}
                    </Button>
                    {buddyFriends.includes(player.playerId) &&
                      buddyFriends.length > 1 &&
                      [
                        ["arrow-up", "Повысить приоритет", -1],
                        ["arrow-down", "Понизить приоритет", 1],
                      ].map(([icon, label, direction]) => (
                        <Button
                          key={icon}
                          variant="menu-item"
                          icon={icon}
                          disabled={
                            actionBusy ||
                            buddyFriends.indexOf(player.playerId) + direction <
                              0 ||
                            buddyFriends.indexOf(player.playerId) + direction >=
                              buddyFriends.length
                          }
                          onClick={() => {
                            const ids = [...buddyFriends];
                            const index = ids.indexOf(player.playerId);
                            [ids[index], ids[index + direction]] = [
                              ids[index + direction],
                              ids[index],
                            ];
                            void executeAction({
                              player,
                              kind: "order",
                              friendIds: ids,
                            });
                          }}
                        >
                          {label}
                        </Button>
                      ))}
                    <Divider menu />
                    <Button
                      variant="menu-item"
                      tone={
                        action?.kind === "remove" &&
                        action.player.playerId === player.playerId
                          ? "warning"
                          : undefined
                      }
                      icon="close"
                      disabled={actionBusy || !automation}
                      onClick={() => {
                        if (
                          action?.kind === "remove" &&
                          action.player.playerId === player.playerId
                        )
                          void executeAction({ player, kind: "remove" });
                        else {
                          setActionError("");
                          setAction({ player, kind: "remove" });
                        }
                      }}
                    >
                      {action?.kind === "remove" &&
                      action.player.playerId === player.playerId
                        ? "Подтвердить удаление"
                        : "Удалить из друзей"}
                    </Button>
                  </CardActionMenu>
                )}
              </BaseCard>
            ))}
          </div>
          {pageError && (
            <CardDescription role="alert">
              Не удалось загрузить следующую порцию друзей.
            </CardDescription>
          )}
          {state.nextCursor && (
            <Button disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? "Загружаем…" : "Загрузить ещё"}
            </Button>
          )}
          {pageCount > 1 && (
            <div className="friends-pagination">
              <Button
                disabled={currentPage === 0}
                onClick={() => setPage(currentPage - 1)}
              >
                Назад
              </Button>
              <CardDescription>
                Страница {currentPage + 1} из {pageCount}
              </CardDescription>
              <Button
                disabled={currentPage + 1 >= pageCount}
                onClick={() => setPage(currentPage + 1)}
              >
                Вперёд
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
