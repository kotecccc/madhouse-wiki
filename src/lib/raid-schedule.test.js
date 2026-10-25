import assert from "node:assert/strict";
import test from "node:test";
import { getRaidStatus, getRaidStatusMarker } from "./raid-schedule.js";

test("raid status comes from the source marker, not the scheduled time", () => {
  assert.equal(getRaidStatus({ zone: "A1", time: "10:00" }), "unknown");
  assert.equal(getRaidStatus({ zone: "▶️ A1", time: "10:00" }), "active");
  assert.equal(getRaidStatus({ zone: "✅ A1", time: "10:00" }), "completed");
});

test("completed archive marker is preserved as source data", () => {
  const archivedRaid = { zone: "✅ A1", archived: true };
  assert.equal(getRaidStatusMarker(archivedRaid), "✅");
  assert.equal(getRaidStatus(archivedRaid), "completed");
});
