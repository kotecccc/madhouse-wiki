import test from "node:test";
import assert from "node:assert/strict";
import { planFloorProgress } from "../scripts/automation/floor-plan.mjs";

const fixture = {
  floors: [
    { code: "A", isAvailable: true },
    { code: "B", isAvailable: false },
  ],
  info: {
    departments: [
      { blockCode: "A1", unlocked: true },
      {
        blockCode: "A2",
        unlocked: false,
        requirements: [
          { type: "work_completions", workId: 3, required: 5, current: 2 },
        ],
      },
    ],
  },
  catalogue: {
    floors: [
      { id: "a", code: "A" },
      { id: "b", code: "B" },
    ],
    departments: [
      {
        id: "a1",
        floorId: "a",
        code: "A1",
        work: { id: "work:3", apiId: "3" },
      },
      { id: "a2", floorId: "a", code: "A2" },
    ],
    bosses: [{ id: "boss:4", apiId: "4" }],
    businesses: [{ id: "business:5", apiId: "5" }],
  },
};
test("uses only confirmed live progress for the next department", () => {
  assert.deepEqual(planFloorProgress(fixture), {
    status: "ready",
    destination: "A2",
    kind: "work",
    entityId: "work:3",
    apiId: 3,
    current: 2,
    required: 5,
  });
});
test("stops for missing counts or unknown conditions", () => {
  for (const requirement of [
    { type: "boss_kills", bossId: 4, required: 2 },
    { type: "unknown", current: 0, required: 1 },
  ]) {
    const input = structuredClone(fixture);
    input.info.departments[1].requirements = [requirement];
    assert.equal(planFloorProgress(input).status, "waiting");
  }
});
test("does not skip an unknown access state", () => {
  const input = structuredClone(fixture);
  input.info.departments.pop();
  assert.equal(planFloorProgress(input).status, "waiting");
});

test("an unknown condition does not prevent another confirmed target", () => {
  const input = structuredClone(fixture);
  input.info.departments[1].requirements.unshift({
    type: "player_level",
    current: 1,
    required: 2,
    met: false,
  });
  assert.equal(planFloorProgress(input).kind, "work");
  input.info.departments[1].requirements[1].met = true;
  assert.equal(planFloorProgress(input).status, "waiting");
});

test("resolves boss and business targets against their API IDs", () => {
  for (const [type, key, id, kind] of [
    ["boss_kills", "bossId", 4, "boss"],
    ["business_level", "businessId", 5, "business"],
  ]) {
    const input = structuredClone(fixture);
    input.info.departments[1].requirements = [
      { type, [key]: id, current: 1, required: 3 },
    ];
    assert.equal(planFloorProgress(input).kind, kind);
  }
});

test("uses the next floor's live conditions after all departments are open", () => {
  const input = structuredClone(fixture);
  input.info.departments[1].unlocked = true;
  input.floors[1].unlockRequirements = [
    { type: "boss_kills", bossId: 4, current: 1, required: 3 },
  ];
  assert.equal(planFloorProgress(input).destination, "B");
  assert.equal(planFloorProgress(input).kind, "boss");
});

test("long work goals are split into bounded batches without changing the final condition", () => {
  const input = structuredClone(fixture);
  input.info.departments[1].requirements[0].required = 2005;
  const target = planFloorProgress(input);
  assert.equal(target.current, 2);
  assert.equal(target.required, 1002);
});
