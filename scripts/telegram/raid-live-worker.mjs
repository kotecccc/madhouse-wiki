import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createRaidBlobStore } from "./raid-blob-store.mjs";
import { reconcileRaidHistory } from "./raid-history-sync.mjs";
import { createRaidSyncLock } from "./raid-sync-lock.mjs";
import { createRaidTelegramClient } from "./raid-mtproto-client.mjs";
import {
  parseRaidChannelPost,
  raidSourceChannelUsername,
} from "./raid-schedule-parser.mjs";
import { createRaidSessionStore } from "./raid-session-store.mjs";

const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const LOCK_OPERATION_TIMEOUT_MS = 15 * 1000;
const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;
const SHUTDOWN_TIMEOUT_MS = 5 * 1000;

function withTimeout(promise, timeoutMs, errorCode) {
  let timer;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(errorCode)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function toIso(value) {
  if (value == null) return new Date().toISOString();
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime())
    ? date.toISOString()
    : new Date().toISOString();
}

function isRaidSourceChannel(channel) {
  return (
    channel?.chatType === "channel" &&
    channel.username?.toLocaleLowerCase("en-US") ===
      raidSourceChannelUsername().toLocaleLowerCase("en-US")
  );
}

export async function runRaidLiveWorker({
  sessions = createRaidSessionStore(),
  schedules,
  lockStore,
  createClient = createRaidTelegramClient,
} = {}) {
  const scheduleAbort = new AbortController();
  const lockAbort = new AbortController();
  const raidSchedules =
    schedules || createRaidBlobStore({ abortSignal: scheduleAbort.signal });
  const raidLockStore =
    lockStore || createRaidSyncLock({ abortSignal: lockAbort.signal });
  const lease = await raidLockStore.acquire();
  if (!lease) throw new Error("raid_sync_already_running");

  let client;
  let heartbeat;
  let reconciliationTimer;
  let heartbeatBusy = false;
  let heartbeatTask = Promise.resolve();
  let lockLost = false;
  let stopping = false;
  let acceptUpdates = false;
  let updateQueue = Promise.resolve();
  const bufferedUpdates = [];
  const signalHandlers = new Map();
  let resolveShutdown;

  const stop = new Promise((resolveStop) => {
    resolveShutdown = resolveStop;
  });

  function requestStop({ leaseLost = false } = {}) {
    if (leaseLost && !lockLost) {
      lockLost = true;
      console.error("raids_worker_lock_lost");
      process.exitCode = 1;
      lockAbort.abort();
    }
    stopping = true;
    acceptUpdates = false;
    bufferedUpdates.length = 0;
    scheduleAbort.abort();
    clearInterval(heartbeat);
    clearInterval(reconciliationTimer);
    resolveShutdown();
  }

  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (!lockLost) process.exitCode = 0;
      requestStop();
    };
    signalHandlers.set(signal, handler);
    process.once(signal, handler);
  }

  heartbeat = setInterval(() => {
    if (heartbeatBusy || stopping || lockLost) return;
    heartbeatBusy = true;
    heartbeatTask = withTimeout(
      lease.renew(),
      LOCK_OPERATION_TIMEOUT_MS,
      "raid_sync_lock_renew_timeout",
    )
      .catch(() => {
        requestStop({ leaseLost: true });
      })
      .finally(() => {
        heartbeatBusy = false;
      });
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();

  const assertLease = async () => {
    if (lockLost) throw new Error("raid_sync_lock_lost");
    if (stopping) throw new Error("raid_live_worker_stopping");
    try {
      await lease.assertActive();
    } catch {
      requestStop({ leaseLost: true });
      throw new Error("raid_sync_lock_lost");
    }
  };

  const queueUpdate = (operation, kind) => {
    if (!acceptUpdates) {
      if (!stopping && !lockLost) bufferedUpdates.push({ operation, kind });
      return;
    }
    updateQueue = updateQueue
      .then(async () => {
        await assertLease();
        await operation(assertLease);
        await assertLease();
      })
      .catch((error) => {
        if (error?.message === "raid_sync_lock_lost") {
          requestStop({ leaseLost: true });
          return;
        }
        if (!stopping && !lockLost)
          console.error(`raids_worker_${kind}_failed`);
      });
  };

  const processMessage = (channel, message) => {
    if (!message?.isChannelPost || message.chat?.id !== channel.id) return;
    const sourceMessageId = String(message.id);
    queueUpdate(async (checkLease) => {
      const post = parseRaidChannelPost(message);
      if (post) {
        await checkLease();
        await raidSchedules.save(post);
        return;
      }
      await checkLease();
      const existing = (await raidSchedules.readRecent(180)).some(
        (item) => item.sourceMessageId === sourceMessageId,
      );
      if (existing) {
        await checkLease();
        await raidSchedules.remove(
          sourceMessageId,
          toIso(message.editDate || message.date),
        );
      }
    }, "message");
  };

  const processDelete = (channel, update) => {
    if (update?.channelId !== channel.id) return;
    for (const messageId of update.messageIds || []) {
      const sourceMessageId = String(messageId);
      queueUpdate(async (checkLease) => {
        await checkLease();
        const existing = (await raidSchedules.readRecent(180)).some(
          (item) => item.sourceMessageId === sourceMessageId,
        );
        if (existing) {
          await checkLease();
          await raidSchedules.remove(sourceMessageId);
        }
      }, "delete");
    }
  };

  try {
    await assertLease();
    const session = await sessions.read();
    await assertLease();
    client = await createClient({
      disableUpdates: false,
      updates: { catchUp: false },
    });
    const user = await client.start({ session });
    await assertLease();
    if (user.isBot) throw new Error("raid_telegram_user_required");

    const channel = await client.getChat(`@${raidSourceChannelUsername()}`);
    await assertLease();
    if (!isRaidSourceChannel(channel))
      throw new Error("raid_source_channel_mismatch");

    client.onNewMessage.add((message) => processMessage(channel, message));
    client.onEditMessage.add((message) => processMessage(channel, message));
    client.onDeleteMessage.add((update) => processDelete(channel, update));
    await client.openChat(channel.inputPeer);
    await assertLease();

    await reconcileRaidHistory({
      client,
      channel,
      schedules: raidSchedules,
      assertLease,
    });
    await assertLease();
    acceptUpdates = true;
    for (const update of bufferedUpdates.splice(0))
      queueUpdate(update.operation, update.kind);

    reconciliationTimer = setInterval(() => {
      queueUpdate(
        (checkLease) =>
          reconcileRaidHistory({
            client,
            channel,
            schedules: raidSchedules,
            assertLease: checkLease,
          }),
        "reconcile",
      );
    }, RECONCILE_INTERVAL_MS);
    reconciliationTimer.unref?.();

    console.info("raids_worker_ready");
    await stop;
  } finally {
    stopping = true;
    acceptUpdates = false;
    bufferedUpdates.length = 0;
    scheduleAbort.abort();
    clearInterval(heartbeat);
    clearInterval(reconciliationTimer);
    for (const [signal, handler] of signalHandlers)
      process.removeListener(signal, handler);
    await heartbeatTask;
    try {
      await withTimeout(
        client?.closeChat(`@${raidSourceChannelUsername()}`),
        SHUTDOWN_TIMEOUT_MS,
        "raid_telegram_close_timeout",
      );
    } catch {
      // Keep shutdown moving if Telegram is already disconnected.
    }
    try {
      await withTimeout(
        client?.destroy(),
        SHUTDOWN_TIMEOUT_MS,
        "raid_telegram_destroy_timeout",
      );
    } catch {
      // The process exits after dropping the connection.
    }

    if (!lockLost) {
      try {
        await withTimeout(
          updateQueue,
          SHUTDOWN_TIMEOUT_MS,
          "raid_worker_queue_shutdown_timeout",
        );
      } catch {
        lockLost = true;
        process.exitCode = 1;
      }
    }

    if (lockLost) {
      lockAbort.abort();
    } else {
      try {
        await withTimeout(
          lease.release(),
          SHUTDOWN_TIMEOUT_MS,
          "raid_sync_lock_release_timeout",
        );
      } catch {
        // The lease expires automatically if release is unavailable.
      }
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runRaidLiveWorker().catch(() => {
    if (process.exitCode === 0) return;
    console.error("raids_worker_start_failed");
    process.exitCode = 1;
  });
}
