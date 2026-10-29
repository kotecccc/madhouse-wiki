import assert from "node:assert/strict";
import test from "node:test";

import {
  startStoredStatePolling,
  storedQueuePresence,
} from "./stored-state-polling.js";

test("a malformed present payload is unavailable rather than an empty queue", async () => {
  const outcomes = [];
  const poller = startStoredStatePolling({
    readStored: async () => ({ presence: "present", data: {} }),
    onPresent: () => outcomes.push("present"),
    onMissing: () => outcomes.push("missing"),
    onUnavailable: () => outcomes.push("unavailable"),
  });
  await Promise.resolve();
  assert.deepEqual(outcomes, ["unavailable"]);
  poller.stop();
});

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        timer.callback();
        await Promise.resolve();
        await Promise.resolve();
      }
      now = end;
    },
  };
}

test("missing stored queue keeps explicit presence and polls locally until present", async () => {
  const clock = fakeClock();
  const reads = [];
  const presence = [];
  const responses = [
    { presence: "unknown", snapshotStatus: "missing" },
    Object.assign(new Error("missing"), { status: 404 }),
    {
      presence: "present",
      data: { queuedActions: [{ id: "work-1", status: "running" }] },
    },
  ];
  const stop = startStoredStatePolling({
    readStored: async () => {
      reads.push(reads.length + 1);
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    onMissing: (result) => presence.push(storedQueuePresence(result)),
    onPresent: (data) => presence.push(data.queuedActions[0].status),
    onUnavailable: () => presence.push("unavailable"),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(presence, ["missing"]);
  assert.equal(reads.length, 1);

  await clock.advance(14999);
  assert.equal(reads.length, 1);
  await clock.advance(1);
  assert.deepEqual(presence, ["missing", "missing"]);
  assert.equal(reads.length, 2);

  await clock.advance(15000);
  assert.deepEqual(presence, ["missing", "missing", "running"]);
  assert.equal(reads.length, 3);

  stop.stop();
  await clock.advance(60000);
  assert.equal(reads.length, 3, "unmount stops the bounded stored-state poll");
});

test("a stored-state error reports unavailable until data exists, then preserves it", async () => {
  const clock = fakeClock();
  const values = [
    Object.assign(new Error("offline"), { status: 503 }),
    { presence: "present", data: { queuedActions: [], version: 3 } },
    Object.assign(new Error("offline again"), { status: 503 }),
    { presence: "unknown", snapshotStatus: "missing" },
  ];
  let state = null;
  let presence = "unknown";
  const stop = startStoredStatePolling({
    readStored: async () => {
      const value = values.shift();
      if (value instanceof Error) throw value;
      return value;
    },
    onPresent(data) {
      state = data;
      presence = "present";
    },
    onMissing(result) {
      if (!state) presence = storedQueuePresence(result);
    },
    onUnavailable() {
      if (!state) presence = "unavailable";
    },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(presence, "unavailable");
  assert.equal(state, null);

  await clock.advance(15000);
  const knownState = state;
  assert.equal(presence, "present");
  assert.equal(knownState.version, 3);
  await clock.advance(15000);
  assert.equal(state, knownState);
  assert.equal(presence, "present");
  await clock.advance(15000);
  assert.equal(state, knownState, "a missing result cannot hide saved data");
  assert.equal(presence, "present");
  stop.stop();
});

test("strict readStored missing envelope maps to missing queue presence", () => {
  assert.equal(
    storedQueuePresence({ presence: "unknown", snapshotStatus: "missing" }),
    "missing",
  );
});

test("clearing the session invalidates an in-flight stored-state response", async () => {
  const clock = fakeClock();
  let resolveRead;
  let reads = 0;
  const shown = [];
  const poller = startStoredStatePolling({
    readStored: () => {
      reads += 1;
      if (reads === 1)
        return new Promise((resolve) => {
          resolveRead = resolve;
        });
      return Promise.resolve({
        presence: "unknown",
        snapshotStatus: "missing",
      });
    },
    onPresent: (data) => shown.push(data),
    onMissing: () => shown.push("missing"),
    onUnavailable: () => shown.push("unavailable"),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });

  poller.invalidate();
  resolveRead({ presence: "present", data: { queuedActions: [] } });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(shown, []);

  await clock.advance(15000);
  assert.deepEqual(shown, ["missing"]);
  poller.stop();
});
