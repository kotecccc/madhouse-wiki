import { getSessionJson } from "../../../shared/session-api.js";
import { useEffect, useState } from "react";
import { telegramContext } from "../../../shared/telegram-context.js";
import { connectorOrigin } from "../../../connector/protocol.js";
import {
  AUTH_RESTORE_SETTLED_EVENT,
  hasAuthRestoreSettled,
  readSession,
  subscribeSession,
} from "../../../shared/auth-session.js";

const hasTelegramConnector = !!connectorOrigin(
  import.meta.env.VITE_TELEGRAM_CONNECTOR_ORIGIN,
);

function isTelegramRestorePending() {
  const context = telegramContext();
  return (
    hasTelegramConnector &&
    context.isTelegram &&
    !!context.initData &&
    !hasAuthRestoreSettled()
  );
}

// Account access is transient UI state, never part of the reference catalogue.
export function useFloorAvailability() {
  const [availability, setAvailability] = useState({});
  const [status, setStatus] = useState(() =>
    readSession().status === "ready" || isTelegramRestorePending()
      ? "loading"
      : "idle",
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
        setStatus(isTelegramRestorePending() ? "loading" : "idle");
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
    const restoreSettled = () => {
      if (readSession().status !== "ready") load();
    };
    window.addEventListener(AUTH_RESTORE_SETTLED_EVENT, restoreSettled);
    const timer = setInterval(() => {
      if (previousStatus !== readSession().status) load();
    }, 1000);
    return () => {
      controller?.abort();
      unsubscribe();
      window.removeEventListener(AUTH_RESTORE_SETTLED_EVENT, restoreSettled);
      clearInterval(timer);
    };
  }, [requestId]);
  return { availability, status, retry: () => setRequestId((id) => id + 1) };
}
