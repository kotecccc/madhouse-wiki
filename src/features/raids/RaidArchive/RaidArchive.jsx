import { useEffect, useRef, useState } from "react";
import { BaseCard } from "../../../components/ui/BaseCard/BaseCard.jsx";
import { CardTitle } from "../../../components/ui/CardTitle/CardTitle.jsx";
import { Button } from "../../../components/ui/Button/Button.jsx";
import { Icon } from "../../../components/ui/Icon/Icon.jsx";
import { LoadingStatus } from "../../../components/ui/LoadingStatus/LoadingStatus.jsx";
import { RaidPost } from "../RaidPost/RaidPost.jsx";
import "./RaidArchive.css";
import { trackProductEvent } from "../../analytics/analytics-client.js";

function ArchivePages({ cursor, floorAvailability }) {
  const [request, setRequest] = useState({ cursor });
  const [state, setState] = useState({
    posts: [],
    status: "loading",
    nextCursor: null,
  });
  const sentinel = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      setState((current) => ({ ...current, status: "loading" }));
      try {
        const params = new URLSearchParams({
          limit: "3",
          before: request.cursor,
        });
        const response = await fetch(`/api/raids?${params}`, {
          headers: { Accept: "application/json" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("archive-unavailable");
        const result = await response.json();
        if (!Array.isArray(result.posts))
          throw new Error("archive-unavailable");
        if (controller.signal.aborted) return;
        setState((current) => {
          const byId = new Map(
            current.posts.map((post) => [String(post.sourceMessageId), post]),
          );
          for (const post of result.posts)
            byId.set(String(post.sourceMessageId), post);
          return {
            posts: [...byId.values()],
            status: "ready",
            nextCursor: result.nextCursor || null,
          };
        });
      } catch (error) {
        if (error.name !== "AbortError")
          setState((current) => ({ ...current, status: "error" }));
      }
    }
    load();
    return () => controller.abort();
  }, [request]);

  useEffect(() => {
    if (state.status !== "ready" || !state.nextCursor || !sentinel.current)
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setRequest({ cursor: state.nextCursor });
      },
      { rootMargin: "240px" },
    );
    observer.observe(sentinel.current);
    return () => observer.disconnect();
  }, [state.status, state.nextCursor]);

  return (
    <div className="raid-archive-posts">
      {state.posts.map((post) => (
        <RaidPost
          key={post.sourceMessageId}
          post={post}
          archive
          floorAvailability={floorAvailability}
        />
      ))}
      <div ref={sentinel} className="raid-archive-loader">
        {state.status === "loading" && (
          <LoadingStatus>Загружаем архив…</LoadingStatus>
        )}
        {state.status === "error" && (
          <>
            <p role="status">Не удалось загрузить архив.</p>
            <Button
              variant="secondary"
              onClick={() => setRequest({ ...request })}
            >
              Повторить
            </Button>
          </>
        )}
        {state.status === "ready" && state.nextCursor && (
          <Button
            variant="secondary"
            onClick={() => setRequest({ cursor: state.nextCursor })}
          >
            Загрузить ещё
          </Button>
        )}
        {state.status === "ready" && !state.nextCursor && (
          <p>Архив загружен полностью.</p>
        )}
      </div>
    </div>
  );
}

export function RaidArchive({ cursor, floorAvailability = {} }) {
  const [open, setOpen] = useState(false);
  return (
    <BaseCard
      as="details"
      variant="archive"
      className="raid-archive"
      onToggle={(event) => {
        setOpen(event.currentTarget.open);
        if (event.currentTarget.open)
          trackProductEvent("raid_archive_open", {
            section: "raids",
            feature: "raid_archive",
          });
      }}
    >
      <summary>
        <CardTitle as="span">Архив рейдов</CardTitle>
        <Icon type="chevron" size="small" />
      </summary>
      {open && (
        <ArchivePages cursor={cursor} floorAvailability={floorAvailability} />
      )}
    </BaseCard>
  );
}
