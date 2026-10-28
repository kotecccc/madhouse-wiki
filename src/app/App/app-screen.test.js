import test from "node:test";
import assert from "node:assert/strict";
import {
  pageFromPath,
  screenFromHash,
  screenFromLocation,
  screenUrl,
} from "./app-screen.js";

test("boss and work links identify a valid catalogue entity", () => {
  assert.deepEqual(pageFromPath("/boss/29"), { kind: "boss", id: 29 });
  assert.deepEqual(pageFromPath("/work/7"), { kind: "work", id: 7 });
  assert.deepEqual(pageFromPath("/battle/battle-123"), {
    kind: "battle",
    id: "battle-123",
  });
  for (const path of ["/", "/boss/0", "/work/foo", "/boss/1/extra"])
    assert.equal(pageFromPath(path), null);
});

test("queue uses a path and accepts old hash links", () => {
  assert.equal(screenFromLocation("/queue", ""), "queue");
  assert.equal(screenFromLocation("/queue/", ""), "queue");
  assert.equal(screenFromLocation("/", "#queue"), "queue");
  assert.equal(screenFromLocation("/boss/7", ""), "overview");
  assert.equal(screenUrl("queue", "?a=1"), "/queue?a=1");
  assert.equal(screenUrl("overview", "?a=1"), "/?a=1");
  assert.equal(screenUrl("raids", "?a=1"), "/?a=1#raids");
});

test("floors links and default routes resolve to the combined home screen", () => {
  for (const hash of ["", "#overview", "#floors", "#unknown"])
    assert.equal(screenFromHash(hash), "overview");
  assert.equal(screenFromHash("#raids"), "raids");
  assert.equal(screenFromHash("#inventory"), "inventory");
  assert.equal(screenFromHash("#queue"), "queue");
});
