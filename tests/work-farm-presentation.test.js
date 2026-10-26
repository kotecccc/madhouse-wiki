import test from "node:test";
import assert from "node:assert/strict";
import {
  previewWorkTasks,
  workFarmProgress,
} from "../src/features/works/WorkFarm/work-farm-presentation.js";
const task = (id, energyCost, required, progress = 0, canPerform = true) => ({
  id,
  title: `Task ${id}`,
  energyCost,
  required,
  progress,
  canPerform,
});
const view = {
  workId: 7,
  completedCycles: 25,
  energy: { current: 27, max: 360 },
  tasks: [task(1, 8, 4, 1), task(2, 3, 1)],
};

test("MAX previews affordable tasks in runner order, including partial cycles and no refills", () => {
  assert.deepEqual(
    previewWorkTasks(view, { mode: "energy", energyBudget: 27 }),
    {
      items: [
        { id: 1, title: "Task 1", count: 3, energy: 24 },
        { id: 2, title: "Task 2", count: 1, energy: 3 },
      ],
      energy: 27,
    },
  );
  const cheaperFirst = { ...view, tasks: [task(1, 3, 2), task(2, 8, 2)] };
  assert.deepEqual(
    previewWorkTasks(cheaperFirst, {
      mode: "energy",
      energyBudget: 14,
    }).items.map((t) => [t.id, t.count]),
    [
      [1, 2],
      [2, 1],
    ],
  );
  assert.equal(
    previewWorkTasks(view, { mode: "energy", energyBudget: 100 }).energy,
    27,
    "live energy caps the projection",
  );
});

test("projection resets only complete cycles, skips unavailable MAX tasks and respects action caps", () => {
  const repeated = { ...view, tasks: [task(1, 2, 1), task(2, 3, 1)] };
  assert.equal(
    previewWorkTasks(repeated, { mode: "energy", energyBudget: 12 }).energy,
    12,
  );
  assert.deepEqual(
    previewWorkTasks(repeated, {
      mode: "energy",
      energyBudget: 12,
      maxActions: 2,
    }).items.map((t) => t.count),
    [1, 1],
  );
  const locked = { ...view, tasks: [task(1, 8, 4, 1, false), task(2, 3, 1)] };
  assert.deepEqual(
    previewWorkTasks(locked, { mode: "energy", energyBudget: 27 }).items.map(
      (t) => t.id,
    ),
    [2],
  );
});

test("count targets show remaining real tasks, not historical cycles or unknown next-cycle data", () => {
  const result = previewWorkTasks(view, { mode: "wait", targetCycles: 27 });
  assert.deepEqual(
    result.items.map((t) => [t.id, t.count]),
    [
      [1, 7],
      [2, 2],
    ],
  );
  assert.equal(result.energy, 62);
  assert.deepEqual(
    previewWorkTasks(view, { mode: "wait", targetCycles: 25 }).items,
    [],
  );
  assert.equal(previewWorkTasks(null, { mode: "energy" }), null);
  assert.equal(
    previewWorkTasks(view, { mode: "energy", energyBudget: null }),
    null,
  );
  assert.equal(
    previewWorkTasks(
      { ...view, tasks: [task(1, 3, 1, 1)] },
      { mode: "wait", targetCycles: 26 },
    ),
    null,
  );
});

test("dock progress excludes historical completions and includes partial task progress", () => {
  const run = {
    workId: 7,
    completedCycles: 25,
    targetCycles: 26,
    config: { mode: "wait" },
    energySpent: 9,
  };
  assert.deepEqual(workFarmProgress(run, view), {
    value: 9,
    max: 36,
    percent: 25,
  });
  assert.equal(workFarmProgress({ ...run, energySpent: 0 }, view).percent, 0);
  assert.equal(workFarmProgress(run, { ...view, workId: 8 }).percent, null);
  assert.deepEqual(
    workFarmProgress(
      { ...run, config: { mode: "energy" }, energyBudget: 27, energySpent: 16 },
      view,
    ),
    { value: 16, max: 27, percent: 59 },
  );
  assert.equal(
    workFarmProgress(
      { ...run, config: { mode: "energy" }, energyBudget: null },
      view,
    ).percent,
    null,
  );
});
