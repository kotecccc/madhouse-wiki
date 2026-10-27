import test from "node:test";
import assert from "node:assert/strict";
import { createActionQueue } from "./action-queue.mjs";
import { queuedBusinessRunAdapter } from "./queued-business-run.mjs";

test("restart after saving the business run does not start another run", async () => {
  let starts = 0;
  const entry = {
    businessHelper: {
      run: { status: "running", queueId: "queued-business-1" },
    },
    collector: {
      start: () => {
        starts++;
      },
    },
  };
  const queue = createActionQueue({
    saved: [
      {
        id: "queued-business-1",
        type: "business.start",
        args: { businessId: "business:7" },
        status: "running",
        priority: 15,
        createdAt: 0,
        attempts: 0,
      },
    ],
    adapters: {
      "business.start": queuedBusinessRunAdapter({
        entry,
        getCatalogue: () => ({}),
      }),
    },
    now: () => 1000,
    persist: () => true,
  });
  await queue.tick();
  assert.equal(queue.snapshot()[0].status, "completed");
  assert.equal(starts, 0);
});
