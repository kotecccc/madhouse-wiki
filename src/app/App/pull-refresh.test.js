import test from "node:test";
import assert from "node:assert/strict";
import { isPullReady } from "./pull-refresh.js";

test("pull refresh requires a deliberate downward gesture at the top", () => {
  const gesture = { startX: 40, startY: 20, x: 45, y: 120, scrollTop: 0 };
  assert.equal(isPullReady(gesture), true);
  assert.equal(isPullReady({ ...gesture, scrollTop: 1 }), false);
  assert.equal(isPullReady({ ...gesture, y: 90 }), false);
  assert.equal(isPullReady({ ...gesture, x: 200 }), false);
  assert.equal(isPullReady({ ...gesture, y: -100 }), false);
});
