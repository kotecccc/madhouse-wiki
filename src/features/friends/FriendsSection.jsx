import { useEffect, useRef, useState } from "react";
import {
  getSessionJson,
  postSessionJson,
} from "../../../shared/session-api.js";
import { BaseCard } from "../../components/ui/BaseCard/BaseCard.jsx";
import { Button } from "../../components/ui/Button/Button.jsx";
import { CardTitle } from "../../components/ui/CardTitle/CardTitle.jsx";
import { CardDescription } from "../../components/ui/CardDescription/CardDescription.jsx";
import { Skeleton } from "../../components/ui/Skeleton/Skeleton.jsx";
import { ErrorToast } from "../../components/ui/ErrorToast/ErrorToast.jsx";
import { NumberField } from "../../components/ui/NumberField/NumberField.jsx";
import { Input } from "../../components/ui/Input/Input.jsx";
import { SelectField } from "../../components/ui/SelectField/SelectField.jsx";
import { SegmentedControl } from "../../components/ui/SegmentedControl/SegmentedControl.jsx";
import { ImageCard } from "../../components/ui/ImageCard/ImageCard.jsx";
import { Icon } from "../../components/ui/Icon/Icon.jsx";
import { readSession } from "../../../shared/auth-session.js";
import { sendFriendCommand } from "./friend-commands.js";
import { loadFriends, selectFriends } from "./friends.js";
import "../../components/ui/StatusList/StatusList.css";
import "./FriendsSection.css";

const PAGE_SIZE = 20;
const options = [
  ["name", "По имени"],
  ["buddy", "По приоритету Buddy"],
  ["lastSeenAt", "По последнему посещению"],
  ["level", "По уровню"],
  ["madness", "По безумию"],
  ["aggression", "По агрессии"],
  ["rage", "По ярости"],
].map(([value, label]) => ({ id: value, value, label }));
const format = (value) =>
  value == null ? "—" : new Intl.NumberFormat("ru-RU").format(value);

const sendCommand = (command, args) =>
  sendFriendCommand({
    get: getSessionJson,
    post: postSessionJson,
    identity: () => {
      const session = readSession();
      return session.status === "ready" ? session.identity : null;
    },
    command,
    args,
  });

export function FriendsSection({
  active,
  refreshGeneration = 0,
  onRefreshState,
}) {
  const [state, setState] = useState({ status: "loading", items: [] });

  const [automation, setAutomation] = useState(null);
  const [action, setAction] = useState(null);
  const [actionError, setActionError] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const touch = useRef(null);
  const actionLock = useRef(false);
  const [reserve, setReserve] = useState("1");
  const [stashReserve, setStashReserve] = useState("1");
  const [settingsError, setSettingsError] = useState("");
  const [resolveConfirm, setResolveConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let retryTimer;
    let attempts = 0;
    onRefreshState?.(true);
    void getSessionJson("/api/automation/state", {
      fresh: true,
    })
      .then((value) => {
        if (!controller.signal.aborted) {
          setAutomation(value);
          setReserve(String(value.buddyHelp?.fullBoosterReserve ?? 1));
          setStashReserve(String(value.buddyHelp?.stashReserve ?? 1));
        }
      })
      .catch(() => {});
    const load = () => {
      attempts++;
      void loadFriends(getSessionJson, controller.signal).then(
        (items) => {
          setState({ status: "ready", items });
          onRefreshState?.(false);
        },
        () => {
          if (!controller.signal.aborted) {
            setState((previous) =>
              previous.status === "ready"
                ? previous
                : { status: "error", items: [] },
            );
            onRefreshState?.(false);
            if (attempts < 3) retryTimer = window.setTimeout(load, 15000);
          }
        },
      );
    };
    load();
    return () => {
      controller.abort();
      window.clearTimeout(retryTimer);
      onRefreshState?.(false);
    };
  }, [active, refreshGeneration, reload, onRefreshState]);
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
  const favorites = automation?.preferences?.favoriteFriendIds ?? [];
  const buddy = automation?.buddy?.mode === "buddy" ? automation.buddy : null;
  const buddyFriends = buddy?.friendIds ?? [];
  async function executeAction(target) {
    if (!target || actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    setAction(target);
    setActionError("");
    try {
      const command =
        target.kind === "remove"
          ? "friends.remove"
          : target.kind === "buddy"
            ? "buddy.set"
            : target.kind === "order"
              ? "buddy.order"
              : "friends.favorite";
      const result = await sendCommand(command, (current) => ({
        ...(target.kind === "order"
          ? { friendIds: target.friendIds }
          : { playerId: target.player.playerId }),
        ...(target.kind === "buddy"
          ? {
              enabled: !(
                current.buddy?.mode === "buddy" &&
                current.buddy.friendIds?.includes(target.player.playerId)
              ),
            }
          : {}),
        ...(target.kind === "favorite"
          ? {
              enabled: !(current.preferences?.favoriteFriendIds ?? []).includes(
                target.player.playerId,
              ),
            }
          : {}),
      }));
      setAutomation(result);
      if (target.kind === "remove" && result.friendRemoval?.pending) {
        setActionError(
          "Результат удаления не подтверждён. Обновите список; повторная отправка заблокирована.",
        );
        return;
      }
      setAction(null);
      if (target.kind === "remove") setReload((value) => value + 1);
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
  async function checkRemoval() {
    if (actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    try {
      const result = await sendCommand("friends.reconcile", {});
      setAutomation(result);
      if (result.friendRemoval?.pending)
        setActionError("Результат удаления пока не подтверждён.");
      else {
        setAction(null);
        setActionError("");
        setReload((value) => value + 1);
      }
    } catch {
      setActionError("Не удалось проверить результат удаления.");
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }
  async function configureBuddy(
    boostersEnabled,
    stashEnabled = Boolean(automation?.buddyHelp?.stashEnabled),
  ) {
    const amount = Number(reserve);
    const stashAmount = Number(stashReserve);
    if (
      !Number.isSafeInteger(amount) ||
      amount < 0 ||
      amount > 10000 ||
      reserve.trim() === "" ||
      !Number.isSafeInteger(stashAmount) ||
      stashAmount < 0 ||
      stashAmount > 10000 ||
      stashReserve.trim() === ""
    ) {
      setSettingsError("Укажите целый резерв от 0 до 10000.");
      return;
    }
    if (actionLock.current) return;
    actionLock.current = true;
    setActionBusy(true);
    setSettingsError("");
    try {
      const result = await sendCommand("buddy.configure", {
        boostersEnabled,
        fullBoosterReserve: amount,
        stashEnabled,
        stashReserve: stashAmount,
      });
      setAutomation(result);
    } catch {
      setSettingsError("Не удалось сохранить настройки Buddy.");
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
    setSettingsError("");
    try {
      const next = await sendCommand("buddy.resolve", { kind });
      setAutomation(next);
      setResolveConfirm(null);
    } catch {
      setSettingsError("Не удалось проверить просьбу. Попробуйте позже.");
    } finally {
      actionLock.current = false;
      setActionBusy(false);
    }
  }
  function startSwipe(event, player) {
    if (
      event.touches.length !== 1 ||
      event.target.closest("button, input, select, a")
    )
      return;
    touch.current = {
      player,
      x: event.touches[0].clientX,
      y: event.touches[0].clientY,
    };
  }
  function endSwipe(event) {
    const start = touch.current;
    touch.current = null;
    if (!start || event.changedTouches.length !== 1) return;
    const dx = event.changedTouches[0].clientX - start.x;
    const dy = event.changedTouches[0].clientY - start.y;
    if (Math.abs(dx) < 80 || Math.abs(dx) <= Math.abs(dy) * 1.3) return;
    setActionError("");
    setAction({ player: start.player, kind: dx > 0 ? "remove" : "favorite" });
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
  const onlineCount = state.items.filter(
    (friend) => friend.isOnline === true,
  ).length;
  const offlineCount = state.items.filter(
    (friend) => friend.isOnline === false,
  ).length;
  return (
    <section className="friends-section" aria-label="Друзья">
      {state.status === "error" && (
        <ErrorToast message="Не удалось загрузить друзей. Проверьте подключение к игре." />
      )}
      {state.status === "loading" && (
        <div className="friends-list" aria-busy="true" role="status">
          <span className="sr-only">Загружаем список друзей</span>
          <Skeleton variant="control" />
          <div className="friends-filters">
            <Skeleton variant="control" />
            <Skeleton variant="control" />
          </div>
          {[0, 1, 2, 3].map((item) => (
            <Skeleton as="article" key={item} />
          ))}
        </div>
      )}
      {state.status === "ready" && (
        <>
          {buddyFriends.length > 0 && (
            <BaseCard>
              <div className="friends-card-content">
                <CardTitle>Buddy · {buddyFriends.length}</CardTitle>
                {buddyFriends.map((playerId, index) => {
                  const player = state.items.find(
                    (item) => item.playerId === playerId,
                  );
                  return (
                    <div className="friends-card-heading" key={playerId}>
                      <CardDescription>
                        {index + 1}.{" "}
                        {player?.nickname ||
                          (player?.username && `@${player.username}`) ||
                          `Игрок №${playerId}`}
                        {buddy?.activeFriendId === playerId &&
                        buddy?.phase === "fighting"
                          ? " · в рейде"
                          : ""}
                      </CardDescription>
                      <div className="friends-identity">
                        {[-1, 1].map((direction) => (
                          <Button
                            key={direction}
                            size="sm"
                            variant="secondary"
                            disabled={
                              actionBusy ||
                              index + direction < 0 ||
                              index + direction >= buddyFriends.length
                            }
                            aria-label={
                              direction < 0
                                ? "Повысить приоритет"
                                : "Понизить приоритет"
                            }
                            onClick={() => {
                              const ids = [...buddyFriends];
                              [ids[index], ids[index + direction]] = [
                                ids[index + direction],
                                ids[index],
                              ];
                              void executeAction({
                                kind: "order",
                                player: { playerId },
                                friendIds: ids,
                              });
                            }}
                          >
                            {direction < 0 ? "↑" : "↓"}
                          </Button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </BaseCard>
          )}
          {automation?.friendRemoval?.pending &&
            !state.items.some(
              (player) =>
                player.playerId === automation.friendRemoval.pending.playerId,
            ) && (
              <div>
                <CardDescription role="alert">
                  Удаление друга не подтверждено.
                </CardDescription>
                <Button
                  size="sm"
                  disabled={actionBusy}
                  onClick={() => void checkRemoval()}
                >
                  Проверить результат
                </Button>
              </div>
            )}
          {(buddyFriends.length > 0 || automation?.buddyHelp?.hasPending) && (
            <BaseCard>
              <div className="friends-card-content">
                <CardTitle>Помощь Buddy</CardTitle>
                <CardDescription>
                  Рейды включены для выбранных друзей. Предметы отправляются
                  только сверх резерва.
                </CardDescription>
                <NumberField
                  id="buddy-booster-reserve"
                  label="Резерв полных препаратов"
                  min="0"
                  max="10000"
                  value={reserve}
                  onChange={(event) => setReserve(event.target.value)}
                  spacing="none"
                />
                <NumberField
                  id="buddy-stash-reserve"
                  label="Резерв каждого ингредиента"
                  min="0"
                  max="10000"
                  value={stashReserve}
                  onChange={(event) => setStashReserve(event.target.value)}
                  spacing="none"
                />
                <div className="friends-actions">
                  <Button
                    size="sm"
                    variant="toggle"
                    aria-pressed={Boolean(
                      automation?.buddyHelp?.boostersEnabled,
                    )}
                    disabled={actionBusy}
                    onClick={() =>
                      void configureBuddy(
                        !automation?.buddyHelp?.boostersEnabled,
                      )
                    }
                  >
                    {automation?.buddyHelp?.boostersEnabled
                      ? "Препараты включены"
                      : "Включить препараты"}
                  </Button>
                  <Button
                    size="sm"
                    variant="toggle"
                    aria-pressed={Boolean(automation?.buddyHelp?.stashEnabled)}
                    disabled={actionBusy}
                    onClick={() =>
                      void configureBuddy(
                        Boolean(automation?.buddyHelp?.boostersEnabled),
                        !automation?.buddyHelp?.stashEnabled,
                      )
                    }
                  >
                    {automation?.buddyHelp?.stashEnabled
                      ? "Заначки включены"
                      : "Включить заначки"}
                  </Button>
                  <Button
                    size="sm"
                    disabled={actionBusy}
                    onClick={() =>
                      void configureBuddy(
                        Boolean(automation?.buddyHelp?.boostersEnabled),
                      )
                    }
                  >
                    Сохранить резерв
                  </Button>
                </div>
                {automation?.buddyHelp?.hasPending && (
                  <>
                    <CardDescription>
                      Результат отправки неизвестен. Проверьте его в игре. После
                      снятия блокировки повтор препарата исключён; такой
                      ингредиент этому другу больше автоматически не отправится.
                    </CardDescription>
                    {automation.buddyHelp.pendingBooster && (
                      <CardDescription>
                        Препарат ·{" "}
                        {state.items.find(
                          (friend) =>
                            friend.playerId ===
                            automation.buddyHelp.pendingBooster.playerId,
                        )?.nickname ||
                          `Игрок №${automation.buddyHelp.pendingBooster.playerId}`}
                      </CardDescription>
                    )}
                    {automation.buddyHelp.pendingStash && (
                      <CardDescription>
                        Заначка ·{" "}
                        {state.items.find(
                          (friend) =>
                            friend.playerId ===
                            automation.buddyHelp.pendingStash.playerId,
                        )?.nickname ||
                          `Игрок №${automation.buddyHelp.pendingStash.playerId}`}{" "}
                        · набор №{automation.buddyHelp.pendingStash.setId},
                        ингредиент №
                        {automation.buddyHelp.pendingStash.ingredientId}
                      </CardDescription>
                    )}
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
                        variant={
                          resolveConfirm === "stash" ? "warning" : "secondary"
                        }
                        disabled={actionBusy}
                        onClick={() => void resolveBuddy("stash")}
                      >
                        {resolveConfirm === "stash"
                          ? "Подтвердить проверку заначки"
                          : "Я проверил заначку"}
                      </Button>
                    )}
                  </>
                )}
                {automation?.buddyHelp?.notice && (
                  <CardDescription role="status">
                    {automation.buddyHelp.notice}
                  </CardDescription>
                )}
                {settingsError && (
                  <CardDescription role="alert">
                    {settingsError}
                  </CardDescription>
                )}
                {(buddy?.log?.length > 0 ||
                  automation?.buddyHelp?.log?.length > 0) && (
                  <>
                    <CardTitle size="sm">Последние действия</CardTitle>
                    {[
                      ...(buddy?.log ?? []),
                      ...(automation?.buddyHelp?.log ?? []),
                    ]
                      .sort((a, b) => b.at - a.at)
                      .slice(0, 8)
                      .map((item, index) => {
                        const friend = state.items.find(
                          (player) => player.playerId === item.playerId,
                        );
                        const name =
                          friend?.nickname || friend?.username || "Друг";
                        const type =
                          item.type === "raid"
                            ? "Рейд"
                            : item.type === "stash"
                              ? "Заначка"
                              : "Препарат";
                        const result =
                          {
                            joined: "вступили",
                            finished: "бой завершён",
                            uncertain: "нужна проверка",
                            confirmed: "отправлено",
                            resolved: "статус изменился",
                            acknowledged:
                              "результат неизвестен; проверено вручную",
                          }[item.result] || "статус неизвестен";
                        return (
                          <CardDescription
                            key={`${item.type}-${item.at}-${index}`}
                          >
                            {name} · {type} · {result}
                          </CardDescription>
                        );
                      })}
                  </>
                )}
              </div>
            </BaseCard>
          )}
          <div className="friends-filter-scroll">
            <SegmentedControl
              label="Статус друзей"
              value={filter}
              onChange={(value) => {
                setFilter(value);
                setPage(0);
              }}
              options={[
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
              aria-label="Найти друга"
              placeholder="Ник или @username"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(0);
              }}
            />
            <SelectField
              id="friends-sort"
              icon="sort"
              aria-label="Сортировка"
              spacing="none"
              options={options}
              value={sort}
              onChange={(event) => {
                setSort(event.target.value);
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
                onTouchStart={(event) => startSwipe(event, player)}
                onTouchEnd={endSwipe}
                onTouchCancel={() => {
                  touch.current = null;
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
                        <CardTitle>
                          {player.nickname || player.username || "Игрок"}
                        </CardTitle>
                        {(player.username || player.level != null) && (
                          <CardDescription>
                            {[
                              player.username && `@${player.username}`,
                              player.level != null &&
                                `Ур. ${format(player.level)}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </CardDescription>
                        )}
                      </div>
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
                  {buddyFriends.includes(player.playerId) && (
                    <CardDescription>
                      Buddy · приоритет{" "}
                      {buddyFriends.indexOf(player.playerId) + 1}
                      {buddy?.activeFriendId === player.playerId &&
                      buddy?.phase === "fighting"
                        ? " · в рейде"
                        : buddy?.activeFriendId === player.playerId &&
                            buddy?.phase === "confirming"
                          ? " · нужна проверка"
                          : buddy?.activeFriendId === player.playerId &&
                              buddy?.phase === "joining"
                            ? " · вступает в рейд"
                            : " · ожидает"}
                    </CardDescription>
                  )}
                  <div className="friends-actions">
                    <Button
                      size="sm"
                      icon="group"
                      disabled={actionBusy || !automation}
                      aria-pressed={buddyFriends.includes(player.playerId)}
                      onClick={() =>
                        void executeAction({ player, kind: "buddy" })
                      }
                    >
                      {buddyFriends.includes(player.playerId)
                        ? "Buddy включён"
                        : "Включить Buddy"}
                    </Button>
                    <Button
                      size="sm"
                      icon="star"
                      disabled={actionBusy || !automation}
                      aria-pressed={favorites.includes(player.playerId)}
                      onClick={() =>
                        void executeAction({ player, kind: "favorite" })
                      }
                    >
                      {favorites.includes(player.playerId)
                        ? "В избранном"
                        : "В избранное"}
                    </Button>
                    <Button
                      size="sm"
                      icon="close"
                      variant={
                        action?.kind === "remove" &&
                        action.player.playerId === player.playerId
                          ? "warning"
                          : "secondary"
                      }
                      disabled={
                        actionBusy ||
                        !automation ||
                        Boolean(automation?.friendRemoval?.pending)
                      }
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
                        ? "Подтвердить"
                        : "Удалить"}
                    </Button>
                  </div>
                  {buddyFriends.includes(player.playerId) &&
                    buddyFriends.length > 1 && (
                      <div className="friends-actions">
                        <Button
                          size="sm"
                          icon="arrow-up"
                          disabled={
                            actionBusy ||
                            buddyFriends.indexOf(player.playerId) === 0
                          }
                          onClick={() => {
                            const ids = [...buddyFriends];
                            const index = ids.indexOf(player.playerId);
                            [ids[index - 1], ids[index]] = [
                              ids[index],
                              ids[index - 1],
                            ];
                            void executeAction({
                              player,
                              kind: "order",
                              friendIds: ids,
                            });
                          }}
                        >
                          Выше
                        </Button>
                        <Button
                          size="sm"
                          icon="arrow-down"
                          disabled={
                            actionBusy ||
                            buddyFriends.indexOf(player.playerId) ===
                              buddyFriends.length - 1
                          }
                          onClick={() => {
                            const ids = [...buddyFriends];
                            const index = ids.indexOf(player.playerId);
                            [ids[index + 1], ids[index]] = [
                              ids[index],
                              ids[index + 1],
                            ];
                            void executeAction({
                              player,
                              kind: "order",
                              friendIds: ids,
                            });
                          }}
                        >
                          Ниже
                        </Button>
                      </div>
                    )}
                  {action?.player.playerId === player.playerId &&
                    actionError && (
                      <CardDescription role="alert">
                        {actionError}
                      </CardDescription>
                    )}
                  {automation?.friendRemoval?.pending?.playerId ===
                    player.playerId && (
                    <>
                      <CardDescription role="alert">
                        Удаление не подтверждено. Повторная отправка
                        заблокирована.
                      </CardDescription>
                      <Button
                        size="sm"
                        disabled={actionBusy}
                        onClick={() => void checkRemoval()}
                      >
                        Проверить результат
                      </Button>
                    </>
                  )}
                </div>
              </BaseCard>
            ))}
          </div>
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
