import {
  departmentCardFilename,
  floorCardFilename,
} from "./inline-card-assets.mjs";

const bossKillConditions = (record) =>
  (Array.isArray(record?.openingConditions)
    ? record.openingConditions
    : []
  ).filter((condition) => condition.type === "boss_kills");

function resolveBoss(condition, bossesById, bossesByApiId) {
  const targetId = condition.targetBossId;
  return (
    bossesById.get(String(targetId)) || bossesByApiId.get(String(targetId))
  );
}

function makeGroup(type, record, conditions, resolveTarget, filename) {
  if (!conditions.length) return null;
  const bosses = conditions.map((condition) => ({
    boss: resolveTarget(condition),
    condition,
  }));
  if (bosses.some(({ boss }) => !boss)) return null;
  return {
    key: `${type}:${record.id}`,
    type,
    code: record.code,
    filename,
    bosses,
  };
}

export function bossOpeningGroups(knowledgeBase) {
  const bosses = Array.isArray(knowledgeBase?.bosses)
    ? knowledgeBase.bosses
    : [];
  const bossesById = new Map(bosses.map((boss) => [String(boss.id), boss]));
  const bossesByApiId = new Map(
    bosses.map((boss) => [String(boss.apiId), boss]),
  );
  const resolveTarget = (condition) =>
    resolveBoss(condition, bossesById, bossesByApiId);
  const floors = (knowledgeBase?.floors || [])
    .map((floor) =>
      makeGroup(
        "floor",
        floor,
        bossKillConditions(floor),
        resolveTarget,
        floorCardFilename(floor.code),
      ),
    )
    .filter(Boolean);
  const departments = (knowledgeBase?.departments || [])
    .map((department) =>
      makeGroup(
        "department",
        department,
        bossKillConditions(department),
        resolveTarget,
        departmentCardFilename(department.code),
      ),
    )
    .filter(Boolean);
  return [...floors, ...departments];
}
