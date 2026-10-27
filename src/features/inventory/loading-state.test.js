import test from "node:test";
import assert from "node:assert/strict";
import { inventoryHeaderLoading, inventoryLoading } from "./loading-state.js";

test("header follows current category requests and stops for completion, failure and inactive screen", () => {
  const tattoo = ["zone-1", "zone-2", "zone-3"];
  const clothing = ["clothing"];
  const header = (active, paths, state) =>
    inventoryHeaderLoading(active, inventoryLoading(paths, state));
  let state = { clothing: "ready" };
  assert.equal(header(true, tattoo, state), true);
  state = {
    ...state,
    "zone-1": "ready",
    "zone-2": "loading",
    "zone-3": "pending",
  };
  assert.equal(header(true, tattoo, state), true);
  assert.equal(header(false, tattoo, state), false);
  assert.equal(header(true, clothing, state), false);
  state = { ...state, "zone-2": "ready", "zone-3": "error" };
  assert.equal(header(true, tattoo, state), false);
  assert.equal(header(true, [], state), false);
});
