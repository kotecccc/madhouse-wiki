import { RaidEventCard } from "../RaidEventCard/RaidEventCard.jsx";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { combineRaids } from "../raid-list.js";
import "./RaidPost.css";

export function RaidPost({
  post,
  archive = false,
  floorAvailability = {},
  detectedRaids = [],
  subscriptionState,
  onSubscribe,
  onUnsubscribe,
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
          const action =
            !archive && authenticated ? (
              <Button
                size="sm"
                icon={selected ? "close" : "target"}
                iconOnly
                title={actionLabel}
                aria-label={actionLabel}
                disabled={
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
                goalAction={action}
              />
            </li>
          );
        })}
      </ol>
    </section>
  );
}
