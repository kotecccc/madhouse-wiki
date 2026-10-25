import test from "node:test";
import assert from "node:assert/strict";
import { progressionTargets } from "../src/features/floors/progression-targets.js";

const fixture = {
  floors: [
    { id: "floor-J", code: "J" },
    {
      id: "floor-K",
      code: "K",
      openingConditions: [
        {
          type: "boss_kills",
          bossId: 8,
          required: 4,
          label: "Убить босса 4 раза",
        },
      ],
    },
  ],
  departments: [
    {
      id: "dept-J1",
      floorId: "floor-J",
      code: "J1",
      work: { id: "work:28", apiId: "28", title: "Блиндаж" },
    },
    {
      id: "dept-J2",
      floorId: "floor-J",
      code: "J2",
      openingConditions: [
        {
          type: "work_completions",
          targetDepartmentId: "dept-J1",
          required: 25,
          label: "Выполнить Блиндаж 25 раз",
        },
      ],
    },
  ],
  bosses: [{ id: "boss-8", apiId: "8", departmentId: "dept-J1", name: "Босс" }],
  businesses: [
    { id: "business:5", apiId: "5", departmentId: "dept-J1", title: "Бизнес" },
  ],
  availability: { J: true, K: false },
  departmentState: {
    code: "J",
    status: "ready",
    departments: [
      { blockCode: "J1", unlocked: true },
      { blockCode: "J2", unlocked: false },
    ],
  },
};

test("next locked department marks the actual work in its source department", () => {
  const [target] = progressionTargets(fixture);
  assert.equal(target.category, "work");
  assert.equal(target.entityId, "work:28");
  assert.equal(target.departmentId, "dept-J1");
  assert.equal(target.destination, "J2");
  assert.equal(target.label, "Выполнить Блиндаж 25 раз");
});

test("live IDs resolve all three categories and exclude confirmed completed requirements", () => {
  const targets = progressionTargets({
    ...fixture,
    departmentState: {
      ...fixture.departmentState,
      departments: [
        { blockCode: "J1", unlocked: true },
        {
          blockCode: "J2",
          unlocked: false,
          requirements: [
            {
              type: "work_completions",
              workId: 28,
              required: 25,
              label: "Оригинальный текст",
            },
            { type: "boss_kills", bossId: 8, required: 4 },
            { type: "business_level", businessId: 5, required: 6 },
            { type: "boss_kills", bossId: 8, required: 1, met: true },
            { type: "boss_kills", bossId: 999, label: "Босс" },
          ],
        },
      ],
    },
  });
  assert.deepEqual(
    targets.map((target) => target.category),
    ["work", "bosses", "businesses"],
  );
  assert.equal(targets[0].label, "Оригинальный текст");
});

test("next floor is targeted only after confirmed department access", () => {
  assert.deepEqual(progressionTargets({ ...fixture, departmentState: {} }), []);
  assert.deepEqual(
    progressionTargets({
      ...fixture,
      departmentState: { ...fixture.departmentState, code: "I" },
    }),
    [],
  );
  const targets = progressionTargets({
    ...fixture,
    departmentState: {
      ...fixture.departmentState,
      departments: fixture.departmentState.departments.map((entry) => ({
        ...entry,
        unlocked: true,
      })),
    },
  });
  assert.equal(targets[0].destination, "K");
  assert.equal(targets[0].entityId, "boss-8");
});

test("boss opening conditions preserve source wording and uncertainty notes", () => {
  const [target] = progressionTargets({
    ...fixture,
    departmentState: {
      ...fixture.departmentState,
      departments: [
        { blockCode: "J1", unlocked: true },
        {
          blockCode: "J2",
          unlocked: false,
          requirements: [
            {
              type: "boss_kills",
              bossId: 8,
              required: 5,
              label: "Убить босса 5 раз",
              note: "Условия неполные",
              verification: "Не проверено",
            },
          ],
        },
      ],
    },
  });
  assert.equal(target.destination, "J2");
  assert.equal(target.label, "Убить босса 5 раз");
  assert.equal(target.note, "Условия неполные");
  assert.equal(target.verification, "Не проверено");
});
