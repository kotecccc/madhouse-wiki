const positive = (value) => Number.isSafeInteger(value) && value > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;

// Only live, explicitly unmet requirements can produce a game action. Reference
// catalogue conditions may be incomplete and therefore never authorize one.
export function planFloorProgress({ floors, info, catalogue }) {
  if (!Array.isArray(floors) || !Array.isArray(catalogue?.floors))
    return { status: "waiting", reason: "Данные этажей недоступны." };
  const ordered = catalogue.floors;
  const available = ordered.filter((floor) =>
    floors.some(
      (item) => item.code === floor.code && item.isAvailable === true,
    ),
  );
  const current = available.at(-1);
  if (!current || !Array.isArray(info?.departments))
    return { status: "waiting", reason: "Условия этажа ещё не подтверждены." };
  const departments = catalogue.departments
    .filter((item) => item.floorId === current.id)
    .sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
  const states = departments.map((item) =>
    info.departments.find((state) => state.blockCode === item.code),
  );
  if (
    !states.length ||
    states.some((state) => typeof state?.unlocked !== "boolean")
  )
    return {
      status: "waiting",
      reason: "Доступ к отделениям ещё не подтверждён.",
    };
  const locked = states.find((state) => !state.unlocked);
  const next = ordered
    .slice(ordered.indexOf(current) + 1)
    .find((item) =>
      floors.some(
        (floor) => floor.code === item.code && floor.isAvailable === false,
      ),
    );
  const destination = locked ?? floors.find((item) => item.code === next?.code);
  if (!destination)
    return { status: "waiting", reason: "Следующая цель не найдена." };
  const requirements = locked
    ? destination.requirements
    : destination.unlockRequirements;
  if (!Array.isArray(requirements) || !requirements.length)
    return {
      status: "waiting",
      reason: "Условия открытия ещё не подтверждены.",
    };
  for (const requirement of requirements) {
    if (requirement.met === true) continue;
    const mapping = {
      work_completions: ["work", "workId"],
      boss_kills: ["boss", "bossId"],
      business_level: ["business", "businessId"],
    }[requirement.type];
    if (
      !mapping ||
      !positive(requirement[mapping[1]]) ||
      !positive(requirement.required) ||
      !count(requirement.current)
    )
      return {
        status: "waiting",
        reason: "Не удалось подтвердить цель и её текущий прогресс.",
      };
    if (requirement.current >= requirement.required) continue;
    const [kind, field] = mapping;
    const items =
      kind === "work"
        ? catalogue.departments.map((item) => item.work).filter(Boolean)
        : (catalogue[`${kind}es`] ?? catalogue[`${kind}s`]);
    const matches = (items || []).filter(
      (item) => Number(item.apiId ?? item.numericId) === requirement[field],
    );
    if (matches.length !== 1)
      return {
        status: "waiting",
        reason: "Цель отсутствует в справочнике или неоднозначна.",
      };
    return {
      status: "ready",
      destination: destination.blockCode ?? destination.code,
      kind,
      entityId: matches[0].id,
      apiId: requirement[field],
      current: requirement.current,
      required: requirement.required,
    };
  }
  return { status: "waiting", reason: "Ожидаем подтверждения открытия." };
}
