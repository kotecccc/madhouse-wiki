import { useCallback, useEffect, useRef, useState } from "react";

const REFRESH_INTERVAL = 3 * 60 * 1000;

export function useRaidSchedule() {
  const [state, setState] = useState({
    status: "loading",
    posts: [],
    nextCursor: null,
  });
  const [reload, setReload] = useState(0);
  const lastRefreshAt = useRef(0);
  const requestInFlight = useRef(false);
  const pendingRefresh = useRef(false);
  const controllerRef = useRef(null);
  const loadSchedule = useCallback(async (signal) => {
    if (requestInFlight.current) {
      pendingRefresh.current = true;
      return;
    }
    requestInFlight.current = true;
    lastRefreshAt.current = Date.now();
    try {
      const response = await fetch("/api/raids?limit=1", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal,
      });
      if (!response.ok) throw new Error("schedule-unavailable");
      const result = await response.json();
      if (signal?.aborted) return;
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
    } finally {
      requestInFlight.current = false;
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        if (
          !document.hidden &&
          controllerRef.current &&
          !controllerRef.current.signal.aborted
        )
          loadSchedule(controllerRef.current.signal);
      }
    }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    loadSchedule(controller.signal);
    const refreshIfDue = () => {
      if (
        document.hidden ||
        Date.now() - lastRefreshAt.current < REFRESH_INTERVAL
      )
        return;
      if (requestInFlight.current) {
        pendingRefresh.current = true;
        return;
      }
      loadSchedule(controller.signal);
    };
    const timer = window.setInterval(refreshIfDue, REFRESH_INTERVAL);
    document.addEventListener("visibilitychange", refreshIfDue);
    return () => {
      controller.abort();
      if (controllerRef.current === controller) controllerRef.current = null;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshIfDue);
    };
  }, [loadSchedule, reload]);

  return {
    ...state,
    retry: () => {
      if (requestInFlight.current) {
        pendingRefresh.current = true;
        return;
      }
      setReload((value) => value + 1);
    },
  };
}
