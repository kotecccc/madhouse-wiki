import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { del, get, list, put } from "@vercel/blob";
import { strongBlobEtag } from "../telegram/raid-blob-etag.mjs";

const EVENT_PREFIX = "madhouse-wiki/analytics/events/";
const RETENTION_DAYS = 90;
const REPORT_DAYS = 30;
const MAX_BATCH_EVENTS = 25;
const MAX_BATCH_BLOBS = 5000;
const MAX_LIST_PAGES = 100;
const VALID_EVENTS = new Set([
  "app_open",
  "screen_view",
  "floor_select",
  "floor_requirements_open",
  "department_open",
  "business_upgrades_open",
  "business_requirements_open",
  "calculator_open",
  "boss_details_open",
  "raid_archive_open",
  "feedback_open",
  "feedback_submit",
]);
const VALID_SECTIONS = new Set([
  "floors",
  "raids",
  "businesses",
  "bosses",
  "feedback",
]);
const VALID_FEATURES = new Set([
  "floor_catalogue",
  "floor_requirements",
  "work_details",
  "business_upgrades",
  "business_requirements",
  "energy_calculator",
  "boss_drops",
  "raid_schedule",
  "raid_archive",
  "feedback_form",
]);

const defaultBlobClient = { del, get, list, put };

function dateString(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function pathDay(pathname) {
  return /\/events\/(\d{4}-\d{2}-\d{2})\//u.exec(pathname)?.[1] || "";
}

function recentDays(startDay, endDay) {
  const days = [];
  for (
    let timestamp = Date.parse(`${startDay}T00:00:00.000Z`);
    timestamp <= Date.parse(`${endDay}T00:00:00.000Z`);
    timestamp += 24 * 60 * 60 * 1000
  ) {
    days.push(dateString(timestamp));
  }
  return days;
}

function parseRecordList(value) {
  if (value?.schemaVersion !== 1 || !Array.isArray(value.events)) return [];
  return value.events.flatMap((event) => {
    if (
      !event ||
      !/^[a-f0-9]{64}$/u.test(event.visitorKey || "") ||
      (event.telegramId != null &&
        (typeof event.telegramId !== "string" ||
          !/^\d{1,16}$/u.test(event.telegramId))) ||
      (event.username != null &&
        (typeof event.username !== "string" ||
          !/^[A-Za-z0-9_]{5,32}$/u.test(event.username))) ||
      !VALID_EVENTS.has(event.event) ||
      typeof event.createdAt !== "string" ||
      !Number.isFinite(Date.parse(event.createdAt)) ||
      (event.section != null && !VALID_SECTIONS.has(event.section)) ||
      (event.feature != null && !VALID_FEATURES.has(event.feature)) ||
      (event.subject != null && !/^[a-z0-9$._-]{1,24}$/iu.test(event.subject))
    )
      return [];
    return [
      {
        visitorKey: event.visitorKey,
        event: event.event,
        ...(event.section ? { section: event.section } : {}),
        ...(event.feature ? { feature: event.feature } : {}),
        ...(event.subject ? { subject: event.subject } : {}),
        ...(event.telegramId ? { telegramId: event.telegramId } : {}),
        ...(event.username ? { username: event.username } : {}),
        createdAt: event.createdAt,
      },
    ];
  });
}

function makeAlias(visitorKey) {
  return `user-${visitorKey.slice(0, 8)}`;
}

function sortByCount(map) {
  return [...map.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort(
      (left, right) =>
        right.count - left.count || left.name.localeCompare(right.name),
    );
}

export function createWikiAnalyticsStore({
  blobClient = defaultBlobClient,
  now = () => new Date(),
} = {}) {
  async function listAll({ prefix, maxItems = MAX_BATCH_BLOBS } = {}) {
    const blobs = [];
    let cursor;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const result = await blobClient.list({ prefix, limit: 1000, cursor });
      blobs.push(...result.blobs);
      if (blobs.length >= maxItems) {
        const pageExceededLimit = blobs.length > maxItems;
        blobs.length = maxItems;
        return {
          blobs,
          truncated: pageExceededLimit || Boolean(result.hasMore),
        };
      }
      if (!result.hasMore) return { blobs, truncated: false };
      cursor = result.cursor;
      if (!cursor) throw new Error("analytics_cursor_missing");
    }
    return { blobs, truncated: true };
  }

  async function readBatch(pathname) {
    const result = await blobClient.get(pathname, {
      access: "private",
      useCache: false,
    });
    if (!result || result.statusCode !== 200 || result.blob.size > 64 * 1024)
      throw new Error("analytics_batch_unavailable");
    const parsed = JSON.parse(await new Response(result.stream).text());
    if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed.events))
      throw new Error("analytics_batch_invalid");
    return {
      events: parseRecordList(parsed),
      etag: strongBlobEtag(result.blob.etag),
    };
  }

  async function readBatches(blobs, maxEvents = Infinity) {
    const batches = new Array(blobs.length);
    let nextIndex = 0;
    async function worker() {
      while (nextIndex < blobs.length) {
        const index = nextIndex++;
        const blob = blobs[index];
        batches[index] = { blob, ...(await readBatch(blob.pathname)) };
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(8, blobs.length) }, () => worker()),
    );
    const events = [];
    for (const batch of batches) {
      for (const event of batch.events) {
        events.push({ event, pathname: batch.blob.pathname, etag: batch.etag });
        if (events.length >= maxEvents) return events;
      }
    }
    return events;
  }

  async function append(visitorKey, events, identity = null) {
    const timestamp = now();
    const day = dateString(timestamp.getTime());
    const telegramId =
      typeof identity?.telegramId === "string" &&
      /^\d{1,16}$/u.test(identity.telegramId)
        ? identity.telegramId
        : undefined;
    const username =
      typeof identity?.username === "string" &&
      /^[A-Za-z0-9_]{5,32}$/u.test(identity.username)
        ? identity.username
        : undefined;
    const normalized = events.map((event) => ({
      visitorKey,
      event: event.event,
      section: event.section,
      feature: event.feature,
      subject: event.subject,
      ...(telegramId ? { telegramId } : {}),
      ...(username ? { username } : {}),
      createdAt: timestamp.toISOString(),
    }));
    const pathname = `${EVENT_PREFIX}${day}/${randomUUID()}.json`;
    await blobClient.put(
      pathname,
      JSON.stringify({ schemaVersion: 1, events: normalized }),
      {
        access: "private",
        addRandomSuffix: false,
        allowOverwrite: false,
        cacheControlMaxAge: 60,
        contentType: "application/json",
      },
    );
  }

  async function report({ excludeVisitorKey } = {}) {
    const current = now();
    const cutoff = current.getTime() - REPORT_DAYS * 24 * 60 * 60 * 1000;
    const startDay = dateString(cutoff);
    const blobs = [];
    let truncated = false;
    for (const day of recentDays(startDay, dateString(current.getTime()))) {
      const remaining = MAX_BATCH_BLOBS - blobs.length;
      if (remaining <= 0) {
        truncated = true;
        break;
      }
      const page = await listAll({
        prefix: `${EVENT_PREFIX}${day}/`,
        maxItems: remaining,
      });
      blobs.push(...page.blobs);
      truncated ||= page.truncated;
      if (page.truncated) break;
    }
    const records = await readBatches(
      blobs,
      MAX_BATCH_BLOBS * MAX_BATCH_EVENTS,
    );
    const events = records
      .map(({ event }) => event)
      .filter((event) => {
        const timestamp = Date.parse(event.createdAt);
        return (
          timestamp >= cutoff &&
          timestamp <= current.getTime() &&
          event.visitorKey !== excludeVisitorKey
        );
      });
    const visitors = new Map();
    const daily = new Map();
    const sections = new Map();
    const features = new Map();
    const subjects = new Map();
    const eventCounts = new Map();
    let visits = 0;

    for (const event of events) {
      if (event.event === "app_open") visits += 1;
      eventCounts.set(event.event, (eventCounts.get(event.event) || 0) + 1);
      if (event.section)
        sections.set(event.section, (sections.get(event.section) || 0) + 1);
      if (event.feature)
        features.set(event.feature, (features.get(event.feature) || 0) + 1);
      if (event.subject) {
        const key = `${event.feature || "other"}/${event.subject}`;
        subjects.set(key, (subjects.get(key) || 0) + 1);
      }

      const day = event.createdAt.slice(0, 10);
      const dayState = daily.get(day) || { visits: 0, visitors: new Set() };
      if (event.event === "app_open") dayState.visits += 1;
      dayState.visitors.add(event.visitorKey);
      daily.set(day, dayState);

      const visitor = visitors.get(event.visitorKey) || {
        events: 0,
        firstSeen: event.createdAt,
        lastSeen: event.createdAt,
        eventCounts: new Map(),
      };
      if (event.telegramId) visitor.telegramId = event.telegramId;
      if (event.username) visitor.username = event.username;
      visitor.events += 1;
      if (event.createdAt < visitor.firstSeen)
        visitor.firstSeen = event.createdAt;
      if (event.createdAt > visitor.lastSeen)
        visitor.lastSeen = event.createdAt;
      visitor.eventCounts.set(
        event.event,
        (visitor.eventCounts.get(event.event) || 0) + 1,
      );
      visitors.set(event.visitorKey, visitor);
    }

    const visitorRows = [...visitors.entries()]
      .map(([key, visitor]) => ({
        visitor: makeAlias(key),
        ...(visitor.telegramId ? { telegramId: visitor.telegramId } : {}),
        ...(visitor.username ? { username: visitor.username } : {}),
        events: visitor.events,
        firstSeen: visitor.firstSeen,
        lastSeen: visitor.lastSeen,
        activity: sortByCount(visitor.eventCounts),
      }))
      .sort(
        (left, right) =>
          right.lastSeen.localeCompare(left.lastSeen) ||
          left.visitor.localeCompare(right.visitor),
      )
      .slice(0, 500);

    return {
      range: {
        from: new Date(cutoff).toISOString(),
        to: current.toISOString(),
      },
      events: events.length,
      visits,
      uniqueVisitors: visitors.size,
      byEvent: sortByCount(eventCounts),
      bySection: sortByCount(sections),
      byFeature: sortByCount(features),
      bySubject: sortByCount(subjects),
      daily: [...daily.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([day, value]) => ({
          day,
          visits: value.visits,
          uniqueVisitors: value.visitors.size,
        })),
      visitors: visitorRows,
      truncated,
    };
  }

  async function deleteVisitor(visitorKey) {
    const current = now();
    const cutoffDay = dateString(
      current.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const { blobs, truncated } = await listAll({
      prefix: EVENT_PREFIX,
      maxItems: 100_000,
    });
    if (truncated) throw new Error("analytics_delete_scan_truncated");
    let removedEvents = 0;

    for (const blob of blobs.filter(
      (item) => pathDay(item.pathname) >= cutoffDay,
    )) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { events, etag } = await readBatch(blob.pathname);
        if (!events.length || !etag) break;
        const retained = events.filter(
          (event) => event.visitorKey !== visitorKey,
        );
        const removed = events.length - retained.length;
        if (!removed) break;
        try {
          if (retained.length) {
            await blobClient.put(
              blob.pathname,
              JSON.stringify({ schemaVersion: 1, events: retained }),
              {
                access: "private",
                addRandomSuffix: false,
                allowOverwrite: true,
                cacheControlMaxAge: 60,
                contentType: "application/json",
                ifMatch: etag,
              },
            );
          } else {
            await blobClient.del(blob.pathname, { ifMatch: etag });
          }
          removedEvents += removed;
          break;
        } catch (error) {
          if (attempt === 2) throw error;
        }
      }
    }
    return removedEvents;
  }

  async function cleanExpired() {
    const cutoffDay = dateString(
      now().getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    const { blobs, truncated } = await listAll({
      prefix: EVENT_PREFIX,
      maxItems: 100_000,
    });
    let deleted = 0;
    const expired = blobs.filter((blob) => {
      const match = /\/events\/(\d{4}-\d{2}-\d{2})\//u.exec(blob.pathname);
      return match && match[1] < cutoffDay;
    });
    for (let offset = 0; offset < expired.length; offset += 100) {
      await blobClient.del(
        expired.slice(offset, offset + 100).map((blob) => blob.pathname),
      );
      deleted += Math.min(100, expired.length - offset);
    }
    return { deleted, truncated };
  }

  return { append, cleanExpired, deleteVisitor, report };
}

export function deriveVisitorKey(botToken, identity) {
  if (!botToken || !identity?.kind || !identity?.id) return null;
  return createHmac("sha256", botToken)
    .update(`madhouse-wiki-analytics:${identity.kind}:${identity.id}`)
    .digest("hex");
}

export function verifyCronAuthorization(header, cronSecret) {
  if (
    typeof cronSecret !== "string" ||
    !cronSecret ||
    typeof header !== "string"
  )
    return false;
  const supplied = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${cronSecret}`);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export const wikiAnalyticsLimits = {
  retentionDays: RETENTION_DAYS,
  reportDays: REPORT_DAYS,
  maxBatchEvents: MAX_BATCH_EVENTS,
  validEvents: [...VALID_EVENTS],
  validSections: [...VALID_SECTIONS],
  validFeatures: [...VALID_FEATURES],
};
