import assert from "node:assert/strict";
import { knowledgeBase } from "../data/index.js";

const fail = (message) => assert.fail(message);
const collections = {
  floors: knowledgeBase.floors,
  departments: knowledgeBase.departments,
  bosses: knowledgeBase.bosses,
  businesses: knowledgeBase.businesses,
  businessUpgrades: knowledgeBase.businessUpgrades,
};
const ids = Object.fromEntries(
  Object.entries(collections).map(([name, records]) => {
    assert(Array.isArray(records), `${name} must be an array`);
    const set = new Set();
    for (const [index, record] of records.entries()) {
      assert(
        record && typeof record.id === "string" && record.id.length > 0,
        `${name}[${index}] needs a stable string id`,
      );
      if (set.has(record.id)) fail(`${name} has duplicate id ${record.id}`);
      set.add(record.id);
    }
    return [name, set];
  }),
);

const requireReference = (collection, id, context) => {
  assert(
    typeof id === "string" && ids[collection].has(id),
    `${context} references missing ${collection} id ${String(id)}`,
  );
};

for (const floor of knowledgeBase.floors) {
  assert(
    Array.isArray(floor.departmentIds),
    `floor ${floor.id} must have departmentIds`,
  );
  for (const departmentId of floor.departmentIds) {
    requireReference("departments", departmentId, `floor ${floor.id}`);
    const department = knowledgeBase.departments.find(
      ({ id }) => id === departmentId,
    );
    assert.equal(
      department.floorId,
      floor.id,
      `floor ${floor.id} lists ${departmentId}, but its floorId is ${department.floorId}`,
    );
  }
}
for (const department of knowledgeBase.departments) {
  requireReference("floors", department.floorId, `department ${department.id}`);
  assert(
    knowledgeBase.floors
      .find(({ id }) => id === department.floorId)
      .departmentIds.includes(department.id),
    `department ${department.id} is missing from floor ${department.floorId}'s departmentIds`,
  );
}
for (const boss of knowledgeBase.bosses) {
  // Some bosses are intentionally unassigned because the source does not identify their department.
  if (boss.departmentId === null) continue;
  requireReference("departments", boss.departmentId, `boss ${boss.id}`);
}
for (const business of knowledgeBase.businesses)
  requireReference(
    "departments",
    business.departmentId,
    `business ${business.id}`,
  );
for (const upgrade of knowledgeBase.businessUpgrades)
  requireReference(
    "departments",
    upgrade.departmentId,
    `business upgrade ${upgrade.id}`,
  );

const requirementTargets = {
  work_completions: ["targetDepartmentId", "departments"],
  boss_kills: ["targetBossId", "bosses"],
  business_level: ["targetBusinessId", "businesses"],
};
const standaloneRequirementTypes = new Set([
  "player_level", "combat_rating", "rage_total", "dice_level", "stash_medallion", "department_open",
]);
for (const floor of knowledgeBase.floors) {
  for (const [index, condition] of (floor.openingConditions ?? []).entries()) {
    const context = `floor ${floor.id} openingConditions[${index}]`;
    assert(condition && typeof condition.type === "string", `${context} needs a type`);
    const target = requirementTargets[condition.type];
    if (target && condition[target[0]] != null)
      requireReference(target[1], condition[target[0]], context);
    if (condition.targetDepartmentId)
      requireReference("departments", condition.targetDepartmentId, context);
    else if (!target || condition[target[0]] == null)
      assert(standaloneRequirementTypes.has(condition.type), `${context} has unsupported requirement type ${condition.type}`);
  }
}
for (const department of knowledgeBase.departments) {
  for (const [index, condition] of (
    department.openingConditions ?? []
  ).entries()) {
    const context = `department ${department.id} openingConditions[${index}]`;
    assert(
      condition && typeof condition.type === "string",
      `${context} needs a type`,
    );
    if (condition.type === "player_level") continue;
    const target = requirementTargets[condition.type];
    assert(
      target,
      `${context} has unsupported requirement type ${condition.type}`,
    );
    const [field, collection] = target;
    if (
      condition[field] === null &&
      condition.type === "boss_kills" &&
      typeof condition.unresolvedTarget === "string" &&
      condition.unresolvedTarget.length > 0
    )
      continue;
    requireReference(collection, condition[field], context);
  }
}

console.log(
  `Validated ${knowledgeBase.floors.length} floors, ${knowledgeBase.departments.length} departments, ${knowledgeBase.bosses.length} bosses, ${knowledgeBase.businesses.length} businesses, and ${knowledgeBase.businessUpgrades.length} business upgrades.`,
);

for (const upgrade of knowledgeBase.businessUpgrades) {
  if (upgrade.businessId == null) continue;
  requireReference("businesses", upgrade.businessId, `upgrade ${upgrade.id}`);
  const business = knowledgeBase.businesses.find(
    (record) => record.id === upgrade.businessId,
  );
  assert.equal(
    business.departmentId,
    upgrade.departmentId,
    `upgrade ${upgrade.id} must belong to its business department`,
  );
}
