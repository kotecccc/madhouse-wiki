import {
  getSessionJson,
  postSessionJson,
} from "../../../shared/session-api.js";
import { useEffect, useState } from "react";
import { telegramContext } from "../../../shared/telegram-context.js";
import { connectorOrigin } from "../../../connector/protocol.js";
import {
  AUTH_RESTORE_SETTLED_EVENT,
  hasAuthRestoreSettled,
  readSession,
  subscribeSession,
} from "../../../shared/auth-session.js";
import { mergeKnowledgeBaseOverlay } from "../../model/knowledge-base.js";

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
      const refreshModel = () => setAvailability((current) => ({ ...current }));
      const session = readSession();
      previousStatus = session.status;
      setAvailability({});
      let catalogue = null;
      try {
        const response = await fetch("/api/catalogue", {
          cache: "no-store",
          signal,
        });
        if (response.ok) {
          catalogue = await response.json();
          mergeKnowledgeBaseOverlay(catalogue);
          refreshModel();
        }
      } catch {
        // The bundled SQLite catalogue remains usable when the runtime store is unavailable.
      }
      if (signal.aborted) return;
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
        if (signal.aborted) return;
        const complete = new Set(catalogue?.completeFloors || []);
        for (const floor of floors) {
          if (signal.aborted) return;
          if (floor.isAvailable !== true || complete.has(floor.code)) continue;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              const imported = await postSessionJson(
                "/api/catalogue",
                { floorCode: floor.code },
                { signal },
              );
              mergeKnowledgeBaseOverlay(imported);
              refreshModel();
              break;
            } catch {
              if (signal.aborted || attempt > 0) break;
              await new Promise((resolve) => setTimeout(resolve, 1500));
            }
          }
        }
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
