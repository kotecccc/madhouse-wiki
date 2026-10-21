import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { validateTelegramInitData } from "../scripts/telegram/telegram-init-data.mjs";

const token = "123456:fake-test-token";
const now = new Date("2026-10-21T12:00:00.000Z");

function signedInitData(
  user = { id: 42, first_name: "Тест", username: "test_user" },
  authDate = Math.floor(now.getTime() / 1000),
) {
  const params = new URLSearchParams({
    auth_date: String(authDate),
    user: JSON.stringify(user),
    query_id: "AAE-test",
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

test("Telegram initData validates the signature and returns a strict identity projection", () => {
  const user = validateTelegramInitData(signedInitData(), token, {
    now: now.getTime(),
  });
  assert.deepEqual(user, {
    id: "42",
    username: "test_user",
    displayName: "Тест",
  });
});

test("Telegram initData rejects modified, duplicated, stale and malformed credentials", () => {
  const valid = signedInitData();
  assert.equal(
    validateTelegramInitData(valid.replace("test_user", "another"), token, {
      now: now.getTime(),
    }),
    null,
  );
  assert.equal(
    validateTelegramInitData(`${valid}&auth_date=1`, token, {
      now: now.getTime(),
    }),
    null,
  );
  assert.equal(
    validateTelegramInitData(signedInitData(undefined, 1), token, {
      now: now.getTime(),
    }),
    null,
  );
  assert.equal(
    validateTelegramInitData(signedInitData({ id: "42" }), token, {
      now: now.getTime(),
    }),
    null,
  );
  assert.equal(
    validateTelegramInitData("x".repeat(4097), token, { now: now.getTime() }),
    null,
  );
});
