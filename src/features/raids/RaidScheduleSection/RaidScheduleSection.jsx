import { useCallback, useEffect, useMemo, useState } from "react";
import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { RaidEventCard } from "../RaidEventCard/RaidEventCard.jsx";
import "./RaidScheduleSection.css";

const REFRESH_INTERVAL = 5 * 60 * 1000;

export function RaidScheduleSection() {
  const [state, setState] = useState({ status: "loading", posts: [] });
  const [reload, setReload] = useState(0);

  const loadSchedule = useCallback(async (signal) => {
    try {
      const response = await fetch("/api/raids", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("schedule-unavailable");
      const result = await response.json();
      setState({
        status: "ready",
        posts: Array.isArray(result.posts) ? result.posts : [],
      });
    } catch (error) {
      if (error?.name !== "AbortError")
        setState((current) =>
          current.status === "ready" ? current : { status: "error", posts: [] },
        );
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadSchedule(controller.signal);
    const timer = window.setInterval(
      () => loadSchedule(controller.signal),
      REFRESH_INTERVAL,
    );
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [loadSchedule, reload]);

  const posts = useMemo(
    () =>
      [...state.posts].sort((left, right) =>
        String(right.raidDate).localeCompare(String(left.raidDate)),
      ),
    [state.posts],
  );

  return (
    <ContentSection
      className="raid-schedule-section"
      id="raids"
      aria-labelledby="raids-title"
    >
      <div className="raid-section-heading">
        <div>
          <div className="raid-eyebrow">
            <span className="raid-eyebrow-line" />
            <span>{posts[0]?.raidDateLabel || "РАСПИСАНИЕ"}</span>
          </div>
          <Title as="h2" id="raids-title">
            Расписание рейдов
          </Title>
        </div>
        <a
          className="raid-channel-link button button-secondary"
          href={posts[0]?.sourceUrl || "https://t.me/raidsMadness"}
          target="_blank"
          rel="noreferrer"
          aria-label="Открыть источник расписания в Telegram"
          title="Источник в Telegram"
        >
          <Icon type="external-link" />
          <span>Источник</span>
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
          <Button
            type="button"
            variant="secondary"
            onClick={() => setReload((value) => value + 1)}
          >
            Повторить
          </Button>
        </div>
      )}
      {state.status === "ready" && posts.length === 0 && (
        <p className="raid-feed-state" role="status">
          Расписание появится здесь, когда источник будет подключён и опубликует
          пост с таблицей рейдов.
        </p>
      )}
      {state.status === "ready" && posts.length > 0 && (
        <div className="raid-post-list" aria-live="polite">
          {posts.map((post, index) => {
            const content = (
              <>
                <div className="raid-day-heading">
                  <div>
                    <p className="raid-day-kicker">
                      {index === 0 ? "ПОСЛЕДНЕЕ РАСПИСАНИЕ" : "АРХИВ"}
                    </p>
                    <Title as="h3">{post.raidDateLabel}</Title>
                    {post.timeZone && (
                      <p className="raid-time-zone">Время: {post.timeZone}</p>
                    )}
                  </div>
                  <a
                    className="raid-post-link"
                    href={post.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Пост канала <span aria-hidden="true">↗</span>
                  </a>
                </div>
                <ul className="raid-event-grid">
                  {post.raids.map((raid, raidIndex) => (
                    <li key={`${post.sourceMessageId}-${raidIndex}`}>
                      <RaidEventCard raid={raid} />
                    </li>
                  ))}
                </ul>
              </>
            );

            return index === 0 ? (
              <section
                className="raid-post"
                key={post.sourceMessageId}
                aria-label={`Рейды на ${post.raidDateLabel}`}
              >
                {content}
              </section>
            ) : (
              <details
                className="raid-post raid-post--archive"
                key={post.sourceMessageId}
              >
                <summary>
                  <span className="raid-archive-title">
                    {post.raidDateLabel}
                  </span>
                  <span className="raid-archive-meta">
                    {post.raids.length}{" "}
                    {post.raids.length === 1 ? "рейд" : "рейдов"}
                  </span>
                </summary>
                {content}
              </details>
            );
          })}
        </div>
      )}
    </ContentSection>
  );
}
