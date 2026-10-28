import { RaidEventCard } from "../RaidEventCard/RaidEventCard.jsx";
import { Fragment, useEffect, useRef } from "react";
import { Title } from "../../../components/ui/Title/Title.jsx";
import {
  getBossFloorCode,
  departmentById,
} from "../../../model/knowledge-base.js";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { combineRaids, raidFriendKey, raidFriendTarget } from "../raid-list.js";
import "./RaidPost.css";

const battlePlural = new Intl.PluralRules("ru");
const battleWord = (count) =>
  ({ one: "бой", few: "боя", many: "боёв", other: "боёв" })[
    battlePlural.select(count)
  ];

export function RaidFriendAction({
  archive,
  authenticated,
  friendTarget,
  friendStatus,
  pending,
  onRequestFriend,
  onInspectFriend,
  onRefreshFriend,
}) {
  return !archive &&
    authenticated &&
    friendTarget &&
    friendStatus === "none" ? (
    <Button
      size="sm"
      icon="user-plus"
      iconOnly
      title="Добавить ведущего в друзья"
      aria-label="Добавить ведущего в друзья"
      disabled={pending}
      onClick={() => onRequestFriend?.(friendTarget)}
    />
  ) : !archive &&
    authenticated &&
    friendTarget &&
    friendStatus === "unknown" ? (
    <Button
      size="sm"
      icon="user-plus"
      iconOnly
      title="Проверить ведущего"
      aria-label="Проверить ведущего"
      disabled={pending}
      onClick={() => onInspectFriend?.(friendTarget)}
    />
  ) : !archive && authenticated && friendStatus === "pending" ? (
    <Pill variant="unknown" size="xs" dot={false}>
      Заявка отправлена
    </Pill>
  ) : !archive && authenticated && friendStatus === "incoming" ? (
    <Pill variant="unknown" size="xs" dot={false}>
      Входящая заявка
    </Pill>
  ) : !archive && authenticated && friendStatus === "uncertain" ? (
    <Button
      size="sm"
      icon="refresh"
      iconOnly
      title="Проверить заявку в друзья"
      aria-label="Проверить заявку в друзья"
      disabled={pending}
      onClick={() => onRefreshFriend?.()}
    />
  ) : null;
}

export function RaidPost({
  post,
  archive = false,
  floorAvailability = {},
  detectedRaids = [],
  bossCollections = [],
  invitations = [],
  onAcceptInvitation,
  readOnly = false,
  groupByFloor = false,
  subscriptionState,
  onSubscribe,
  onUnsubscribe,
  onRequestFriend,
  onInspectFriend,
  onRefreshFriend,
  authenticated = false,
  active = false,
  focusTarget = null,
  onQueueFocusHandled,
}) {
  const subscription = subscriptionState?.subscription;
  const rows = combineRaids(
    post.raids,
    detectedRaids,
    subscription,
    knowledgeBase.bosses,
  );
  const floorFor = (row) => {
    const boss = knowledgeBase.bosses.find(
      (item) => Number(item.numericId ?? item.apiId) === row.candidate?.bossId,
    );
    return {
      floor: boss ? getBossFloorCode(boss) : "unknown",
      department: departmentById[boss?.departmentId]?.code ?? "",
    };
  };
  if (groupByFloor)
    rows.sort((a, b) => {
      const left = floorFor(a);
      const right = floorFor(b);
      return (
        (left.floor === right.floor
          ? 0
          : left.floor === "unknown"
            ? 1
            : right.floor === "unknown"
              ? -1
              : right.floor.localeCompare(left.floor, "ru", {
                  numeric: true,
                })) ||
        left.department.localeCompare(right.department, "ru", {
          numeric: true,
        }) ||
        String(a.raid.boss || "").localeCompare(String(b.raid.boss || ""), "ru")
      );
    });
  const focusedRowRef = useRef(null);
  const target = focusTarget?.target ?? focusTarget;
  const matchesFocus = (candidate) =>
    Boolean(
      candidate &&
      (target?.bossId == null || candidate.bossId === target.bossId) &&
      (target?.leaderPlayerId != null
        ? candidate.leaderPlayerId === target.leaderPlayerId
        : target?.leaderUsername &&
          String(candidate.leaderUsername || "")
            .replace(/^@/, "")
            .toLowerCase() ===
            String(target.leaderUsername).replace(/^@/, "").toLowerCase()),
    );
  const focusedRowKey = rows.find((row) => matchesFocus(row.candidate))?.key;
  const focusKey = target
    ? `${target.leaderPlayerId ?? ""}:${target.leaderUsername ?? ""}:${target.bossId ?? ""}`
    : "";
  useEffect(() => {
    if (!active || !focusKey || !focusedRowKey) return;
    focusedRowRef.current?.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    onQueueFocusHandled?.("raid");
  }, [active, focusKey, focusedRowKey, onQueueFocusHandled]);
  return (
    <section
      className="raid-post"
      aria-label={`Рейды на ${post.raidDateLabel}`}
    >
      {archive && (
        <div className="raid-archive-date">
          <time dateTime={post.raidDate}>{post.raidDateLabel}</time>
          {post.timeZone && <span>Время: {post.timeZone}</span>}
        </div>
      )}
      <ol
        className="raid-event-list"
        aria-label={`Рейды на ${post.raidDateLabel}`}
      >
        {rows.map(({ key, raid, candidate, detected }, index) => {
          const floor = groupByFloor ? floorFor(rows[index]).floor : null;
          const showFloor =
            groupByFloor &&
            (index === 0 || floorFor(rows[index - 1]).floor !== floor);
          const queued =
            candidate &&
            subscriptionState?.queuedSubscriptions?.find(
              (job) =>
                job.args.bossId === candidate.bossId &&
                (candidate.leaderPlayerId != null
                  ? job.args.leaderPlayerId === candidate.leaderPlayerId
                  : !job.args.leaderPlayerId &&
                    String(job.args.leaderUsername || "")
                      .replace(/^@/, "")
                      .toLowerCase() ===
                      String(candidate.leaderUsername || "")
                        .replace(/^@/, "")
                        .toLowerCase()),
            );
          const selected =
            candidate &&
            subscription?.leaderPlayerId === candidate.leaderPlayerId &&
            (candidate.leaderPlayerId != null ||
              String(subscription?.leaderUsername || "")
                .replace(/^@/, "")
                .toLowerCase() ===
                String(candidate.leaderUsername || "")
                  .replace(/^@/, "")
                  .toLowerCase()) &&
            subscription?.bossId === candidate.bossId &&
            (subscription?.enabled || subscription?.hasSuspendedGoal);
          const boss = detected
            ? (knowledgeBase.bosses.find(
                (item) =>
                  Number(item.numericId ?? item.apiId) === candidate.bossId,
              ) ?? {
                id: `raid-${candidate.bossId}`,
                numericId: candidate.bossId,
                name: candidate.bossName || "Босс",
                possibleDrops: [],
                dropItems: [],
              })
            : undefined;
          const ownedDrops = bossCollections?.find(
            (item) =>
              Number(item.numericId ?? item.apiId) === candidate?.bossId,
          )?.ownedDrops;
          const menuDropCount =
            ownedDrops?.total > 0
              ? `${ownedDrops.known === ownedDrops.total ? ownedDrops.owned : "?"}/${ownedDrops.total}`
              : undefined;
          const actionLabel = selected
            ? subscription?.enabled
              ? "Отписаться"
              : "Завершаем рейд"
            : candidate
              ? "Подписаться"
              : "Ведущий не подтверждён";
          const friendTarget = raidFriendTarget(raid, candidate);
          const friendStatus =
            subscriptionState?.friend?.statuses?.[raidFriendKey(friendTarget)];
          const announcementNotFriend =
            readOnly &&
            !archive &&
            authenticated &&
            friendTarget &&
            friendStatus === "none";
          const friendAction = readOnly ? (
            announcementNotFriend ? (
              <Button
                icon="user-plus"
                disabled={subscriptionState?.pending}
                onClick={() => onRequestFriend?.(friendTarget)}
              >
                Добавить в друзья
              </Button>
            ) : null
          ) : (
            RaidFriendAction({
              archive,
              authenticated,
              friendTarget,
              friendStatus,
              pending: subscriptionState?.pending,
              onRequestFriend,
              onInspectFriend,
              onRefreshFriend,
            })
          );
          const invitation =
            detected &&
            invitations.find(
              (item) =>
                item.available &&
                item.bossId === candidate.bossId &&
                item.leaderPlayerId === candidate.leaderPlayerId,
            );
          const joinAction = invitation && (
            <Button
              icon="combat"
              disabled={
                subscriptionState?.pending ||
                subscriptionState?.queuedInvitationIds?.includes(
                  invitation.invitationId,
                )
              }
              onClick={() => onAcceptInvitation?.(invitation.invitationId)}
            >
              Вступить в бой
            </Button>
          );
          const untilDropAction =
            detected && candidate && !readOnly && authenticated && !selected ? (
              <Button
                icon="combat"
                disabled={
                  !subscriptionState?.loaded ||
                  subscriptionState?.pending ||
                  Boolean(queued) ||
                  subscription?.enabled ||
                  subscription?.hasSuspendedGoal
                }
                onClick={() =>
                  onSubscribe?.(
                    candidate.leaderPlayerId,
                    candidate.bossId,
                    candidate.leaderUsername,
                    true,
                  )
                }
              >
                Нападать до дропа
              </Button>
            ) : null;
          const action =
            !archive && authenticated && !readOnly ? (
              <Button
                size="sm"
                icon={selected ? "close" : "target"}
                iconOnly
                title={actionLabel}
                aria-label={actionLabel}
                disabled={
                  !subscriptionState?.loaded ||
                  subscriptionState?.pending ||
                  Boolean(queued) ||
                  (selected && !subscription?.enabled) ||
                  (!selected &&
                    !queued &&
                    (!candidate ||
                      subscription?.enabled ||
                      subscription?.hasSuspendedGoal))
                }
                onClick={() =>
                  selected
                    ? onUnsubscribe?.()
                    : onSubscribe?.(
                        candidate.leaderPlayerId,
                        candidate.bossId,
                        candidate.leaderUsername,
                      )
                }
              />
            ) : null;
          return (
            <Fragment key={key}>
              {showFloor && (
                <li className={index > 0 ? "raid-floor-heading" : undefined}>
                  <Title as="h3" level="h5">
                    {floor === "unknown" ? "Этаж не указан" : `Этаж ${floor}`}
                  </Title>
                </li>
              )}
              <li ref={matchesFocus(candidate) ? focusedRowRef : null}>
                <RaidEventCard
                  raid={raid}
                  bossOverride={boss}
                  menuDropCount={menuDropCount}
                  showStatus={!(detected && candidate.count)}
                  friendIndicator={
                    announcementNotFriend ? (
                      <Pill
                        variant="locked"
                        size="xs"
                        dot={false}
                        aria-label="Ведущий не в друзьях"
                        title="Ведущий не в друзьях"
                      >
                        <Icon type="user-plus" size="small" />
                      </Pill>
                    ) : null
                  }
                  collectionIndicator={
                    detected && candidate.count ? (
                      <Pill
                        variant="active"
                        size="xs"
                        aria-label={`Боёв за последние ${candidate.windowMs / 3600000 || 2} ч: ${candidate.count}`}
                      >
                        {candidate.count} {battleWord(candidate.count)}{" "}
                        <span aria-hidden="true">•</span>{" "}
                        {candidate.windowMs / 3600000 || 2} ч
                      </Pill>
                    ) : null
                  }
                  floorAvailability={floorAvailability}
                  readOnly={readOnly}
                  goalAction={
                    action || friendAction || joinAction || untilDropAction ? (
                      <>
                        {joinAction}
                        {untilDropAction}
                        {action}
                        {friendAction}
                      </>
                    ) : null
                  }
                />
              </li>
            </Fragment>
          );
        })}
      </ol>
    </section>
  );
}
