export function workFarmCardState({
  run,
  workId,
  departmentCode,
  preview,
  dev,
}) {
  const test = Boolean(dev && preview && preview === departmentCode);
  const active =
    Number.isSafeInteger(workId) &&
    workId > 0 &&
    run?.status === "running" &&
    run.workId === workId;
  return { active: active || test, test };
}
