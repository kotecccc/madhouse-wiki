import test from "node:test";
import assert from "node:assert/strict";
import { departmentAccess } from "../src/features/floors/useDepartmentAvailability.js";

test("department access uses only explicit block availability and discards personal progress", () => {
  assert.deepEqual(
    departmentAccess({
      departments: [
        {
          blockCode: "A1",
          unlocked: true,
          requirements: [{ current: 1, met: true }],
        },
        { blockCode: "A2", unlocked: false },
        { blockCode: "A3", unlocked: null },
        { blockCode: "A4", unlocked: "false" },
      ],
    }),
    { A1: true, A2: false },
  );
  assert.deepEqual(departmentAccess({ error: "unavailable" }), {});
});
