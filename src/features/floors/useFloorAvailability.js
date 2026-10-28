import {
  getSessionJson,
  peekSessionJson,
  subscribeSessionData,
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

function floorState(floors) {
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
                (requirement) => requirement && typeof requirement === "object",
              )
              .map((requirement) => ({
                type:
                  typeof requirement.type === "string" ? requirement.type : "",
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
                  typeof requirement.met === "boolean" ? requirement.met : null,
                workId: requirement.workId ?? null,
                bossId: requirement.bossId ?? null,
                businessId: requirement.businessId ?? null,
                medallionId: requirement.medallionId ?? null,
              }))
          : null,
      };
    }
  }
  return { availability: next, floorDetails: details };
}

// Account access is transient UI state, never part of the reference catalogue.
export function useFloorAvailability({ profileSettled = true } = {}) {
  const [availability, setAvailability] = useState(
    () =>
      floorState(peekSessionJson("/api/floors", { allowStale: true }) || [])
        .availability,
  );
  const [floorDetails, setFloorDetails] = useState(
    () =>
      floorState(peekSessionJson("/api/floors", { allowStale: true }) || [])
        .floorDetails,
  );
  const [status, setStatus] = useState(() =>
    peekSessionJson("/api/floors", { allowStale: true })
      ? "ready"
      : readSession().status === "ready" || isTelegramRestorePending()
        ? "loading"
        : "idle",
  );
  const [requestId, setRequestId] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const loadCatalogue = async () => {
      try {
        const response = await fetch("/api/catalogue", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) {
          const data = await response.json();
          if (controller.signal.aborted) return;
          mergeKnowledgeBaseOverlay(data);
          setAvailability((current) => ({ ...current }));
        }
      } catch {
        // The bundled SQLite catalogue remains usable when the runtime store is unavailable.
      }
    };
    void loadCatalogue();
    return () => controller.abort();
  }, [requestId]);
  useEffect(() => {
    let controller;
    let previousStatus = readSession().status;
    let identity = readSession().token;
    const applyFloors = (floors) => {
      if (!Array.isArray(floors)) return;
      const next = floorState(floors);
      setAvailability(next.availability);
      setFloorDetails(next.floorDetails);
      setStatus("ready");
    };
    const load = async () => {
      controller?.abort();
      controller = new AbortController();
      const signal = controller.signal;
      const session = readSession();
      previousStatus = session.status;
      const changed = identity !== session.token;
      identity = session.token;
      const cached = peekSessionJson("/api/floors", { allowStale: true });
      if (cached) applyFloors(cached);
      else if (changed || session.status !== "ready") {
        setAvailability({});
        setFloorDetails({});
        setStatus(
          session.status === "ready" || isTelegramRestorePending()
            ? "loading"
            : "idle",
        );
      }
      if (signal.aborted) return;
      if (session.status !== "ready") {
        setStatus(isTelegramRestorePending() ? "loading" : "idle");
        return;
      }
      if (!profileSettled) {
        if (!cached) setStatus("loading");
        return;
      }
      try {
        const floors = await getSessionJson("/api/floors", { signal });
        if (signal.aborted) return;
        if (!Array.isArray(floors)) throw new Error("Invalid floors response");
        const { availability: next, floorDetails: details } =
          floorState(floors);
        setAvailability(next);
        setFloorDetails(details);
        setStatus("ready");
      } catch {
        if (!signal.aborted) {
          setStatus((current) => (current === "ready" ? current : "error"));
        }
      }
    };
    load();
    const unsubscribe = subscribeSession(load);
    const unsubscribeData = subscribeSessionData((event) => {
      if (event.path === "/api/floors") applyFloors(event.data);
      if (event.cleared) {
        setAvailability({});
        setFloorDetails({});
        setStatus(readSession().status === "ready" ? "loading" : "idle");
      }
    });
    const restoreSettled = () => {
      if (readSession().status !== "ready") load();
    };
    window.addEventListener(AUTH_RESTORE_SETTLED_EVENT, restoreSettled);
    const timer = setInterval(() => {
      if (previousStatus !== readSession().status) {
        load();
      }
    }, 1000);
    return () => {
      controller?.abort();
      unsubscribe();
      unsubscribeData();
      window.removeEventListener(AUTH_RESTORE_SETTLED_EVENT, restoreSettled);
      clearInterval(timer);
    };
  }, [requestId, profileSettled]);
  return {
    availability,
    floorDetails,
    status,
    retry: () => {
      setRequestId((id) => id + 1);
    },
  };
}
