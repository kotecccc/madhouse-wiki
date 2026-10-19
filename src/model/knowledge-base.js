import { knowledgeBase as kb } from "../../data/index.js";
const indexById = (records) =>
  Object.fromEntries(records.map((record) => [record.id, record]));
export const floorById = indexById(kb.floors);
export const departmentById = indexById(kb.departments);
export const bossById = indexById(kb.bosses);
export const businessById = indexById(kb.businesses);
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
export function getBossGroups(floorCode) {
  const groups = {};
  for (const boss of kb.bosses.filter(
    (boss) => getBossFloorCode(boss) === floorCode,
  )) {
    const department = departmentById[boss.departmentId];
    const label = department
      ? department.code + (department.name ? " · " + department.name : "")
      : "Отделение не указано";
    (groups[label] ||= []).push(boss);
  }
  return groups;
}
