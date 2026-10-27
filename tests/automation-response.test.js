import test from "node:test";
import assert from "node:assert/strict";
import { readAutomationResponse } from "../src/features/bosses/BossBattle/automation-response.js";

test("HTML from an unavailable service produces a user-facing error", async () => {
  const response = new Response("<html>Bad gateway</html>", { status: 502 });
  await assert.rejects(readAutomationResponse(response), (error) => {
    assert.equal(error.status, 502);
    assert.equal(
      error.message,
      "Сервис боя временно недоступен. Попробуйте позже.",
    );
    return true;
  });
});

test("valid JSON remains available to the caller", async () => {
  assert.deepEqual(
    await readAutomationResponse(Response.json({ version: 2 })),
    { version: 2 },
  );
});
