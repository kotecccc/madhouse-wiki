import { getSessionJson } from "../../../shared/session-api.js";
import { useEffect, useRef, useState } from "react";
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

function departmentDetails(response) {
  return (Array.isArray(response?.departments) ? response.departments : [])
    .filter(
      (department) =>
        typeof department?.blockCode === "string" &&
        typeof department?.unlocked === "boolean",
    )
    .map((department) => ({
      blockCode: department.blockCode,
      name: typeof department.name === "string" ? department.name : "",
      unlocked: department.unlocked,
      requirements: Array.isArray(department.requirements)
        ? department.requirements
            .filter(
              (requirement) => requirement && typeof requirement === "object",
            )
            .map((requirement) => ({
              type:
                typeof requirement.type === "string" ? requirement.type : "",
              label:
                typeof requirement.label === "string" ? requirement.label : "",
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
    }));
}

// Access belongs to the signed-in session and is never written to the catalogue.
export function useDepartmentAvailability(
  code,
  floorStatus,
  floorAvailable,
  isLastAvailableFloor,
) {
  const [state, setState] = useState({});
  const [revision, setRevision] = useState(0);
  const cache = useRef(new Map());
  useEffect(
    () =>
      subscribeSession(() => {
        cache.current.clear();
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
      isLastAvailableFloor !== true ||
      readSession().status !== "ready"
    )
      return () => controller.abort();
    const cached = cache.current.get(code);
    if (cached) {
      setState(cached);
      return () => controller.abort();
    }
    setState({ code, status: "loading" });
    const load = async () => {
      try {
        const body = await getSessionJson(
          `/api/floors/${encodeURIComponent(code)}/info`,
          { signal },
        );
        if (!signal.aborted) {
          const result = {
            code,
            status: "ready",
            availability: departmentAccess(body),
            departments: departmentDetails(body),
          };
          cache.current.set(code, result);
          setState(result);
        }
      } catch {
        if (!signal.aborted) setState({ code, status: "error" });
      }
    };
    load();
    return () => controller.abort();
  }, [code, floorStatus, floorAvailable, isLastAvailableFloor, revision]);
  return state.code === code ? state : {};
}
