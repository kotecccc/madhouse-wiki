import { useEffect, useState } from "react";
import {
  readSession,
  subscribeSession,
} from "../../../../shared/auth-session.js";
import {
  readStoredSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../../shared/session-api.js";
import { businessStatesFromFloorInfo } from "../../floors/useDepartmentAvailability.js";

export function useFloorBusinessStates(floorCode, enabled = true) {
  const path = floorCode
    ? `/api/floors/${encodeURIComponent(floorCode)}/info`
    : null;
  const [state, setState] = useState(null);
  const [revision, setRevision] = useState(0);
  useEffect(
    () =>
      subscribeSession(() => {
        setState(null);
        setRevision((value) => value + 1);
      }),
    [],
  );
  useEffect(
    () =>
      subscribeSessionData(
        (event) => {
          if (event.cleared) {
            setState(null);
            setRevision((value) => value + 1);
          } else if (event.path === path)
            setState({ path, data: businessStatesFromFloorInfo(event.data) });
        },
        { resources: enabled && path ? [path] : [] },
      ),
    [path, enabled],
  );
  useEffect(() => {
    if (
      !enabled ||
      !path ||
      (readSession().status !== "ready" && !readSession().wikiSessionReady)
    )
      return;
    const controller = new AbortController();
    const cached = peekSessionJson(path, { allowStale: true });
    if (cached) setState({ path, data: businessStatesFromFloorInfo(cached) });
    void readStoredSessionJson(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && result.presence === "present")
          setState({ path, data: businessStatesFromFloorInfo(result.data) });
      })
      .catch(() => {});
    return () => controller.abort();
  }, [path, enabled, revision]);

  if (
    !enabled ||
    !path ||
    (readSession().status !== "ready" && !readSession().wikiSessionReady)
  )
    return null;
  const cached = peekSessionJson(path, { allowStale: true });
  return cached
    ? businessStatesFromFloorInfo(cached)
    : state?.path === path
      ? state.data
      : null;
}
