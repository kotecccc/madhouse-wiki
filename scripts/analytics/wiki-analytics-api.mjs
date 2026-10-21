import { validateTelegramInitData } from "../telegram/telegram-init-data.mjs";
import {
  deriveVisitorKey,
  verifyCronAuthorization,
  wikiAnalyticsLimits,
  createWikiAnalyticsStore,
} from "./wiki-analytics-store.mjs";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SUBJECT_PATTERN = /^[a-z0-9$._-]{1,24}$/iu;

function json(status, value) {
  return Response.json(value, { status, headers: PRIVATE_HEADERS });
}

async function readBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function normalizeEvent(input) {
  if (!input || !wikiAnalyticsLimits.validEvents.includes(input.event))
    return null;
  const section = wikiAnalyticsLimits.validSections.includes(input.section)
    ? input.section
    : undefined;
  const feature = wikiAnalyticsLimits.validFeatures.includes(input.feature)
    ? input.feature
    : undefined;
  const subject =
    typeof input.subject === "string" && SUBJECT_PATTERN.test(input.subject)
      ? input.subject
      : undefined;
  return {
    event: input.event,
    ...(section ? { section } : {}),
    ...(feature ? { feature } : {}),
    ...(subject ? { subject } : {}),
  };
}

export function createWikiAnalyticsApi({
  botToken,
  adminTelegramId,
  store = createWikiAnalyticsStore(),
  now = () => new Date(),
} = {}) {
  function verifyContext(body, { requireTelegram = false } = {}) {
    let telegramUser = null;
    if (
      body &&
      Object.hasOwn(body, "initData") &&
      (typeof body.initData !== "string" || !body.initData)
    ) {
      return { error: json(401, { error: "telegram_session_invalid" }) };
    }
    if (typeof body?.initData === "string" && body.initData) {
      telegramUser = validateTelegramInitData(body.initData, botToken, {
        now: now().getTime(),
      });
      if (!telegramUser)
        return { error: json(401, { error: "telegram_session_invalid" }) };
    }
    if (requireTelegram && !telegramUser)
      return { error: json(401, { error: "telegram_session_required" }) };
    if (
      telegramUser &&
      typeof adminTelegramId === "string" &&
      telegramUser.id === adminTelegramId
    ) {
      return {
        telegramUser,
        isAdmin: true,
        visitorKey: deriveVisitorKey(botToken, {
          kind: "telegram",
          id: telegramUser.id,
        }),
      };
    }
    if (requireTelegram) return { telegramUser, isAdmin: false };
    if (telegramUser) {
      return {
        telegramUser,
        visitorKey: deriveVisitorKey(botToken, {
          kind: "telegram",
          id: telegramUser.id,
        }),
      };
    }
    if (UUID_PATTERN.test(body?.visitorId || "")) {
      return {
        telegramUser: null,
        visitorKey: deriveVisitorKey(botToken, {
          kind: "web",
          id: body.visitorId.toLowerCase(),
        }),
      };
    }
    return { error: json(400, { error: "visitor_context_required" }) };
  }

  return async function handleAnalyticsRequest(request) {
    if (request.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    if (!botToken || !/^\d{1,16}$/u.test(adminTelegramId || ""))
      return json(503, { error: "analytics_unavailable" });
    const body = await readBody(request);
    if (!body || typeof body !== "object")
      return json(400, { error: "invalid_request" });

    if (body.action === "events") {
      const context = verifyContext(body);
      if (context.error) return context.error;
      if (
        !Array.isArray(body.events) ||
        body.events.length < 1 ||
        body.events.length > wikiAnalyticsLimits.maxBatchEvents
      )
        return json(400, { error: "invalid_event_batch" });
      const events = body.events.map(normalizeEvent);
      if (events.some((event) => !event))
        return json(400, { error: "invalid_event" });
      if (context.isAdmin) return json(202, { accepted: 0 });
      try {
        await store.append(
          context.visitorKey,
          events,
          context.telegramUser
            ? {
                telegramId: context.telegramUser.id,
                username: context.telegramUser.username,
              }
            : null,
        );
        return json(202, { accepted: events.length });
      } catch {
        return json(503, { error: "analytics_unavailable" });
      }
    }

    if (body.action === "report") {
      const context = verifyContext(body, { requireTelegram: true });
      if (context.error) return context.error;
      if (!context.isAdmin) return json(403, { error: "forbidden" });
      try {
        return json(
          200,
          await store.report({
            excludeVisitorKey: deriveVisitorKey(botToken, {
              kind: "telegram",
              id: adminTelegramId,
            }),
          }),
        );
      } catch {
        return json(503, { error: "analytics_report_unavailable" });
      }
    }

    if (body.action === "delete-self") {
      const context = verifyContext(body);
      if (context.error) return context.error;
      try {
        const deletedEvents = await store.deleteVisitor(context.visitorKey);
        return json(200, { deletedEvents });
      } catch {
        return json(503, { error: "analytics_delete_unavailable" });
      }
    }

    return json(400, { error: "unknown_action" });
  };
}

export function createWikiAnalyticsCleanupApi({
  cronSecret,
  store = createWikiAnalyticsStore(),
} = {}) {
  return async function handleCleanupRequest(request) {
    if (request.method !== "GET")
      return json(405, { error: "method_not_allowed" });
    if (
      !verifyCronAuthorization(request.headers.get("authorization"), cronSecret)
    )
      return json(401, { error: "unauthorized" });
    try {
      const result = await store.cleanExpired();
      return json(200, result);
    } catch {
      return json(503, { error: "analytics_cleanup_unavailable" });
    }
  };
}
