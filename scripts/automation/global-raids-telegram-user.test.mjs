import test from "node:test";
import assert from "node:assert/strict";
import { Long } from "@mtcute/core";
import { createGlobalRaidsTelegramUser } from "./global-raids-telegram-user.mjs";

function harness({ premium = true, result, error } = {}) {
  const calls = [];
  let destroyed = 0;
  const client = {
    start: async () => ({ isPremium: premium, isBot: false }),
    resolvePeer: async () => ({ _: "inputPeerChannel" }),
    call: async (request, options) => {
      calls.push({ request, options });
      if (error) throw error;
      return (
        result ?? {
          updates: [
            { _: "updateMessageID", id: 123, randomId: Long.fromString("17") },
          ],
        }
      );
    },
    destroy: async () => {
      destroyed++;
    },
  };
  const sender = createGlobalRaidsTelegramUser({
    sessions: { read: async () => "private-session" },
    createClient: async () => client,
    randomId: () => Long.fromString("17"),
  });
  return {
    sender,
    calls,
    get destroyed() {
      return destroyed;
    },
  };
}
const payload = {
  chat_id: "@channel",
  rich_message: {
    html: '<p><tg-emoji emoji-id="5819095256267755019">⏺</tg-emoji></p>',
  },
};

test("sends rich messages with a unique ID and disables MTProto mutation retries", async () => {
  const h = harness();
  assert.deepEqual(await h.sender.request("sendRichMessage", payload), {
    message_id: 123,
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request._, "messages.sendMessage");
  assert.equal(h.calls[0].request.richMessage.html, payload.rich_message.html);
  assert.equal(h.calls[0].options.maxRetryCount, 0);
  assert.equal(h.calls[0].options.floodSleepThreshold, 0);
  assert.equal(h.destroyed, 1);
});

test("edits the existing channel post and treats unchanged content as success", async () => {
  const h = harness({ error: new Error("MESSAGE_NOT_MODIFIED") });
  assert.equal(
    await h.sender.request("editMessageText", { ...payload, message_id: 5 }),
    true,
  );
  assert.equal(h.calls[0].request._, "messages.editMessage");
  assert.equal(h.calls[0].request.id, 5);
  assert.equal(h.destroyed, 1);
});

test("rejects non-premium accounts before dispatch", async () => {
  const h = harness({ premium: false });
  await assert.rejects(
    h.sender.request("sendRichMessage", payload),
    (e) => e.notDispatched === true,
  );
  assert.equal(h.calls.length, 0);
  assert.equal(h.destroyed, 1);
});

test("unknown send failures remain uncertain and flood waits are known rejections", async () => {
  let h = harness({ error: new Error("connection lost") });
  await assert.rejects(
    h.sender.request("sendRichMessage", payload),
    (e) => !e.notDispatched && !e.knownRejected,
  );
  assert.equal(h.calls.length, 1);
  h = harness({ error: new Error("FLOOD_WAIT_45") });
  await assert.rejects(
    h.sender.request("sendRichMessage", payload),
    (e) => e.knownRejected === true && e.retryAfterMs === 45000,
  );
  assert.equal(h.calls.length, 1);
});

test("does not accept a message ID associated with a different random ID", async () => {
  const h = harness({
    result: {
      updates: [
        { _: "updateMessageID", id: 999, randomId: Long.fromString("18") },
      ],
    },
  });
  await assert.rejects(
    h.sender.request("sendRichMessage", payload),
    /global_raid_message_id_missing/,
  );
  assert.equal(h.calls.length, 1);
});

test("raid worker publishes animated status via the premium sender and keeps the returned message ID", async () => {
  const { createGlobalRaidsWorker } = await import("./global-raids-worker.mjs");
  const h = harness();
  const time = Date.parse("2026-10-29T12:00:00Z");
  let state = {
    schema: 2,
    day: "2026-10-29",
    observations: {},
    raids: [
      {
        key: "1:7",
        carried: true,
        carriedIds: [],
        base: {
          key: "1:7",
          bossId: 7,
          leaderPlayerId: 1,
          count: 10,
          lastBattleAt: time,
          sources: {},
        },
      },
    ],
    messageId: null,
    pendingSend: false,
    nextPublishAt: 0,
  };
  const worker = createGlobalRaidsWorker({
    store: {
      readGlobalRaids: () => structuredClone(state),
      writeGlobalRaids: (v) => {
        state = structuredClone(v);
      },
    },
    owner: "worker",
    now: () => time,
    telegram: h.sender,
    chatId: "@channel",
    getBoss: () => ({ name: "Босс" }),
    isClosed: () => false,
    customEmoji: true,
  });
  await worker.tick();
  assert.equal(state.messageId, 123);
  assert.equal(state.pendingSend, false);
  assert.match(
    h.calls[0].request.richMessage.html,
    /emoji-id="5819095256267755019"/,
  );
});
