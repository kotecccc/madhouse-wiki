import {
  getSessionJson,
  peekSessionJson,
  subscribeSessionData,
} from "../../../shared/session-api.js";
import { useEffect, useState } from "react";
import { readSession } from "../../../shared/auth-session.js";

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

function departmentResult(code, body) {
  return {
    code,
    status: "ready",
    availability: departmentAccess(body),
    departments: departmentDetails(body),
    businessLevels: (Array.isArray(body?.businesses) ? body.businesses : [])
      .filter(
        (business) =>
          Number.isFinite(business?.id) && Number.isFinite(business?.level),
      )
      .map(({ id, level }) => ({ id, level })),
  };
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
  const path = code ? `/api/floors/${encodeURIComponent(code)}/info` : null;
  useEffect(
    () =>
      subscribeSessionData((event) => {
        if (event.cleared) {
          setState({});
          setRevision((value) => value + 1);
        } else if (event.path === path && path) {
          setState(departmentResult(code, event.data));
        }
      }),
    [path, code],
  );
  const shouldLoad = Boolean(
    code &&
    floorStatus === "ready" &&
    floorAvailable === true &&
    isLastAvailableFloor === true &&
    readSession().status === "ready",
  );
  const cachedBody =
    shouldLoad && path ? peekSessionJson(path, { allowStale: true }) : null;
  const cachedResult = cachedBody ? departmentResult(code, cachedBody) : null;
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    if (!shouldLoad || !path) return () => controller.abort();
    const cachedBody = peekSessionJson(path, { allowStale: true });
    const cachedResult = cachedBody ? departmentResult(code, cachedBody) : null;
    setState(cachedResult || { code, status: "loading" });
    const load = async () => {
      try {
        const body = await getSessionJson(path, { signal });
        if (!signal.aborted) setState(departmentResult(code, body));
      } catch {
        if (!signal.aborted && !cachedResult)
          setState({ code, status: "error" });
      }
    };
    load();
    return () => controller.abort();
  }, [code, path, shouldLoad, revision]);
  return !shouldLoad ? {} : state.code === code ? state : cachedResult || {};
}
