import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import {
  getSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import { businessStatesFromFloorInfo } from "../../floors/useDepartmentAvailability.js";
import { businessAssistant } from "../../bosses/BossBattle/boss-battle-session.js";

export function completedUpgradeNeedsFloorRefresh(run, states) {
  if (run?.status !== "completed" || run.config?.autoUpgrade !== true)
    return false;
  const match = /^business:(\d+)$/.exec(run.businessId ?? "");
  if (!match || !Number.isSafeInteger(run.targetLevel)) return false;
  const level = states?.[Number(match[1])]?.level;
  return Number.isSafeInteger(level) && level < run.targetLevel;
}

export function useFloorBusinessStates(floorCode, enabled = true) {
  const path = floorCode
    ? `/api/floors/${encodeURIComponent(floorCode)}/info`
    : null;
  const [state, setState] = useState(null);
  const [revision, setRevision] = useState(0);
  const requestedUpgrade = useRef(null);
  const assistant = useSyncExternalStore(
    businessAssistant.subscribe,
    businessAssistant.getSnapshot,
    businessAssistant.getSnapshot,
  );

  useEffect(
    () =>
      subscribeSession(() => {
        setState(null);
        requestedUpgrade.current = null;
        setRevision((value) => value + 1);
      }),
    [],
  );
  useEffect(
    () =>
      subscribeSessionData((event) => {
        if (event.cleared) {
          setState(null);
          setRevision((value) => value + 1);
        } else if (event.path === path)
          setState({ path, data: businessStatesFromFloorInfo(event.data) });
      }),
    [path],
  );
  useEffect(() => {
    if (!enabled || !path || readSession().status !== "ready") return;
    const controller = new AbortController();
    const cached = peekSessionJson(path, { allowStale: true });
    if (cached) setState({ path, data: businessStatesFromFloorInfo(cached) });
    void getSessionJson(path, { signal: controller.signal })
      .then((data) => {
        if (!controller.signal.aborted)
          setState({ path, data: businessStatesFromFloorInfo(data) });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [path, enabled, revision]);

  useEffect(() => {
    if (!enabled || !path || readSession().status !== "ready") return;
    const run = assistant.run;
    const cached = peekSessionJson(path, { allowStale: true });
    if (
      !completedUpgradeNeedsFloorRefresh(
        run,
        businessStatesFromFloorInfo(cached),
      )
    )
      return;
    const key = `${path}:${run.id}`;
    if (requestedUpgrade.current === key) return;
    requestedUpgrade.current = key;
    void getSessionJson(path, { fresh: true, serverRefresh: "live" }).catch(
      () => {},
    );
  }, [assistant.run, enabled, path, state]);

  if (!enabled || !path || readSession().status !== "ready") return null;
  const cached = peekSessionJson(path, { allowStale: true });
  return cached
    ? businessStatesFromFloorInfo(cached)
    : state?.path === path
      ? state.data
      : null;
}
