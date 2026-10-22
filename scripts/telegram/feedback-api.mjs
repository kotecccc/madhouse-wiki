import { randomUUID } from "node:crypto";
import { validateTelegramInitData } from "./telegram-init-data.mjs";

const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const MAX_TEXT_LENGTH = 1600;
const MAX_TEXT_WITH_IMAGE = 650;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const VALID_SCREEN = new Set(["floors", "raids"]);
const VALID_IMAGE_TYPES = new Map([
  [
    "image/jpeg",
    {
      extension: "jpg",
      matches: (bytes) =>
        bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    },
  ],
  [
    "image/png",
    {
      extension: "png",
      matches: (bytes) =>
        bytes
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    },
  ],
  [
    "image/webp",
    {
      extension: "webp",
      matches: (bytes) =>
        bytes.toString("ascii", 0, 4) === "RIFF" &&
        bytes.toString("ascii", 8, 12) === "WEBP",
    },
  ],
]);

function json(status, value) {
  return Response.json(value, { status, headers: PRIVATE_HEADERS });
}

function readJson(request) {
  return request.json().catch(() => null);
}

function plainText(value, maxLength) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\p{Cc}/gu, (character) =>
      ["\t", "\n", "\r"].includes(character) ? character : "",
    )
    .trim()
    .slice(0, maxLength);
}

function readScreenshot(body) {
  if (!body?.screenshot) return { image: null, error: null };
  const { base64, mimeType } = body.screenshot;
  const type = VALID_IMAGE_TYPES.get(mimeType);
  if (!type || typeof base64 !== "string")
    return { image: null, error: "unsupported_image" };
  if (
    base64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 8 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      base64,
    )
  ) {
    return { image: null, error: "image_too_large" };
  }
  const image = Buffer.from(base64, "base64");
  if (!image.length || image.length > MAX_IMAGE_BYTES)
    return { image: null, error: "image_too_large" };
  if (!type.matches(image)) return { image: null, error: "invalid_image" };
  return { image: { ...type, mimeType, bytes: image }, error: null };
}

function makeFeedbackId(now = new Date()) {
  const day = now.toISOString().slice(2, 10).replaceAll("-", "");
  return `FB-${day}-${randomUUID().slice(0, 6).toUpperCase()}`;
}

function contactLabel(user) {
  const name = user.displayName || "Имя не указано";
  const username = user.username ? ` • @${user.username}` : "";
  return `${name}${username} • Telegram ID ${user.id}`;
}

export function createFeedbackApi({
  botToken,
  adminTelegramId,
  wikiOrigin = "https://madhouse-wiki.ru",
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
} = {}) {
  const submissions = new Map();

  async function callTelegram(method, options) {
    const result = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/${method}`,
      options,
    );
    const data = await result.json().catch(() => null);
    if (!result.ok || data?.ok !== true) throw new Error("telegram_failed");
  }

  return async function handleFeedbackRequest(request) {
    if (request.method !== "POST")
      return json(405, { error: "method_not_allowed" });
    if (!botToken || !/^\d{1,16}$/u.test(adminTelegramId || ""))
      return json(503, { error: "feedback_unavailable" });

    const body = await readJson(request);
    if (!body || typeof body !== "object")
      return json(400, { error: "invalid_request" });
    const user = validateTelegramInitData(body.initData, botToken, {
      now: now().getTime(),
    });
    if (!user) return json(401, { error: "telegram_session_required" });

    const { image, error: imageError } = readScreenshot(body);
    if (imageError) return json(400, { error: imageError });
    const message = plainText(
      body.message,
      image ? MAX_TEXT_WITH_IMAGE : MAX_TEXT_LENGTH,
    );
    if (!message && !image) return json(400, { error: "message_required" });
    if (
      typeof body.message === "string" &&
      body.message.trim().length > message.length
    )
      return json(400, { error: "message_too_long" });

    const currentTime = now();
    const recent = (submissions.get(user.id) || []).filter(
      (timestamp) => currentTime.getTime() - timestamp < 60 * 60 * 1000,
    );
    if (recent.length >= 3)
      return json(429, { error: "feedback_rate_limited" });

    const feedbackId = makeFeedbackId(currentTime);
    const screen = VALID_SCREEN.has(body.screen) ? body.screen : "wiki";
    const identity = contactLabel(user);
    const subject = `Раздел: ${screen}`;
    const pageUrl = `${wikiOrigin.replace(/\/$/u, "")}/${screen === "raids" ? "#raids" : ""}`;
    const header = [
      `Обращение ${feedbackId}`,
      `От: ${identity}`,
      subject,
      `Страница: ${pageUrl}`,
      "",
    ].join("\n");

    try {
      if (image) {
        const form = new FormData();
        form.set("chat_id", adminTelegramId);
        form.set("caption", `${header}${message}`.slice(0, 1024));
        form.set(
          "photo",
          new Blob([image.bytes], { type: image.mimeType }),
          `${feedbackId}.${image.extension}`,
        );
        await callTelegram("sendPhoto", {
          method: "POST",
          body: form,
          signal: AbortSignal.timeout(15_000),
        });
      } else {
        await callTelegram("sendMessage", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: adminTelegramId,
            text: `${header}${message}`,
            link_preview_options: { is_disabled: true },
          }),
          signal: AbortSignal.timeout(10_000),
        });
      }
    } catch {
      return json(502, { error: "feedback_delivery_failed" });
    }

    submissions.set(user.id, [...recent, currentTime.getTime()]);
    return json(200, { feedbackId });
  };
}

export const feedbackLimits = {
  imageBytes: MAX_IMAGE_BYTES,
  imageMimeTypes: [...VALID_IMAGE_TYPES.keys()],
  textLength: MAX_TEXT_LENGTH,
  textWithImageLength: MAX_TEXT_WITH_IMAGE,
};
