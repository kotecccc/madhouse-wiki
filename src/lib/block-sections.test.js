import test from "node:test";
import assert from "node:assert/strict";
import { normalizeBlockSections } from "./block-sections.js";

test("block sections retain chosen order and reject unknown and duplicate sections", () => {
  assert.deepEqual(
    normalizeBlockSections(["bosses", "works", "bosses", "other"], true),
    ["bosses", "works", "requirements", "businesses"],
  );
  assert.deepEqual(normalizeBlockSections(["bosses", "other"]), ["bosses"]);
});
