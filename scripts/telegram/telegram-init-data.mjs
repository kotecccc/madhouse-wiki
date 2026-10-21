import { createHmac, timingSafeEqual } from "node:crypto";

const MAX_INIT_DATA_LENGTH = 4096;
const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;
const MAX_CLOCK_SKEW_SECONDS = 120;

function cleanText(value, maxLength = 80) {
  if (typeof value !== "string") return "";
  return value
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, maxLength);
}

export function validateTelegramInitData(
  initData,
  botToken,
  { now = Date.now(), maxAgeSeconds = MAX_AUTH_AGE_SECONDS } = {},
) {
  if (
    typeof initData !== "string" ||
    !initData ||
    initData.length > MAX_INIT_DATA_LENGTH ||
    typeof botToken !== "string" ||
    !botToken
  ) {
    return null;
  }

  const fields = new Map();
  for (const [key, value] of new URLSearchParams(initData)) {
    if (fields.has(key)) return null;
    fields.set(key, value);
  }

  const suppliedHash = fields.get("hash");
  if (!/^[a-f0-9]{64}$/iu.test(suppliedHash || "")) return null;

  const dataCheckString = [...fields.entries()]
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");

  const secretKey = createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const expectedHash = createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest();
  const receivedHash = Buffer.from(suppliedHash, "hex");
  if (
    receivedHash.length !== expectedHash.length ||
    !timingSafeEqual(receivedHash, expectedHash)
  ) {
    return null;
  }

  const authDate = Number(fields.get("auth_date"));
  const nowSeconds = Math.floor(now / 1000);
  if (
    !Number.isSafeInteger(authDate) ||
    authDate > nowSeconds + MAX_CLOCK_SKEW_SECONDS ||
    nowSeconds - authDate > maxAgeSeconds
  ) {
    return null;
  }

  let user;
  try {
    user = JSON.parse(fields.get("user") || "null");
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(user?.id) || user.id < 1) return null;

  return {
    id: String(user.id),
    username: cleanText(user.username, 64),
    displayName: [user.first_name, user.last_name]
      .map((part) => cleanText(part, 80))
      .filter(Boolean)
      .join(" ")
      .slice(0, 120),
  };
}
