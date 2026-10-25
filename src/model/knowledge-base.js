import { knowledgeBase as kb } from "virtual:madhouse-catalogue";
const indexById = (records) =>
  Object.fromEntries(records.map((record) => [record.id, record]));
export const floorById = indexById(kb.floors);
export const departmentById = indexById(kb.departments);
export const bossById = indexById(kb.bosses);
export const businessById = indexById(kb.businesses);
export const stashSetById = indexById(kb.stashSets || []);
const workById = indexById(kb.works);
export const getWorkById = (id) => workById[id] ?? null;
const businessUpgradeById = indexById(kb.businessUpgrades);
function mergeRecords(current, incoming, index) {
  for (const record of incoming || []) {
    if (!record?.id) continue;
    const existing = index[record.id];
    if (existing) Object.assign(existing, record);
    else {
      current.push(record);
      index[record.id] = record;
    }
  }
}
export function mergeKnowledgeBaseOverlay(overlay) {
  if (!overlay || overlay.schemaVersion !== kb.schemaVersion) return;
  mergeRecords(kb.floors, overlay.floors, floorById);
  mergeRecords(kb.departments, overlay.departments, departmentById);
  mergeRecords(kb.works, overlay.works, workById);
  mergeRecords(kb.bosses, overlay.bosses, bossById);
  mergeRecords(kb.businesses, overlay.businesses, businessById);
  mergeRecords(kb.stashSets, overlay.stashSets, stashSetById);
  mergeRecords(
    kb.businessUpgrades,
    overlay.businessUpgrades,
    businessUpgradeById,
  );
  for (const floor of kb.floors) {
    floor.departmentIds = [
      ...new Set([
        ...(floor.departmentIds || []),
        ...kb.departments
          .filter((department) => department.floorId === floor.id)
          .map((department) => department.id),
      ]),
    ];
  }
  orderedFloors.splice(
    0,
    orderedFloors.length,
    ...kb.floors.sort(
      (a, b) => floorOrder.indexOf(a.code) - floorOrder.indexOf(b.code),
    ),
  );
  calcFloors.splice(
    0,
    calcFloors.length,
    ...orderedFloors.filter((floor) =>
      floor.departmentIds.some(
        (id) => departmentById[id]?.energyCycle?.full != null,
      ),
    ),
  );
  bossFloors.splice(
    0,
    bossFloors.length,
    ...new Set(kb.bosses.map((boss) => getBossFloorCode(boss))),
  );
}
export function getRequirementDepartment(requirement) {
  if (requirement.targetDepartmentId)
    return departmentById[requirement.targetDepartmentId] || null;
  const departmentId =
    (requirement.targetBusinessId &&
      businessById[requirement.targetBusinessId]?.departmentId) ||
    (requirement.targetBossId &&
      bossById[requirement.targetBossId]?.departmentId);
  return departmentById[departmentId] || null;
}
const floorOrder = [..."ABCDEFGHIJKLMNO", "$"];
export const orderedFloors = [...kb.floors].sort(
  (a, b) => floorOrder.indexOf(a.code) - floorOrder.indexOf(b.code),
);
export const calcFloors = orderedFloors.filter((floor) =>
  floor.departmentIds.some(
    (id) => departmentById[id]?.energyCycle?.full != null,
  ),
);
export const bossFloors = [
  ...new Set(kb.bosses.map((boss) => getBossFloorCode(boss))),
];
export function getBossFloorCode(boss) {
  return (
    floorById[departmentById[boss.departmentId]?.floorId]?.code || "unknown"
  );
}
export function getDepartmentWorks(floor) {
  return (floor?.departmentIds || [])
    .map((id) => departmentById[id])
    .filter((department) => department?.energyCycle?.full != null);
}
export function getDepartmentBosses(departmentId) {
  return kb.bosses.filter((boss) => boss.departmentId === departmentId);
}
export function getDepartmentBusinesses(departmentId) {
  return kb.businesses.filter(
    (business) => business.departmentId === departmentId,
  );
}
export function getDepartmentUpgrades(departmentId) {
  return kb.businessUpgrades.filter(
    (upgrade) => upgrade.departmentId === departmentId,
  );
}
export function getBusinessUpgrade(businessId) {
  return (
    kb.businessUpgrades.find((upgrade) => upgrade.businessId === businessId) ??
    null
  );
}
export function getBossGroups(floorCode) {
  const groups = {};
  for (const boss of kb.bosses.filter(
    (boss) => getBossFloorCode(boss) === floorCode,
  )) {
    const department = departmentById[boss.departmentId];
    const label = department
      ? department.code + (department.name ? " • " + department.name : "")
      : "Отделение не указано";
    (groups[label] ||= []).push(boss);
  }
  return groups;
}
