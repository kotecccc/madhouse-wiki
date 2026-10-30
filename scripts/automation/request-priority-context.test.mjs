import test from "node:test";
import assert from "node:assert/strict";
import {
  createRequestPriorityContext,
  currentRequestPriority,
} from "./request-priority-context.mjs";

test("request urgency ends with its queue attempt, including inherited tasks", async () => {
  const context = createRequestPriorityContext();
  let release;
  let inherited;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await context.run({ priority: 15 }, true, async () => {
    assert.equal(context.current(), 60);
    inherited = (async () => {
      await gate;
      return context.current();
    })();
  });
  assert.equal(context.current(), null);
  release();
  assert.equal(await inherited, null);
});

test("direct-boundary priority lookup shares the active server context only", async () => {
  const context = createRequestPriorityContext();
  let release;
  let inherited;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await context.run({ priority: 17 }, false, async () => {
    assert.equal(currentRequestPriority(), 17);
    inherited = (async () => {
      await gate;
      return currentRequestPriority();
    })();
  });
  release();
  assert.equal(await inherited, null);
});

test("concurrent accounts retain independent request priorities", async () => {
  const context = createRequestPriorityContext();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = context.run({ priority: 15 }, true, async () => {
    await gate;
    return context.current();
  });
  const second = context.run({ priority: 30 }, false, async () => {
    await gate;
    return context.current();
  });
  release();
  assert.deepEqual(await Promise.all([first, second]), [60, 30]);
});

test("only an active attempt can report a proven unsent mutation", async () => {
  const context = createRequestPriorityContext();
  const result = await context.run({ priority: 1 }, false, async () => {
    context.noteUnsentMutation();
    return { status: "retry" };
  });
  assert.deepEqual(result, { status: "retry", unsentMutation: true });
  context.noteUnsentMutation();
  assert.deepEqual(
    await context.run({ priority: 1 }, false, async () => ({
      status: "retry",
    })),
    { status: "retry" },
  );
});
