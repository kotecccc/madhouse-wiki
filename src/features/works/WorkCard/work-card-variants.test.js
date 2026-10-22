import test from "node:test";
import assert from "node:assert/strict";
import {
  getWorkCardVariantProps,
  workCardVariants,
} from "./work-card-variants.js";

test("work-main keeps desktop and mobile settings in one named variant", () => {
  assert.deepEqual(getWorkCardVariantProps("work-main"), {
    descriptionFields: ["stash"],
    descriptionSize: "xs",
  });
  assert.deepEqual(getWorkCardVariantProps("work-main", true), {
    descriptionFields: ["stash"],
    descriptionSize: "2xs",
    titleSize: "sm",
    buttonSize: "md",
  });
  assert.equal(getWorkCardVariantProps("unknown"), undefined);
  assert.notEqual(
    getWorkCardVariantProps("work-main").descriptionFields,
    workCardVariants["work-main"].desktop.descriptionFields,
  );
});
