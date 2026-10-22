import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { RaidPost } from "../RaidPost/RaidPost.jsx";
import { RaidArchive } from "../RaidArchive/RaidArchive.jsx";
import "./RaidScheduleSection.css";

export function RaidScheduleSection({ availability, state, onRetry }) {
  const latest = state.posts[0];
  const headingDate = latest?.raidDateLabel?.replace(
    /^(\d{2}\.\d{2}\.)\d{2}(\d{2})$/,
    "$1$2",
  );
  return (
    <ContentSection
      className="raid-schedule-section"
      id="raids"
      aria-labelledby="raids-title"
    >
      <div className="raid-section-heading">
        <div className="raid-section-title">
          <Title as="h2" id="raids-title">
            {headingDate ? `Рейды ${headingDate}` : "Рейды"}
          </Title>
        </div>
        <a
          className="raid-channel-link button button-secondary"
          href="https://t.me/raidsMadness"
          target="_blank"
          rel="noreferrer"
          aria-label="Открыть канал Рейд-центр в Telegram"
          title="Канал Рейд-центр в Telegram"
        >
          <Icon type="external-link" size="small" />
          <span className="raid-channel-label">Источник</span>
        </a>
      </div>
      {state.status === "loading" && (
        <p className="raid-feed-state" role="status">
          Загружаем расписание из Telegram…
        </p>
      )}
      {state.status === "error" && (
        <div className="raid-feed-state" role="status">
          <p>Расписание временно недоступно.</p>
          <Button variant="secondary" onClick={onRetry}>
            Повторить
          </Button>
        </div>
      )}
      {state.status === "ready" && !latest && (
        <p className="raid-feed-state" role="status">
          Пока нет сохранённых расписаний. Новые рейды появятся здесь после
          синхронизации канала.
        </p>
      )}
      {latest && (
        <div className="raid-post-list">
          <RaidPost post={latest} floorAvailability={availability} />
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
