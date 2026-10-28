import test from "node:test";
import assert from "node:assert/strict";
import { workFarmCardState } from "../src/features/works/WorkCard/work-farm-card-state.js";

test("only the running work is animated", () => {
  const input = { run: { status: "running", workId: 12 }, workId: 12 };
  assert.deepEqual(workFarmCardState(input), { active: true, test: false });
  assert.equal(workFarmCardState({ ...input, workId: 13 }).active, false);
  for (const status of ["paused", "completed", "stopped"]) {
    assert.equal(
      workFarmCardState({ ...input, run: { ...input.run, status } }).active,
      false,
    );
  }
});

test("preview selects one department only in development", () => {
  const input = { departmentCode: "D1", preview: "D1" };
  assert.deepEqual(workFarmCardState({ ...input, dev: true }), {
    active: true,
    test: true,
  });
  assert.deepEqual(workFarmCardState({ ...input, dev: false }), {
    active: false,
    test: false,
  });
  assert.equal(
    workFarmCardState({ ...input, departmentCode: "D2", dev: true }).active,
    false,
  );
});
