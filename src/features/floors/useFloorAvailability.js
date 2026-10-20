import { getSessionJson } from "../../../shared/session-api.js";
import { useEffect, useState } from "react";
import { readSession, subscribeSession } from "../../../shared/auth-session.js";

// Account access is transient UI state, never part of the reference catalogue.
export function useFloorAvailability() {
  const [availability, setAvailability] = useState({});
  const [status, setStatus] = useState(() =>
    readSession().status === "ready" ? "loading" : "idle",
  );
  const [requestId, setRequestId] = useState(0);
  useEffect(() => {
    let controller;
    let previousStatus = readSession().status;
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const session = readSession();
      previousStatus = session.status;
      setAvailability({});
      if (session.status !== "ready") {
        setStatus("idle");
        return;
      }
      setStatus("loading");
      try {
        const floors = await getSessionJson("/api/floors", { signal });
        if (signal.aborted) return;
        if (!Array.isArray(floors)) throw new Error("Invalid floors response");
        const next = {};
        for (const floor of floors) {
          if (
            typeof floor.code === "string" &&
            typeof floor.isAvailable === "boolean"
          )
            next[floor.code] = floor.isAvailable;
        }
        setAvailability(next);
        setStatus("ready");
      } catch {
        if (!signal.aborted) {
          setAvailability({});
          setStatus("error");
        }
      }
    };
    load();
    const unsubscribe = subscribeSession(load);
    const timer = setInterval(() => {
      if (previousStatus !== readSession().status) load();
    }, 1000);
    return () => {
      controller?.abort();
      unsubscribe();
      clearInterval(timer);
    };
  }, [requestId]);
  return { availability, status, retry: () => setRequestId((id) => id + 1) };
}
