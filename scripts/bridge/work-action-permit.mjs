/** One in-memory permit bound to a persisted work checkpoint. */
export function createWorkActionPermit({
  authorization,
  workId,
  taskId,
  operationId,
  checkpointIsCurrent,
}) {
  if (
    typeof authorization !== "string" ||
    !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization) ||
    !Number.isSafeInteger(workId) ||
    workId <= 0 ||
    !Number.isSafeInteger(taskId) ||
    taskId <= 0 ||
    typeof operationId !== "string" ||
    !operationId ||
    operationId.length > 256 ||
    typeof checkpointIsCurrent !== "function"
  )
    throw new TypeError("invalid_work_permit");
  let used = false;
  return (request) => {
    if (
      used ||
      request?.authorization !== authorization ||
      request.method !== "POST" ||
      request.path !== "/api/works/tasks/perform" ||
      typeof request.body !== "string"
    )
      return false;
    let body;
    try {
      body = JSON.parse(request.body);
    } catch {
      return false;
    }
    if (
      !body ||
      Object.keys(body).sort().join(",") !==
        "locale,operationId,taskId,workId" ||
      body.locale !== "ru" ||
      body.workId !== workId ||
      body.taskId !== taskId ||
      body.operationId !== operationId
    )
      return false;
    try {
      if (checkpointIsCurrent() !== true) return false;
    } catch {
      return false;
    }
    used = true;
    return true;
  };
}
