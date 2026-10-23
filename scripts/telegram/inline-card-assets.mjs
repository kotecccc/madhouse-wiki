import { createHash } from "node:crypto";

const cardVersionCache = new WeakMap();

export function normalizeInlineCode(value) {
  return String(value || "")
    .toLocaleUpperCase("ru-RU")
    .replaceAll("С", "C");
}

function codeSlug(value) {
  const code = normalizeInlineCode(value);
  return code === "$" ? "special" : code.replace(/[^A-Z0-9_-]/g, "-");
}

export function floorCardFilename(code) {
  return `floor-${codeSlug(code)}.jpg`;
}

export function departmentCardFilename(code) {
  return `department-${codeSlug(code)}.jpg`;
}

function businessKey(businessId) {
  const rawId = String(businessId || "");
  return /^\d+$/u.test(rawId)
    ? rawId
    : `ref-${createHash("sha256").update(rawId).digest("hex").slice(0, 10)}`;
}

export function businessCardFilename(businessId, level) {
  const id = businessKey(businessId);
  return `business-${id}-level-${Number(level)}.jpg`;
}

export const unavailableBusinessCardFilename = "business-unavailable.jpg";

export function inlineCardUrl(origin, filename, version) {
  const url = new URL(`/inline-cards/${filename}`, origin);
  if (version) url.searchParams.set("v", version);
  return url.toString();
}

export function inlineCardsVersion(knowledgeBase) {
  if (knowledgeBase && typeof knowledgeBase === "object") {
    const cached = cardVersionCache.get(knowledgeBase);
    if (cached) return cached;
  }
  const version = createHash("sha256")
    .update("inline-card-template-v3:")
    .update(JSON.stringify(knowledgeBase || {}))
    .digest("hex")
    .slice(0, 12);
  if (knowledgeBase && typeof knowledgeBase === "object") {
    cardVersionCache.set(knowledgeBase, version);
  }
  return version;
}
