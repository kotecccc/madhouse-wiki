import assert from "node:assert/strict";
import test from "node:test";
import { createRequestPriorityContext } from "../automation/request-priority-context.mjs";
import { createDirectBoundary } from "./direct-boundary.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

for (const route of ["direct", "bridge"]) {
  test(`${route} boundary carries active request urgency into the shared scheduler`, async () => {
    const context = createRequestPriorityContext();
    const firstGate = deferred();
    const calls = [];
    const boundary = createDirectBoundary({
      env: {
        MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
        MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
        MADHOUSE_GAME_DIRECT_CONCURRENCY: "1",
      },
      fetcher: async (_url, init) => {
        calls.push(init.label);
        if (init.label === "hold") await firstGate.promise;
        return Response.json({ ok: true });
      },
    });
    const issue = (label) =>
      route === "direct"
        ? boundary.request(
            "https://cargohustle.online/api/me/bag",
            {
              label,
              headers: { Authorization: "Bearer synthetic" },
            },
            "automation",
          )
        : boundary.bridge({
            authorization: "Bearer synthetic",
            playerId: 17,
            deviceId: "fake-device",
            method: "GET",
            kind: "read",
            execute: async () => {
              calls.push(label);
              if (label === "hold") await firstGate.promise;
              return { status: 200 };
            },
          });
    try {
      const hold = context.run({ priority: 1 }, false, () => issue("hold"));
      await flush();
      const ordinary = context.run({ priority: 10 }, false, () =>
        issue("ordinary"),
      );
      const urgent = context.run({ priority: 60 }, true, () => issue("urgent"));
      firstGate.resolve();
      await Promise.all([hold, ordinary, urgent]);
      assert.deepEqual(calls, ["hold", "urgent", "ordinary"]);
    } finally {
      boundary.close();
    }
  });
}

test("a boundary request inherited past its attempt uses source fallback", async () => {
  const context = createRequestPriorityContext();
  const calls = [];
  const boundary = createDirectBoundary({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
      MADHOUSE_GAME_DIRECT_CONCURRENCY: "1",
    },
    fetcher: async (_url, init) => {
      calls.push(init.label);
      return Response.json({ ok: true });
    },
  });
  let release;
  let inherited;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  try {
    await context.run({ priority: 60 }, true, async () => {
      inherited = (async () => {
        await gate;
        return boundary.request(
          "https://cargohustle.online/api/me/bag",
          {
            label: "background",
            headers: { Authorization: "Bearer synthetic" },
          },
          "catalogue",
        );
      })();
    });
    release();
    await inherited;
    assert.deepEqual(calls, ["background"]);
  } finally {
    boundary.close();
  }
});
