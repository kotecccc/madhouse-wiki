const events = new Set([
  "send-start",
  "send-response",
  "send-error",
  "resend-start",
  "resend-response",
  "resend-error",
  "pending-restored",
  "cancel",
  "storage-memory",
]);
const deliveries = new Set([
  "app",
  "sms",
  "call",
  "flash_call",
  "missed_call",
  "email",
  "email_required",
  "fragment",
  "firebase",
  "sms_word",
  "sms_phrase",
  "none",
  "unknown",
  "success",
]);
const errors = new Set([
  "API_ID_INVALID",
  "API_ID_PUBLISHED_FLOOD",
  "PHONE_NUMBER_INVALID",
  "PHONE_NUMBER_BANNED",
  "PHONE_NUMBER_FLOOD",
  "PHONE_CODE_FLOOD",
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_DUPLICATED",
  "SESSION_PASSWORD_NEEDED",
  "FLOOD_WAIT",
  "TIMEOUT",
  "NETWORK",
  "CANCELLED",
  "UNKNOWN",
]);

export function authErrorCategory(error) {
  if (errors.has(error?.text)) return error.text;
  if (/^FLOOD_WAIT_\d+$/.test(error?.text || "")) return "FLOOD_WAIT";
  if (error?.message === "cancelled") return "CANCELLED";
  if (["TimeoutError", "MtTimeoutError"].includes(error?.name))
    return "TIMEOUT";
  if (error?.name === "NetworkError") return "NETWORK";
  return "UNKNOWN";
}

// This is also the server's boundary: reject unknown fields instead of logging
// arbitrary client objects, RPC payloads, credentials or error messages.
export function validateAuthTrace(value) {
  const fields = new Set([
    "id",
    "sequence",
    "event",
    "deliveryType",
    "nextDeliveryType",
    "codeLength",
    "timeout",
    "elapsedMs",
    "errorCategory",
    "memoryOnly",
  ]);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !Object.keys(value).every((key) => fields.has(key)) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      value.id || "",
    ) ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    value.sequence > 64 ||
    !events.has(value.event)
  )
    throw new Error("invalid_request");
  for (const key of ["deliveryType", "nextDeliveryType"])
    if (Object.hasOwn(value, key) && !deliveries.has(value[key]))
      throw new Error("invalid_request");
  for (const [key, max] of [
    ["codeLength", 9],
    ["timeout", 86400],
    ["elapsedMs", 3600000],
  ])
    if (
      Object.hasOwn(value, key) &&
      (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > max)
    )
      throw new Error("invalid_request");
  if (Object.hasOwn(value, "errorCategory") && !errors.has(value.errorCategory))
    throw new Error("invalid_request");
  if (
    Object.hasOwn(value, "memoryOnly") &&
    typeof value.memoryOnly !== "boolean"
  )
    throw new Error("invalid_request");
  return { ...value };
}
