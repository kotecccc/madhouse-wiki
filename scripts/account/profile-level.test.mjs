import test from "node:test";
import assert from "node:assert/strict";
import { createProfileLevelHandler } from "./profile-level.mjs";

test("level is read only for the verified account and is never cached", async () => {
  const handler = createProfileLevelHandler({
    identity: (token) => (token === "Bearer valid" ? { playerId: 41 } : null),
    readProgress: async (profile, token) => {
      assert.deepEqual(profile, { playerId: 41 });
      assert.equal(token, "Bearer valid");
      return { ...profile, exp: { level: 136 }, unrelated: "private" };
    },
  });
  const response = await handler(
    new Request("http://localhost/api/automation/profile-level", {
      headers: { Authorization: "Bearer valid" },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await response.json(), { playerId: 41, level: 136 });
  assert.equal(
    (
      await handler(
        new Request("http://localhost/api/automation/profile-level"),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await handler(
        new Request("http://localhost/api/automation/profile-level?id=42"),
      )
    ).status,
    403,
  );
});

test("missing current level reports failure without returning old data", async () => {
  const handler = createProfileLevelHandler({
    identity: () => ({ playerId: 41 }),
    readProgress: async (profile) => profile,
  });
  assert.equal(
    (
      await handler(
        new Request("http://localhost/api/automation/profile-level"),
      )
    ).status,
    503,
  );
});

test("accepts asynchronously verified bridge identity and rejects revoked sessions", async () => {
  let valid = true;
  const handler = createProfileLevelHandler({
    identity: async () => {
      if (!valid) throw new Error("revoked");
      return { playerId: 41 };
    },
    readProgress: async () => ({ exp: { level: 136 } }),
  });
  const request = () =>
    new Request("http://localhost/api/automation/profile-level", {
      headers: { Authorization: "Bearer bridge" },
    });
  assert.equal((await handler(request())).status, 200);
  valid = false;
  assert.equal((await handler(request())).status, 401);
});
