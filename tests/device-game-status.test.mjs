import assert from "node:assert/strict";
import test from "node:test";
import { createDeviceGameStatusReader } from "../scripts/bridge/game-status.mjs";

const ownerId = "54321";
const playerId = "12345";
const deviceId = "00000000-0000-4000-8000-000000000401";
const session = {
  ownerId,
  playerId,
  authorization: "Bearer synthetic.token.signature",
  credentialVersion: 2,
  routeEpoch: 9,
  routePolicy: "bridge_required",
};
const route = {
  policy: "bridge_required",
  activeDeviceId: deviceId,
  routeEpoch: 9,
};
function fixture({
  resolve = async () => session,
  verify = async () =>
    Response.json({ playerId: Number(playerId), telegramId: Number(ownerId) }),
  readRoute = () => route,
  restore = () => false,
} = {}) {
  let reads = 0;
  const status = createDeviceGameStatusReader({
    store: { isRestoreRequired: restore, readRoutePolicy: readRoute },
    resolveVerifiedOwnerSession: resolve,
    snapshots: {
      registerVerifiedCredential(auth, id) {
        assert.equal(auth, session.authorization);
        assert.equal(id, playerId);
      },
      async verifyIdentity(auth) {
        reads++;
        assert.equal(auth, session.authorization);
        return verify();
      },
    },
  });
  return {
    status: () => status({ ownerId, deviceId, routeEpoch: 9 }),
    get reads() {
      return reads;
    },
  };
}

test("device status requires a fresh matching game identity and route", async () => {
  const valid = fixture();
  assert.equal(await valid.status(), "ready");
  assert.equal(valid.reads, 1);
  const wrong = fixture({
    verify: async () =>
      Response.json({ playerId: 999, telegramId: Number(ownerId) }),
  });
  assert.equal(await wrong.status(), "unknown");
  const unavailable = fixture({
    verify: async () => new Response(null, { status: 503 }),
  });
  assert.equal(await unavailable.status(), "unknown");
  const expired = fixture({
    verify: async () => new Response(null, { status: 401 }),
  });
  assert.equal(await expired.status(), "auth_required");
});

test("device status fails closed for restore, wrong route and changed credentials", async () => {
  const restoring = fixture({ restore: () => true });
  assert.equal(await restoring.status(), "paused");
  assert.equal(restoring.reads, 0);
  const wrongRoute = fixture({
    readRoute: () => ({ ...route, activeDeviceId: "other" }),
  });
  assert.equal(await wrongRoute.status(), "unknown");
  assert.equal(wrongRoute.reads, 0);
  let reads = 0;
  const changed = fixture({
    resolve: async () =>
      ++reads === 1 ? session : { ...session, credentialVersion: 3 },
  });
  assert.equal(await changed.status(), "unknown");
  let routeReads = 0;
  const changedRoute = fixture({
    readRoute: () =>
      ++routeReads === 1 ? route : { ...route, routeEpoch: 10 },
  });
  assert.equal(await changedRoute.status(), "unknown");
  const missing = fixture({
    resolve: async () => {
      throw Object.assign(new Error("game_session_required"), {
        code: "game_session_required",
      });
    },
  });
  assert.equal(await missing.status(), "auth_required");
});
