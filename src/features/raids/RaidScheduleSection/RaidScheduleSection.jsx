import { useCallback, useEffect, useMemo, useState } from "react";
import { ContentSection } from "../../../components/ui/ContentSection/ContentSection.jsx";
import { Title } from "../../../components/ui/Title/Title.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { RaidEventCard } from "../RaidEventCard/RaidEventCard.jsx";
import {
  getRaidStatus,
  raidTimeMinutes,
  sortRaidsByTime,
} from "../../../lib/raid-schedule.js";
import "./RaidScheduleSection.css";

const REFRESH_INTERVAL = 10 * 1000;
const EARLY_MORNING = 6 * 60;
const LATE_EVENING = 23 * 60;
const DAY_TICKS = [
  EARLY_MORNING,
  9 * 60,
  12 * 60,
  15 * 60,
  18 * 60,
  21 * 60,
  LATE_EVENING,
];

function formatMinutes(minutes) {
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function getTimeScale(raids) {
  const eventMinutes = raids
    .map((raid) => raidTimeMinutes(raid?.time))
    .filter(Number.isFinite);
  const start = Math.min(EARLY_MORNING, ...eventMinutes);
  const end = Math.max(LATE_EVENING, ...eventMinutes);
  const expandedStart = start < EARLY_MORNING;
  const expandedEnd = end > LATE_EVENING;
  const ticks = DAY_TICKS.filter(
    (minutes) =>
      minutes >= start &&
      minutes <= end &&
      (!expandedStart || minutes - start >= 2 * 60) &&
      (!expandedEnd || end - minutes >= 2 * 60),
  );
  if (expandedStart) ticks.unshift(start);
  if (expandedEnd) ticks.push(end);

  return {
    start,
    end,
    ticks,
    position(minutes) {
      return ((minutes - start) / (end - start)) * 100;
    },
  };
}

function getRaidMarkers(raids) {
  const markers = [];
  for (const raid of raids) {
    const minutes = raidTimeMinutes(raid?.time);
    if (!Number.isFinite(minutes)) continue;
    const status = getRaidStatus(raid);
    const previous = markers.at(-1);
    if (previous && minutes - previous.minutes < 40) {
      previous.raids.push(raid);
      if (previous.status !== status) previous.status = "unknown";
      continue;
    }
    markers.push({ minutes, status, raids: [raid] });
  }
  return markers;
}

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
      const nextPosts = Array.isArray(result.posts) ? result.posts : [];
      setState((current) =>
        current.status === "ready" &&
        JSON.stringify(current.posts) === JSON.stringify(nextPosts)
          ? current
          : { status: "ready", posts: nextPosts },
      );
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
        <Title as="h2" id="raids-title">
          Расписание рейдов
        </Title>
        <a
          className="raid-channel-link button button-secondary"
          href="https://t.me/raidsMadness"
          target="_blank"
          rel="noreferrer"
          aria-label="Открыть канал Рейд-центр в Telegram"
          title="Канал Рейд-центр в Telegram"
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
          Пока нет сохранённых расписаний. Новые рейды появятся здесь после
          синхронизации канала.
        </p>
      )}
      {state.status === "ready" && posts.length > 0 && (
        <div className="raid-post-list" aria-live="polite">
          {posts.map((post, index) => {
            const raids = sortRaidsByTime(post.raids);
            const timeScale = getTimeScale(raids);
            const timeMarkers = getRaidMarkers(raids);
            const content = (
              <>
                <div className="raid-day-context">
                  <time className="raid-day-date" dateTime={post.raidDate}>
                    {post.raidDateLabel}
                  </time>
                  {post.timeZone && (
                    <span className="raid-day-timezone">
                      Время: {post.timeZone}
                    </span>
                  )}
                </div>
                <div className="raid-day-scale">
                  <div className="raid-time-axis" aria-hidden="true">
                    {timeScale.ticks.map((minutes, tickIndex) => (
                      <span
                        className={[
                          "raid-time-tick",
                          tickIndex === 0 && "raid-time-tick--start-edge",
                          tickIndex === timeScale.ticks.length - 1 &&
                            "raid-time-tick--end-edge",
                          [9 * 60, 15 * 60, 21 * 60].includes(minutes) &&
                            "raid-time-tick--secondary",
                          minutes === LATE_EVENING &&
                            "raid-time-tick--late-evening",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        key={minutes}
                        style={{ left: `${timeScale.position(minutes)}%` }}
                      >
                        <time>{formatMinutes(minutes)}</time>
                        {(minutes === EARLY_MORNING ||
                          (minutes === timeScale.start &&
                            timeScale.start < EARLY_MORNING)) && (
                          <small>
                            {minutes < 4 * 60 ? "Ночь" : "Раннее утро"}
                          </small>
                        )}
                        {(minutes === LATE_EVENING ||
                          (minutes === timeScale.end &&
                            timeScale.end > LATE_EVENING)) && (
                          <small>Поздний вечер</small>
                        )}
                      </span>
                    ))}
                  </div>
                  <div className="raid-time-marker-track" aria-hidden="true">
                    {timeMarkers.map((marker, markerIndex) => {
                      const isStart = marker.minutes === timeScale.start;
                      const isEnd = marker.minutes === timeScale.end;
                      const names = marker.raids.map(
                        (raid) => `${raid.time} ${raid.boss || "Босс не указан"}`,
                      );
                      return (
                        <span
                          className={[
                            "raid-time-marker",
                            `raid-time-marker--${marker.status}`,
                            marker.raids.length > 1 &&
                              "raid-time-marker--multiple",
                            isStart && "raid-time-marker--start-edge",
                            isEnd && "raid-time-marker--end-edge",
                          ]
                            .filter(Boolean)
                            .join(" ")}
                          key={`${post.sourceMessageId}-${markerIndex}`}
                          style={{ left: `${timeScale.position(marker.minutes)}%` }}
                          title={names.join(" · ")}
                        >
                          {marker.raids.length > 1 ? marker.raids.length : null}
                        </span>
                      );
                    })}
                  </div>
                </div>
                <ol
                  className="raid-timeline-list"
                  aria-label={`Рейды на ${post.raidDateLabel}`}
                >
                  {raids.map((raid, raidIndex) => {
                    const status = getRaidStatus(raid);
                    const minutes = raidTimeMinutes(raid.time);
                    const validTime = Number.isFinite(minutes);
                    return (
                      <li
                        className={`raid-timeline-item raid-timeline-item--${status}`}
                        key={`${post.sourceMessageId}-${raid.time}-${raidIndex}`}
                      >
                        <time
                          className="raid-timeline-time"
                          dateTime={validTime ? formatMinutes(minutes) : undefined}
                        >
                          {raid.time || "—"}
                        </time>
                        <RaidEventCard raid={raid} status={status} />
                      </li>
                    );
                  })}
                </ol>
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
