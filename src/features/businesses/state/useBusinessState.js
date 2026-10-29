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
import { normalizeBusinessState } from "./business-state.js";

export function useBusinessState(business, enabled = true) {
  const apiId = Number(business.apiId);
  const path =
    Number.isSafeInteger(apiId) && apiId > 0
      ? `/api/businesses/${apiId}`
      : null;
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState(null);
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
      subscribeSessionData((event) => {
        if (event.cleared) {
          setState(null);
          setRevision((value) => value + 1);
        } else if (event.path === path) {
          setState({ path, data: event.data });
        }
      }),
    [path],
  );
  useEffect(() => {
    if (
      !enabled ||
      !path ||
      (readSession().status !== "ready" && !readSession().wikiSessionReady)
    )
      return;
    const controller = new AbortController();
    void readStoredSessionJson(path, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted && result.presence === "present")
          setState({ path, data: result.data });
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
  const data =
    peekSessionJson(path, { allowStale: true }) ??
    (state?.path === path ? state.data : null);
  return normalizeBusinessState(data, business);
}
