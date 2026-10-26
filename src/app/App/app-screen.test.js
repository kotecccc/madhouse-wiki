import test from "node:test";
import assert from "node:assert/strict";
import { screenFromHash } from "./app-screen.js";

test("floors links and default routes resolve to the combined home screen", () => {
  for (const hash of ["", "#overview", "#floors", "#unknown"])
    assert.equal(screenFromHash(hash), "overview");
  assert.equal(screenFromHash("#raids"), "raids");
  assert.equal(screenFromHash("#inventory"), "inventory");
});
