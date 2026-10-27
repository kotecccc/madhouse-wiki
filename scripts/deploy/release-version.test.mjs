import { test } from "node:test";
import assert from "node:assert/strict";
import { validateReleaseVersion } from "./release-version.mjs";

const manifest = { version: "1.2.0" };
const lock = { version: "1.2.0", packages: { "": { version: "1.2.0" } } };
const changelog = [
  { version: "1.2.0", date: "2026-10-27", changes: ["New feature"] },
];
test("release metadata must agree and increase numerically", () => {
  assert.equal(
    validateReleaseVersion(manifest, lock, changelog, "1.1.99"),
    "1.2.0",
  );
  assert.throws(() =>
    validateReleaseVersion(manifest, lock, changelog, "1.2.0"),
  );
  assert.throws(() =>
    validateReleaseVersion(manifest, lock, changelog, "2.0.0"),
  );
  assert.throws(() =>
    validateReleaseVersion(manifest, { ...lock, version: "1.1.0" }, changelog),
  );
  assert.throws(() =>
    validateReleaseVersion(manifest, lock, [{ ...changelog[0], changes: [] }]),
  );
});
