import { telegramContext } from "../../../shared/telegram-context.js";

const CONSENT_KEY = "madhouse.wiki.analytics.consent.v2";
const PREVIOUS_CONSENT_KEY = "madhouse.wiki.analytics.consent.v1";
const VISITOR_KEY = "madhouse.wiki.analytics.visitor.v1";
const MAX_BATCH = 25;
const EVENT_NAMES = new Set([
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
const SECTIONS = new Set([
  "floors",
  "raids",
  "businesses",
  "bosses",
  "feedback",
]);
const FEATURES = new Set([
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
const SAFE_SUBJECT = /^[a-z0-9$._-]{1,24}$/iu;

let queuedEvents = [];
let flushTimer;
let flushing = false;

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getAnalyticsConsent() {
  const currentStorage = storage();
  const value = currentStorage?.getItem(CONSENT_KEY);
  if (value === "accepted" || value === "rejected") return value;
  // Keep a previous refusal, but ask again before the expanded identity data.
  return currentStorage?.getItem(PREVIOUS_CONSENT_KEY) === "rejected"
    ? "rejected"
    : null;
}

export function setAnalyticsConsent(value) {
  if (value !== "accepted" && value !== "rejected") return;
  try {
    storage()?.setItem(CONSENT_KEY, value);
  } catch {
    // The session will remain untracked if consent cannot be saved locally.
  }
}

function visitorId(create = false) {
  const current = storage();
  if (!current) return null;
  try {
    let id = current.getItem(VISITOR_KEY);
    if (!id && create) {
      id = crypto.randomUUID();
      current.setItem(VISITOR_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

function removeVisitorId() {
  try {
    storage()?.removeItem(VISITOR_KEY);
  } catch {
    // A stale local identifier is harmless if storage has been disabled.
  }
}

export function clearQueuedAnalytics() {
  queuedEvents = [];
  window.clearTimeout(flushTimer);
}

function contextPayload() {
  const telegram = telegramContext();
  if (telegram.initData) return { initData: telegram.initData };
  if (telegram.isTelegram) return null;
  const id = visitorId(true);
  return id ? { visitorId: id } : null;
}

async function flushAnalytics(keepalive = false) {
  if (flushing || !queuedEvents.length || getAnalyticsConsent() !== "accepted")
    return;
  const context = contextPayload();
  if (!context) return;
  flushing = true;
  const events = queuedEvents.splice(0, MAX_BATCH);
  try {
    const response = await fetch("/api/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "events", ...context, events }),
      cache: "no-store",
      keepalive,
    });
    if (!response.ok)
      queuedEvents = [...events, ...queuedEvents].slice(-MAX_BATCH);
  } catch {
    queuedEvents = [...events, ...queuedEvents].slice(-MAX_BATCH);
  } finally {
    flushing = false;
    if (queuedEvents.length) scheduleFlush();
  }
}

function scheduleFlush() {
  window.clearTimeout(flushTimer);
  flushTimer = window.setTimeout(() => void flushAnalytics(), 8_000);
}

export function trackProductEvent(event, details = {}) {
  if (
    getAnalyticsConsent() !== "accepted" ||
    !EVENT_NAMES.has(event) ||
    typeof window === "undefined"
  )
    return;
  const section = SECTIONS.has(details.section) ? details.section : undefined;
  const feature = FEATURES.has(details.feature) ? details.feature : undefined;
  const subject =
    typeof details.subject === "string" && SAFE_SUBJECT.test(details.subject)
      ? details.subject
      : undefined;
  queuedEvents.push({
    event,
    ...(section ? { section } : {}),
    ...(feature ? { feature } : {}),
    ...(subject ? { subject } : {}),
  });
  if (queuedEvents.length >= MAX_BATCH) void flushAnalytics();
  else scheduleFlush();
}

export function analyticsRequestContext() {
  const telegram = telegramContext();
  if (telegram.initData) return { initData: telegram.initData };
  if (telegram.isTelegram) return null;
  const id = visitorId(false);
  return id ? { visitorId: id } : null;
}

export function forgetAnalyticsIdentity() {
  removeVisitorId();
}

if (typeof window !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flushAnalytics(true);
  });
  window.addEventListener("pagehide", () => void flushAnalytics(true));
}
