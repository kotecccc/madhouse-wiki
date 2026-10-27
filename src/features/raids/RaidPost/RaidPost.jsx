import { RaidEventCard } from "../RaidEventCard/RaidEventCard.jsx";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Pill } from "../../../components/ui/Pill/Pill.jsx";
import { combineRaids, raidFriendKey, raidFriendTarget } from "../raid-list.js";
import "./RaidPost.css";

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
  ) : !archive && authenticated && friendStatus === "friend" ? (
    <Pill variant="unknown" size="xs" dot={false}>
      В друзьях
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
  subscriptionState,
  onSubscribe,
  onUnsubscribe,
  onRequestFriend,
  onInspectFriend,
  onRefreshFriend,
  authenticated = false,
}) {
  const subscription = subscriptionState?.subscription;
  const rows = combineRaids(
    post.raids,
    detectedRaids,
    subscription,
    knowledgeBase.bosses,
  );
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
        {rows.map(({ key, raid, candidate, detected }) => {
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
          const friendAction = RaidFriendAction({
            archive,
            authenticated,
            friendTarget,
            friendStatus,
            pending: subscriptionState?.pending,
            onRequestFriend,
            onInspectFriend,
            onRefreshFriend,
          });
          const action =
            !archive && authenticated ? (
              <Button
                size="sm"
                icon={selected ? "close" : "target"}
                iconOnly
                title={actionLabel}
                aria-label={actionLabel}
                disabled={
                  !subscriptionState?.loaded ||
                  subscriptionState?.pending ||
                  (selected && !subscription?.enabled) ||
                  (!selected &&
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
            <li key={key}>
              <RaidEventCard
                raid={raid}
                bossOverride={boss}
                status={detected && candidate.count ? "active" : undefined}
                floorAvailability={floorAvailability}
                goalAction={
                  action || friendAction ? (
                    <>
                      {action}
                      {friendAction}
                    </>
                  ) : null
                }
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
