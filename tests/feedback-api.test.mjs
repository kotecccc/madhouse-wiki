import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { createFeedbackApi } from "../scripts/telegram/feedback-api.mjs";

const token = "123456:fake-test-token";
const now = new Date("2026-10-21T12:00:00.000Z");
const user = { id: 42, first_name: "Тест", username: "test_user" };

function signedInitData() {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(now.getTime() / 1000)),
    user: JSON.stringify(user),
  });
  const check = [...params.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(token).digest();
  params.set("hash", createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

function setup({ adminTelegramId = "98765" } = {}) {
  const calls = [];
  const api = createFeedbackApi({
    botToken: token,
    adminTelegramId,
    wikiOrigin: "https://wiki.example",
    now: () => now,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true, result: {} });
    },
  });
  const post = (body) =>
    api(
      new Request("https://wiki.example/api/feedback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
  return { api, calls, post };
}

test("feedback sends text to the configured private Telegram chat and returns only a receipt", async () => {
  const { calls, post } = setup();
  const response = await post({
    initData: signedInitData(),
    message: "Ошибка на этаже A",
    screen: "floors",
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.match(result.feedbackId, /^FB-261021-[A-F0-9]{6}$/u);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendMessage$/u);
  const message = JSON.parse(calls[0].options.body);
  assert.equal(message.chat_id, "98765");
  assert.match(message.text, /Telegram ID 42/u);
  assert.match(message.text, /Ошибка на этаже A/u);
  assert.doesNotMatch(JSON.stringify(result), /fake-test-token|test_user/u);
});

test("feedback sends a validated screenshot as multipart without persisting it", async () => {
  const { calls, post } = setup();
  const screenshot = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01]);
  const response = await post({
    initData: signedInitData(),
    message: "Проблема",
    screenshot: {
      base64: screenshot.toString("base64"),
      mimeType: "image/jpeg",
    },
    screen: "raids",
  });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /sendPhoto$/u);
  const form = calls[0].options.body;
  assert.equal(form.get("chat_id"), "98765");
  assert.match(form.get("caption"), /Раздел: raids/u);
  assert.equal(form.get("photo").type, "image/jpeg");
});

test("feedback refuses unverified sessions, oversized images and excess submissions", async () => {
  const { calls, post } = setup();
  assert.equal((await post({ message: "Без сессии" })).status, 401);
  assert.equal(
    (
      await post({
        initData: signedInitData(),
        message: "",
        screenshot: { mimeType: "image/jpeg", base64: "YQ==" },
      })
    ).status,
    400,
  );
  for (let index = 0; index < 3; index += 1)
    assert.equal(
      (await post({ initData: signedInitData(), message: "Обращение" })).status,
      200,
    );
  assert.equal(
    (await post({ initData: signedInitData(), message: "Лимит" })).status,
    429,
  );
  assert.equal(calls.length, 3);
});

test("feedback rejects a missing server recipient and wrong HTTP methods", async () => {
  const { api } = setup({ adminTelegramId: "" });
  assert.equal(
    (
      await api(
        new Request("https://wiki.example/api/feedback", {
          method: "POST",
          body: "{}",
        }),
      )
    ).status,
    503,
  );
  const valid = setup();
  assert.equal(
    (await valid.api(new Request("https://wiki.example/api/feedback"))).status,
    405,
  );
});
