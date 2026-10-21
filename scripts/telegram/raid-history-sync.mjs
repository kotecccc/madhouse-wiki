import { parseRaidChannelPost } from "./raid-schedule-parser.mjs";

const HISTORY_LIMIT = 500;

function timestamp(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export async function reconcileRaidHistory({
  client,
  channel,
  schedules,
  now = () => new Date(),
  historyLimit = HISTORY_LIMIT,
  assertLease = async () => {},
}) {
  const history = new Map();
  const seenIds = [];
  const seenIdSet = new Set();
  const parsedIds = new Set();
  const parsedSchedules = [];
  let fetchedMessageCount = 0;

  for await (const message of client.iterHistory(channel.inputPeer, {
    limit: historyLimit,
  })) {
    fetchedMessageCount += 1;
    if (fetchedMessageCount % 25 === 1) await assertLease();
    if (!message.isChannelPost || message.chat?.id !== channel.id) continue;
    const messageId = String(message.id);
    history.set(messageId, message);
    seenIds.push(messageId);
    seenIdSet.add(messageId);
    const schedule = parseRaidChannelPost(message);
    if (schedule) {
      parsedIds.add(messageId);
      parsedSchedules.push(schedule);
    }
  }

  await assertLease();
  await schedules.saveMany(parsedSchedules);

  await assertLease();
  const currentSchedules = await schedules.readRecent(180);
  const removals = [];
  for (const schedule of currentSchedules) {
    if (!seenIdSet.has(schedule.sourceMessageId)) continue;
    if (parsedIds.has(schedule.sourceMessageId)) continue;
    const message = history.get(schedule.sourceMessageId);
    const removedAt =
      timestamp(message?.editDate) ||
      timestamp(message?.date) ||
      now().toISOString();
    removals.push({ sourceMessageId: schedule.sourceMessageId, removedAt });
  }
  await assertLease();
  let removed = await schedules.removeMany(removals);

  const oldestFetchedId = [...history.values()].reduce(
    (oldest, message) => Math.min(oldest, message.id),
    Number.POSITIVE_INFINITY,
  );
  if (Number.isFinite(oldestFetchedId)) {
    await assertLease();
    const minimumMessageId =
      fetchedMessageCount < historyLimit ? 0 : oldestFetchedId;
    removed += await schedules.removeMissing(
      seenIds,
      minimumMessageId,
      now().toISOString(),
    );
  }

  return {
    imported: parsedIds.size,
    removed,
    scanned: history.size,
    syncedAt: now().toISOString(),
  };
}
