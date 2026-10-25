const sameId = (entity, value) =>
  value != null &&
  [entity?.id, entity?.apiId, entity?.numericId].some(
    (id) => id != null && String(id) === String(value),
  );

const isNonnegativeSafeInteger = (value) =>
  Number.isSafeInteger(value) && value >= 0;

/** Resolve the next locked destination to catalogue entities without name guesses. */
export function progressionTargets({
  floors,
  departments,
  bosses,
  businesses,
  availability,
  floorDetails = {},
  departmentState = {},
}) {
  const lastFloor = [...floors]
    .reverse()
    .find((floor) => availability[floor.code] === true);
  if (!lastFloor) return [];
  const floorDepartments = departments
    .filter((department) => department.floorId === lastFloor.id)
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
  const confirmedDepartments =
    departmentState.code === lastFloor.code &&
    departmentState.status === "ready"
      ? departmentState.departments || []
      : [];
  const nextDepartment = floorDepartments.find((department) =>
    confirmedDepartments.some(
      (entry) =>
        entry.blockCode === department.code && entry.unlocked === false,
    ),
  );
  // Do not suggest the next floor before department access is known.
  if (
    !nextDepartment &&
    (!confirmedDepartments.length ||
      floorDepartments.some(
        (department) =>
          !confirmedDepartments.some(
            (entry) =>
              entry.blockCode === department.code && entry.unlocked === true,
          ),
      ))
  )
    return [];
  const nextFloor = floors
    .slice(floors.findIndex((floor) => floor.id === lastFloor.id) + 1)
    .find((floor) => availability[floor.code] === false);
  const destination = nextDepartment || nextFloor;
  if (!destination) return [];
  const apiRequirements = nextDepartment
    ? confirmedDepartments.find(
        (entry) => entry.blockCode === nextDepartment.code,
      )?.requirements
    : floorDetails[nextFloor.code]?.unlockRequirements;
  const referenceRequirements = nextDepartment
    ? nextDepartment.openingConditions
    : nextFloor.openingConditions?.length
      ? nextFloor.openingConditions
      : departments.find(
          (department) => department.id === nextFloor.departmentIds?.[0],
        )?.openingConditions;
  const requirements = apiRequirements?.length
    ? apiRequirements
    : referenceRequirements || [];
  return requirements
    .filter((requirement) => requirement.met !== true)
    .flatMap((requirement) => {
      let entity;
      let category;
      let departmentId;
      if (requirement.type === "work_completions") {
        const department = departments.find(
          (entry) =>
            sameId(entry, requirement.targetDepartmentId) ||
            sameId(entry.work, requirement.workId),
        );
        entity = department?.work;
        departmentId = department?.id;
        category = "work";
      } else if (requirement.type === "boss_kills") {
        entity = bosses.find((entry) =>
          sameId(entry, requirement.targetBossId ?? requirement.bossId),
        );
        departmentId = entity?.departmentId;
        category = "bosses";
      } else if (requirement.type === "business_level") {
        entity = businesses.find((entry) =>
          sameId(entry, requirement.targetBusinessId ?? requirement.businessId),
        );
        departmentId = entity?.departmentId;
        category = "businesses";
      }
      if (!entity || !departmentId) return [];
      const label =
        requirement.label ||
        (category === "businesses"
          ? `Улучшить ${entity.title} до уровня ${requirement.requiredLevel ?? requirement.required}`
          : `${category === "work" ? "Выполнить" : "Победить"} ${entity.title || entity.name} ${requirement.required} раз`);
      return [
        {
          category,
          entityId: entity.id,
          departmentId,
          label,
          required: requirement.required,
          ...(isNonnegativeSafeInteger(requirement.current)
            ? { current: requirement.current }
            : {}),
          destination: destination.code,
          ...(requirement.note ? { note: requirement.note } : {}),
          ...(requirement.verification
            ? { verification: requirement.verification }
            : {}),
          text: `Для открытия ${destination.code}: ${label}`,
        },
      ];
    });
}
