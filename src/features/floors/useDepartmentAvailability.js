import { getSessionJson } from "../../../shared/session-api.js";
import { useEffect, useState } from "react";
import { readSession, subscribeSession } from "../../../shared/auth-session.js";

export function departmentAccess(response) {
  const result = {};
  for (const department of Array.isArray(response?.departments)
    ? response.departments
    : []) {
    if (
      typeof department.blockCode === "string" &&
      typeof department.unlocked === "boolean"
    )
      result[department.blockCode] = department.unlocked;
  }
  return result;
}

// Access belongs to the signed-in session and is never written to the catalogue.
export function useDepartmentAvailability(code, floorStatus, floorAvailable) {
  const [state, setState] = useState({});
  const [revision, setRevision] = useState(0);
  useEffect(
    () =>
      subscribeSession(() => {
        setState({});
        setRevision((value) => value + 1);
      }),
    [],
  );
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState({});
    if (
      !code ||
      floorStatus !== "ready" ||
      floorAvailable !== true ||
      readSession().status !== "ready"
    )
      return () => controller.abort();
    setState({ code, status: "loading" });
    const load = async () => {
      try {
        const body = await getSessionJson(
          `/api/floors/${encodeURIComponent(code)}/info`,
          { signal },
        );
        if (!signal.aborted)
          setState({
            code,
            status: "ready",
            availability: departmentAccess(body),
          });
      } catch {
        if (!signal.aborted) setState({ code, status: "error" });
      }
    };
    load();
    return () => controller.abort();
  }, [code, floorStatus, floorAvailable, revision]);
  return state.code === code ? state : {};
}
