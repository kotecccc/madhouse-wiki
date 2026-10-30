import assert from "node:assert/strict";
import test from "node:test";
import { createAccountSnapshots } from "../scripts/account/snapshots.mjs";
import { createAccountDataService } from "../scripts/account/data-service.mjs";
import { createSessionApi } from "../shared/session-api.js";

test("a strict client read after a server mutation cannot join the earlier read", async () => {
  const rows = new Map();
  const store = {
    readSnapshots: () => [...rows.values()],
    writeSnapshot: (id, value) => rows.set(String(id), structuredClone(value)),
    list: () => [],
  };
  const authorization = "Bearer race-test";
  let release;
  let reads = 0;
  const snapshots = createAccountSnapshots({
    store,
    fetcher: async () => {
      const number = ++reads;
      if (number === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return Response.json({ revision: number });
    },
  });
  snapshots.saveBridgeProfile(authorization, { playerId: 42 });
  const data = createAccountDataService({ transport: snapshots, snapshots });
  const api = createSessionApi({
    authorize: (request) => ({
      ...request,
      headers: { Authorization: authorization },
    }),
    fetcher: (path, options) =>
      data.fetch(`https://cargohustle.online${path}`, options),
  });
  const before = api.get("/api/me/bag", { fresh: true, serverRefresh: "live" });
  await new Promise((resolve) => setImmediate(resolve));
  const ticket = snapshots.beginMutation(
    authorization,
    "POST",
    "/api/shop/buy",
  );
  assert.equal(snapshots.commitMutationBarrier(ticket), true);
  const after = api.get("/api/me/bag", { fresh: true, serverRefresh: "live" });
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const [first, second] = await Promise.allSettled([before, after]);
  assert.equal(first.status, "rejected");
  assert.equal(second.status, "fulfilled");
  assert.deepEqual(second.value, { revision: 2 });
  assert.equal(reads, 2);
  api.clear();
});
