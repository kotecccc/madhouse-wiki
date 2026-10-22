import { useCallback, useEffect, useState } from "react";

const REFRESH_INTERVAL = 10 * 1000;

export function useRaidSchedule() {
  const [state, setState] = useState({
    status: "loading",
    posts: [],
    nextCursor: null,
  });
  const [reload, setReload] = useState(0);
  const loadSchedule = useCallback(async (signal) => {
    try {
      const response = await fetch("/api/raids?limit=1", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("schedule-unavailable");
      const result = await response.json();
      const nextPosts = Array.isArray(result.posts) ? result.posts : [];
      setState((current) =>
        current.status === "ready" &&
        JSON.stringify(current.posts) === JSON.stringify(nextPosts) &&
        current.nextCursor === result.nextCursor
          ? current
          : {
              status: "ready",
              posts: nextPosts,
              nextCursor: result.nextCursor || null,
            },
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

  return {
    ...state,
    retry: () => setReload((value) => value + 1),
  };
}
