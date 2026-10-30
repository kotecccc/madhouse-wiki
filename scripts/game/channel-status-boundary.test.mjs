import { test } from "node:test";
import assert from "node:assert/strict";
import { createDirectBoundary } from "./direct-boundary.mjs";

test("observes physical direct and bridge responses without changing their result", async () => {
  const seen = [];
  const boundary = createDirectBoundary({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
      MADHOUSE_GAME_DEVICE_INTERVAL_MS: "1",
    },
    fetcher: async () => new Response("error", { status: 500 }),
    onPhysicalResponse: (path, status) => {
      seen.push([path, status]);
      throw new Error("observer failure");
    },
  });
  try {
    const result = await boundary.request(
      "https://cargohustle.online/api/bosses/1",
      {},
    );
    assert.equal(result.status, 500);
    const bridged = await boundary.bridge({
      deviceId: "device",
      method: "GET",
      path: "/api/combat?x=1",
      execute: async () => ({ status: 200, body: Buffer.from("{}") }),
    });
    assert.equal(bridged.status, 200);
    assert.deepEqual(seen, [
      ["/api/bosses/1", 500],
      ["/api/combat", 200],
    ]);
  } finally {
    boundary.close();
  }
});

test("network failures and undelivered bridge calls never fabricate observations", async () => {
  const seen = [];
  const boundary = createDirectBoundary({
    env: {
      MADHOUSE_GAME_GLOBAL_INTERVAL_MS: "1",
      MADHOUSE_GAME_ACCOUNT_INTERVAL_MS: "1",
      MADHOUSE_GAME_DEVICE_INTERVAL_MS: "1",
    },
    fetcher: async () => {
      throw new TypeError("offline");
    },
    onPhysicalResponse: (...event) => seen.push(event),
  });
  try {
    await assert.rejects(
      boundary.request("https://cargohustle.online/api/bosses/1"),
      /offline/,
    );
    await assert.rejects(
      boundary.bridge({
        deviceId: "device",
        method: "GET",
        path: "/api/me",
        execute: async () => {
          throw new Error("bridge_offline");
        },
      }),
      /bridge_offline/,
    );
    assert.deepEqual(seen, []);
  } finally {
    boundary.close();
  }
});
