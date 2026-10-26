import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { RaidPost } from "../RaidPost/RaidPost.jsx";
import { RaidArchive } from "../RaidArchive/RaidArchive.jsx";
import { useEffect, useSyncExternalStore } from "react";
import { raidSubscriptions } from "../../bosses/BossBattle/boss-battle-session.js";
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
        <div className="raid-feed-state" role="status">
          <p>Расписание временно недоступно.</p>
          <Button variant="secondary" onClick={onRetry}>
            Повторить
          </Button>
        </div>
      )}
      {state.status === "ready" && !displayed && (
        <p className="raid-feed-state" role="status">
          Пока нет сохранённых расписаний. Новые рейды появятся здесь после
          синхронизации канала.
        </p>
      )}
      {subscriptionState.error && <p role="alert">{subscriptionState.error}</p>}
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
            onUnsubscribe={() => void raidSubscriptions.stop()}
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
