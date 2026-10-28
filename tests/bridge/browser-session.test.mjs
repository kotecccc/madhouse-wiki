import assert from "node:assert/strict";
import { test } from "node:test";
import { createBridgeBrowserSessions } from "../../scripts/bridge/browser-session.mjs";

test("bridge browser session is signed, scoped and expires", () => {
  let now = 1_000_000;
  const sessions = createBridgeBrowserSessions({
    key: Buffer.alloc(32, 9),
    now: () => now,
  });
  const token = sessions.issue("101", 3);
  assert.deepEqual(sessions.verify(token), { owner: "101", revision: 3 });
  assert.equal(
    sessions.verify(token.replace(/.$/, token.endsWith("A") ? "B" : "A")),
    null,
  );
  assert.equal(
    createBridgeBrowserSessions({
      key: Buffer.alloc(32, 8),
      now: () => now,
    }).verify(token),
    null,
  );
  now += 900_000;
  assert.equal(sessions.verify(token), null);
});
