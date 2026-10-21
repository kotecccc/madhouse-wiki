import { createRaidBlobStore } from "./raid-blob-store.mjs";
import {
  parseRaidChannelPost,
  raidSourceChannelUsername,
} from "./raid-schedule-parser.mjs";
import { createRaidSessionStore } from "./raid-session-store.mjs";
import { createRaidSyncLock } from "./raid-sync-lock.mjs";
import { createRaidTelegramClient } from "./raid-mtproto-client.mjs";

const HISTORY_LIMIT = 500;

export function createRaidSynchronizer({
  createClient = createRaidTelegramClient,
  sessions = createRaidSessionStore(),
  schedules = createRaidBlobStore(),
  lockStore = createRaidSyncLock(),
  now = () => new Date(),
} = {}) {
  return async function synchronizeRaids() {
    const lock = await lockStore.acquire(now().getTime());
    if (!lock) return { status: "already_running", imported: 0, removed: 0 };

    let client;
    try {
      const session = await sessions.read();
      client = await createClient();
      const user = await client.start({ session });
      if (user.isBot) throw new Error("raid_telegram_user_required");

      const channel = await client.getChat(`@${raidSourceChannelUsername()}`);
      if (
        channel.chatType !== "channel" ||
        channel.username?.toLocaleLowerCase("en-US") !==
          raidSourceChannelUsername().toLocaleLowerCase("en-US")
      )
        throw new Error("raid_source_channel_mismatch");

      const history = [];
      const seenIds = [];
      const seenIdSet = new Set();
      const parsedIds = new Set();
      const parsedSchedules = [];
      let fetchedMessageCount = 0;
      for await (const message of client.iterHistory(channel.inputPeer, {
        limit: HISTORY_LIMIT,
      })) {
        fetchedMessageCount += 1;
        if (!message.isChannelPost || message.chat?.id !== channel.id) continue;
        const messageId = String(message.id);
        history.push(message);
        seenIds.push(messageId);
        seenIdSet.add(messageId);
        const schedule = parseRaidChannelPost(message);
        if (schedule) {
          parsedIds.add(messageId);
          parsedSchedules.push(schedule);
        }
      }
      await schedules.saveMany(parsedSchedules);

      const currentSchedules = await schedules.readRecent(180);
      let removed = 0;
      const removals = [];
      for (const schedule of currentSchedules) {
        if (!seenIdSet.has(schedule.sourceMessageId)) continue;
        if (parsedIds.has(schedule.sourceMessageId)) continue;
        const message = history.find(
          (item) => String(item.id) === schedule.sourceMessageId,
        );
        const removedAt =
          message?.editDate?.toISOString() ||
          message?.date?.toISOString() ||
          now().toISOString();
        removals.push({ sourceMessageId: schedule.sourceMessageId, removedAt });
      }
      removed += await schedules.removeMany(removals);

      const oldestFetchedId = history.reduce(
        (oldest, message) => Math.min(oldest, message.id),
        Number.POSITIVE_INFINITY,
      );
      if (Number.isFinite(oldestFetchedId)) {
        const minimumMessageId =
          fetchedMessageCount < HISTORY_LIMIT ? 0 : oldestFetchedId;
        removed += await schedules.removeMissing(
          seenIds,
          minimumMessageId,
          now().toISOString(),
        );
      }

      return {
        status: "synced",
        imported: parsedIds.size,
        removed,
        scanned: history.length,
        syncedAt: now().toISOString(),
      };
    } finally {
      try {
        await client?.destroy();
      } finally {
        await lock.release();
      }
    }
  };
}

export const synchronizeRaids = createRaidSynchronizer();
