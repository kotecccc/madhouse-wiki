import { ErrorToast } from "../../../components/ui/ErrorToast/ErrorToast.jsx";
import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { RaidPost } from "../RaidPost/RaidPost.jsx";
import { RaidArchive } from "../RaidArchive/RaidArchive.jsx";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { raidSubscriptions } from "../../bosses/BossBattle/boss-battle-session.js";
import { knowledgeBase } from "virtual:madhouse-catalogue";
import { combineRaids, raidFriendKey, raidFriendTarget } from "../raid-list.js";
import "./RaidScheduleSection.css";

export function RaidScheduleSection({
  availability,
  state,
  onRetry,
  authenticated = false,
  active = false,
}) {
  const latest = state.posts[0];
  const subscriptionState = useSyncExternalStore(
    raidSubscriptions.subscribe,
    raidSubscriptions.getSnapshot,
    raidSubscriptions.getSnapshot,
  );
  const checkedTargets = useRef("");
  const targets = combineRaids(
    latest?.raids ?? [],
    subscriptionState.detectedRaids,
    subscriptionState.subscription,
    knowledgeBase.bosses,
  )
    .map(({ raid, candidate }) => raidFriendTarget(raid, candidate))
    .filter(Boolean);
  const targetKey = JSON.stringify(
    [
      ...new Map(
        targets.map((target) => [raidFriendKey(target), target]),
      ).values(),
    ].slice(0, 100),
  );
  useEffect(() => {
    if (
      !authenticated ||
      !active ||
      !subscriptionState.loaded ||
      subscriptionState.pending ||
      targetKey === "[]" ||
      checkedTargets.current === targetKey
    )
      return;
    checkedTargets.current = targetKey;
    void raidSubscriptions.checkFriends(JSON.parse(targetKey));
  }, [
    authenticated,
    active,
    subscriptionState.loaded,
    subscriptionState.pending,
    targetKey,
  ]);
  useEffect(() => {
    if (!authenticated || !active) checkedTargets.current = "";
  }, [authenticated, active]);
  useEffect(() => {
    raidSubscriptions.watch(authenticated && active);
    return () => raidSubscriptions.watch(false);
  }, [authenticated, active]);
  const personal =
    authenticated &&
    (subscriptionState.detectedRaids.length > 0 ||
      subscriptionState.subscription?.enabled ||
      subscriptionState.subscription?.hasSuspendedGoal);
  const displayed =
    latest ??
    (personal
      ? { raids: [], raidDateLabel: "", sourceMessageId: "personal" }
      : null);
  return (
    <ContentSection
      className="raid-schedule-section"
      id="raids"
      aria-labelledby="raids-title"
    >
      <h2 id="raids-title" className="sr-only">
        Рейды
      </h2>
      {state.status === "error" && (
        <ErrorToast message="Расписание временно недоступно.">
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Повторить
          </Button>
        </ErrorToast>
      )}
      {state.status === "ready" && !displayed && (
        <p className="raid-feed-state" role="status">
          Пока нет сохранённых расписаний. Новые рейды появятся здесь после
          синхронизации канала.
        </p>
      )}
      <ErrorToast message={subscriptionState.error} />
      {subscriptionState.friendError && (
        <ErrorToast message={subscriptionState.friendError}>
          <Button
            size="sm"
            disabled={subscriptionState.pending}
            onClick={() =>
              void raidSubscriptions.checkFriends(JSON.parse(targetKey))
            }
          >
            Проверить друзей
          </Button>
        </ErrorToast>
      )}
      {displayed && (
        <div className="raid-post-list">
          <RaidPost
            post={displayed}
            floorAvailability={availability}
            authenticated={authenticated}
            detectedRaids={subscriptionState.detectedRaids}
            subscriptionState={subscriptionState}
            onSubscribe={(leader, boss, username) =>
              void raidSubscriptions.start(leader, boss, username)
            }
            onUnsubscribe={(queueId) => void raidSubscriptions.stop(queueId)}
            onRequestFriend={(target) =>
              void raidSubscriptions.requestFriend(
                target.playerId ?? null,
                target.username ?? "",
              )
            }
            onInspectFriend={(target) =>
              void raidSubscriptions.inspectFriend(
                target.playerId ?? null,
                target.username ?? "",
              )
            }
            onRefreshFriend={() => void raidSubscriptions.refreshFriend()}
          />
          {state.nextCursor && (
            <RaidArchive
              key={state.nextCursor}
              cursor={state.nextCursor}
              floorAvailability={availability}
            />
          )}
        </div>
      )}
    </ContentSection>
  );
}
