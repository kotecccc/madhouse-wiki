import {
  getSessionJson,
  postSessionJson,
} from "../../../shared/session-api.js";
import { useEffect, useRef, useState } from "react";
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
  const [floorDetails, setFloorDetails] = useState({});
  const [status, setStatus] = useState(() =>
    readSession().status === "ready" || isTelegramRestorePending()
      ? "loading"
      : "idle",
  );
  const [requestId, setRequestId] = useState(0);
  const attemptedFloors = useRef(new Set());
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
      setStatus(
        session.status === "ready" || isTelegramRestorePending()
          ? "loading"
          : "idle",
      );
      setAvailability({});
      setFloorDetails({});
      let catalogue = null;
      let importedAny = false;
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
        const details = {};
        for (const floor of floors) {
          if (
            typeof floor.code === "string" &&
            typeof floor.isAvailable === "boolean"
          ) {
            next[floor.code] = floor.isAvailable;
            details[floor.code] = {
              code: floor.code,
              number: Number.isFinite(floor.number) ? floor.number : null,
              requiredLevel: Number.isFinite(floor.requiredLevel)
                ? floor.requiredLevel
                : null,
              isAvailable: floor.isAvailable,
              unlockDescription:
                typeof floor.unlockDescription === "string"
                  ? floor.unlockDescription
                  : "",
              unlockRequirements: Array.isArray(floor.unlockRequirements)
                ? floor.unlockRequirements
                    .filter(
                      (requirement) =>
                        requirement && typeof requirement === "object",
                    )
                    .map((requirement) => ({
                      type:
                        typeof requirement.type === "string"
                          ? requirement.type
                          : "",
                      label:
                        typeof requirement.label === "string"
                          ? requirement.label
                          : "",
                      required: Number.isFinite(requirement.required)
                        ? requirement.required
                        : null,
                      current: Number.isFinite(requirement.current)
                        ? requirement.current
                        : null,
                      met:
                        typeof requirement.met === "boolean"
                          ? requirement.met
                          : null,
                      workId: requirement.workId ?? null,
                      bossId: requirement.bossId ?? null,
                      businessId: requirement.businessId ?? null,
                      medallionId: requirement.medallionId ?? null,
                    }))
                : null,
            };
          }
        }
        setAvailability(next);
        setFloorDetails(details);
        setStatus("ready");
        if (signal.aborted) return;
        const complete = new Set(catalogue?.completeFloors || []);
        for (const floor of floors) {
          if (signal.aborted) return;
          if (
            floor.isAvailable !== true ||
            complete.has(floor.code) ||
            attemptedFloors.current.has(floor.code)
          )
            continue;
          attemptedFloors.current.add(floor.code);
          try {
            await postSessionJson(
              "/api/catalogue",
              { floorCode: floor.code },
              { signal },
            );
            importedAny = true;
          } catch {
            // Retry only after a new login or an explicit user retry.
          }
        }
        if (importedAny && !signal.aborted) {
          const response = await fetch("/api/catalogue", {
            cache: "no-store",
            signal,
          });
          if (response.ok) {
            mergeKnowledgeBaseOverlay(await response.json());
            refreshModel();
          }
        }
      } catch {
        if (!signal.aborted) {
          setAvailability({});
          setFloorDetails({});
          setStatus("error");
        }
      }
    };
    load();
    const unsubscribe = subscribeSession(() => {
      attemptedFloors.current.clear();
      load();
    });
    const restoreSettled = () => {
      if (readSession().status !== "ready") load();
    };
    window.addEventListener(AUTH_RESTORE_SETTLED_EVENT, restoreSettled);
    const timer = setInterval(() => {
      if (previousStatus !== readSession().status) {
        attemptedFloors.current.clear();
        load();
      }
    }, 1000);
    return () => {
      controller?.abort();
      unsubscribe();
      window.removeEventListener(AUTH_RESTORE_SETTLED_EVENT, restoreSettled);
      clearInterval(timer);
    };
  }, [requestId]);
  return {
    availability,
    floorDetails,
    status,
    retry: () => {
      attemptedFloors.current.clear();
      setRequestId((id) => id + 1);
    },
  };
}
