import { randomBytes } from "node:crypto";
import { Long } from "@mtcute/core";
import { createRaidSessionStore } from "../telegram/raid-session-store.mjs";
import { createRaidTelegramClient } from "../telegram/raid-mtproto-client.mjs";

const CALL_OPTIONS = {
  timeout: 15000,
  maxRetryCount: 0,
  floodSleepThreshold: 0,
};
const waitFor = (promise) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("global_raid_telegram_timeout")),
        15000,
      );
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
};

// Each send is protected by the caller's durable pendingSend checkpoint.
// Never fall back to the bot: Bot API strips channel custom emoji silently.
export function createGlobalRaidsTelegramUser({
  sessions = createRaidSessionStore(),
  createClient = createRaidTelegramClient,
  randomId = () =>
    Long.fromString(
      (
        BigInt(`0x${randomBytes(8).toString("hex")}`) & ((1n << 63n) - 1n) || 1n
      ).toString(),
    ),
} = {}) {
  return {
    async request(method, payload) {
      if (
        !["sendRichMessage", "editMessageText", "pinChatMessage"].includes(
          method,
        ) ||
        (method !== "pinChatMessage" && !payload?.rich_message?.html) ||
        typeof payload.chat_id !== "string"
      )
        throw new TypeError("global_raid_telegram_request_invalid");
      let client;
      let dispatched = false;
      try {
        const session = await waitFor(sessions.read());
        client = await createClient({ disableUpdates: true });
        const me = await waitFor(client.start({ session }));
        if (me.isBot || !me.isPremium)
          throw new Error("global_raid_premium_account_unavailable");
        const target = /^-\d+$/.test(payload.chat_id)
          ? Number(payload.chat_id)
          : payload.chat_id;
        if (typeof target === "number" && !Number.isSafeInteger(target))
          throw new TypeError("global_raid_channel_id_invalid");
        const peer = await waitFor(client.resolvePeer(target));
        if (peer?._ !== "inputPeerChannel")
          throw new Error("global_raid_channel_required");
        if (method === "pinChatMessage") {
          if (
            !Number.isSafeInteger(payload.message_id) ||
            payload.message_id <= 0
          )
            throw new TypeError("global_raid_message_id_invalid");
          const channel = {
            _: "inputChannel",
            channelId: peer.channelId,
            accessHash: peer.accessHash,
          };
          const full = await waitFor(
            client.call(
              { _: "channels.getFullChannel", channel },
              CALL_OPTIONS,
            ),
          );
          if (full?.fullChat?._ !== "channelFull")
            throw new Error("global_raid_pin_state_unavailable");
          if (full.fullChat.pinnedMsgId !== payload.message_id) {
            dispatched = true;
            await waitFor(
              client.call(
                {
                  _: "messages.updatePinnedMessage",
                  peer,
                  id: payload.message_id,
                  silent: true,
                },
                CALL_OPTIONS,
              ),
            );
          }
          return true;
        }
        const richMessage = {
          _: "inputRichMessageHTML",
          html: payload.rich_message.html,
        };
        if (method === "editMessageText") {
          if (
            !Number.isSafeInteger(payload.message_id) ||
            payload.message_id <= 0
          )
            throw new TypeError("global_raid_message_id_invalid");
          try {
            dispatched = true;
            await client.call(
              {
                _: "messages.editMessage",
                peer,
                id: payload.message_id,
                richMessage,
              },
              CALL_OPTIONS,
            );
          } catch (error) {
            if (!String(error?.message || "").includes("MESSAGE_NOT_MODIFIED"))
              throw error;
          }
          return true;
        }
        const idempotencyId = randomId();
        dispatched = true;
        const result = await client.call(
          {
            _: "messages.sendMessage",
            peer,
            message: "",
            randomId: idempotencyId,
            richMessage,
          },
          CALL_OPTIONS,
        );
        const update = result?.updates?.find(
          (item) =>
            item?._ === "updateMessageID" &&
            item.randomId?.toString() === idempotencyId.toString(),
        );
        const id = update?.id ?? result?.id;
        if (!Number.isSafeInteger(id) || id <= 0)
          throw new Error("global_raid_message_id_missing");
        return { message_id: id };
      } catch (error) {
        const failure =
          error instanceof Error
            ? error
            : new Error("global_raid_telegram_unavailable");
        if (!dispatched) failure.notDispatched = true;
        const match = /FLOOD_WAIT_(\d+)/.exec(String(failure.message || ""));
        if (match) {
          failure.retryAfterMs = Number(match[1]) * 1000;
          failure.knownRejected = true;
        }
        throw failure;
      } finally {
        if (client) await waitFor(client.destroy()).catch(() => {});
      }
    },
  };
}
