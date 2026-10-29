import assert from "node:assert/strict";
import { test } from "node:test";
import { createWikiBotApi } from "../scripts/telegram/wiki-bot.mjs";

function harness({ device = null, bridgeReporter = null } = {}) {
  const calls = [];
  let current = device;
  const bridgeDevices = {
    list(owner) {
      assert.equal(owner, "123");
      return current;
    },
    async status() {
      return "online";
    },
    invite() {
      return { invitation: "A".repeat(43), expiresAt: Date.now() + 300000 };
    },
    revoke(owner, id) {
      assert.equal(owner, "123");
      assert.equal(id, current.deviceId);
      current = null;
    },
  };
  const handler = createWikiBotApi({
    token: "fake",
    webhookSecret: "secret",
    knowledgeBase: { floors: [], departments: [] },
    wikiOrigin: "https://wiki.example",
    bridgeDevices,
    bridgeReporter,
    bridgeBootstrapSha256: "a".repeat(64),
    fetchImpl: async (url, init) => {
      calls.push({
        method: new URL(url).pathname.split("/").at(-1),
        body: JSON.parse(init.body),
      });
      return Response.json({ ok: true, result: { message_id: 99 } });
    },
  });
  async function callback(
    data,
    { chatId = 123, sender = 123, type = "private", photo = false } = {},
  ) {
    return handler(
      new Request("https://wiki.example/api/telegram/bot-webhook", {
        method: "POST",
        headers: { "x-telegram-bot-api-secret-token": "secret" },
        body: JSON.stringify({
          callback_query: {
            id: "callback",
            data,
            from: { id: sender },
            message: {
              message_id: 42,
              chat: { id: chatId, type },
              ...(photo ? { photo: [{ file_id: "fake" }] } : {}),
            },
          },
        }),
      }),
    );
  }
  return { calls, callback };
}

test("private Mac setup provides a download and a single-use key", async () => {
  const h = harness();
  assert.equal((await h.callback("bridge:mac")).status, 200);
  const msg = h.calls.find((call) => call.method === "editMessageText").body;
  assert.match(msg.text, /Мост на Mac/);
  assert.equal(
    msg.reply_markup.inline_keyboard[0][0].url,
    "https://wiki.example/bridge/MadhouseWikiBridge-macOS.zip",
  );
  assert.equal(
    msg.reply_markup.inline_keyboard[1][0].copy_text.text,
    "A".repeat(43),
  );
});

test("private Windows setup provides the portable archive and single-use key", async () => {
  const h = harness();
  await h.callback("bridge:windows");
  const msg = h.calls.find((call) => call.method === "editMessageText").body;
  assert.match(msg.text, /Мост на Windows/);
  assert.equal(
    msg.reply_markup.inline_keyboard[0][0].url,
    "https://wiki.example/bridge/MadhouseWikiBridge-Windows.zip",
  );
  assert.equal(
    msg.reply_markup.inline_keyboard[1][0].copy_text.text,
    "A".repeat(43),
  );
});

test("bridge secrets never go to group chats or a different sender", async () => {
  const h = harness();
  await h.callback("bridge:mac", { type: "group" });
  await h.callback("bridge:mac", { sender: 124 });
  await h.callback("bridge:android", { type: "group" });
  await h.callback("bridge:android", { sender: 124 });
  await h.callback("bridge:windows", { type: "group" });
  assert.equal(
    h.calls.some((call) => call.method === "editMessageText"),
    false,
  );
});

test("existing device cannot be replaced by old or unrelated callback", async () => {
  const h = harness({
    device: { deviceId: "11111111-1111-4111-8111-111111111111" },
  });
  await h.callback("bridge:mac");
  assert.match(h.calls.at(-1).body.text, /Уже привязано/);
  await h.callback("bridge:disconnect:old");
  assert.match(h.calls.at(-1).body.text, /уже изменилось/i);
  await h.callback("bridge:disconnect:11111111-1111-4111-8111-111111111111");
  assert.match(h.calls.at(-1).body.text, /отключено/i);
});

test("iPhone setup includes the pinned installer command", async () => {
  const h = harness();
  await h.callback("bridge:iphone");
  assert.match(h.calls.at(-1).body.text, /iSH/);
  assert.match(h.calls.at(-1).body.text, /a{64}/);
});

test("Android setup uses Termux and a pinned one-use installer", async () => {
  const h = harness();
  await h.callback("bridge:menu");
  assert.ok(
    h.calls
      .at(-1)
      .body.reply_markup.inline_keyboard.some((row) =>
        row.some((button) => button.callback_data === "bridge:android"),
      ),
  );
  await h.callback("bridge:android");
  const text = h.calls.at(-1).body.text;
  assert.match(text, /Termux/);
  assert.match(text, /pkg install -y/);
  assert.match(text, /--force-confold/);
  assert.match(text, /a{64}/);
});

test("private bridge check and notification controls use the verified owner", async () => {
  const actions = [];
  const h = harness({
    device: { deviceId: "11111111-1111-4111-8111-111111111111" },
    bridgeReporter: async (owner, action) => {
      actions.push([owner, action]);
      return true;
    },
  });
  await h.callback("bridge:check");
  await h.callback("bridge:report-off");
  await h.callback("bridge:report");
  await h.callback("bridge:report", { sender: 124 });
  assert.deepEqual(actions, [
    ["123", "auto"],
    ["123", "disable"],
    ["123", "enable"],
  ]);
});

test("the bot refuses bridge requests without the webhook secret", async () => {
  let touched = false;
  const handler = createWikiBotApi({
    token: "fake",
    webhookSecret: "secret",
    knowledgeBase: {},
    wikiOrigin: "https://wiki.example",
    bridgeDevices: {
      list: () => {
        touched = true;
      },
    },
  });
  const response = await handler(
    new Request("https://wiki.example/api/telegram/bot-webhook", {
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "wrong" },
      body: JSON.stringify({
        callback_query: {
          id: "x",
          data: "bridge:mac",
          from: { id: 123 },
          message: { chat: { id: 123, type: "private" } },
        },
      }),
    }),
  );
  assert.equal(response.status, 403);
  assert.equal(touched, false);
});

test("menu navigation edits text and replaces a photo only after the replacement is sent", async () => {
  const h = harness();
  await h.callback("menu:floors");
  assert.equal(h.calls.at(-1).method, "editMessageText");
  assert.equal(h.calls.at(-1).body.message_id, 42);
  h.calls.length = 0;
  await h.callback("menu:floors", { photo: true });
  assert.deepEqual(
    h.calls.map((call) => call.method),
    ["answerCallbackQuery", "sendMessage", "deleteMessage"],
  );
  assert.equal(h.calls.at(-1).body.message_id, 42);
});
