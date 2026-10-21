import { createRaidBlobStore } from "./raid-blob-store.mjs";
import { raidSourceChannelUsername } from "./raid-schedule-parser.mjs";
import { createRaidSessionStore } from "./raid-session-store.mjs";
import { createRaidSyncLock } from "./raid-sync-lock.mjs";
import { reconcileRaidHistory } from "./raid-history-sync.mjs";
import { createRaidTelegramClient } from "./raid-mtproto-client.mjs";

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
      await lock.assertActive(now().getTime());
      const session = await sessions.read();
      await lock.assertActive(now().getTime());
      client = await createClient();
      const user = await client.start({ session });
      await lock.assertActive(now().getTime());
      if (user.isBot) throw new Error("raid_telegram_user_required");

      const channel = await client.getChat(`@${raidSourceChannelUsername()}`);
      if (
        channel.chatType !== "channel" ||
        channel.username?.toLocaleLowerCase("en-US") !==
          raidSourceChannelUsername().toLocaleLowerCase("en-US")
      )
        throw new Error("raid_source_channel_mismatch");

      const result = await reconcileRaidHistory({
        client,
        channel,
        schedules,
        now,
        assertLease: () => lock.assertActive(now().getTime()),
      });

      return {
        status: "synced",
        ...result,
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
