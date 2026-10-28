export class BridgeProtocolError extends Error {
  constructor(code = "invalid_message") {
    super(code);
    this.name = "BridgeProtocolError";
    this.code = code;
  }
}

export function fail(code = "invalid_message") {
  throw new BridgeProtocolError(code);
}

export function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function exactKeys(value, required, optional = []) {
  if (!isRecord(value)) fail();
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    keys.some((key) => !allowed.has(key))
  )
    fail();
}

export function isUuid(value) {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value,
    )
  );
}

export function assertUuid(value) {
  if (!isUuid(value)) fail();
  return value;
}

export function isInteger(
  value,
  { min = 0, max = Number.MAX_SAFE_INTEGER } = {},
) {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

export function assertInteger(value, range) {
  if (!isInteger(value, range)) fail();
  return value;
}

export function isStringBytes(value, { min = 0, max, pattern } = {}) {
  if (typeof value !== "string") return false;
  const bytes = new TextEncoder().encode(value).byteLength;
  return bytes >= min && bytes <= max && (!pattern || pattern.test(value));
}

export function assertStringBytes(value, options) {
  if (!isStringBytes(value, options)) fail();
  return value;
}

export function assertEnum(value, allowed) {
  if (!allowed.includes(value)) fail();
  return value;
}

export function assertUniqueEnumArray(value, allowed, maxItems) {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((entry) => !allowed.includes(entry)) ||
    new Set(value).size !== value.length
  )
    fail();
  return value;
}

export function assertBase64Url(value, { min = 1, max } = {}) {
  assertStringBytes(value, {
    min,
    max,
    pattern: /^[A-Za-z0-9_-]+$/,
  });
  return value;
}

export function assertCompactSignedToken(value, { min = 1, max = 512 } = {}) {
  assertStringBytes(value, {
    min,
    max,
    pattern: /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/,
  });
  return value;
}

export function assertBase64UrlBytes(value, byteLength) {
  assertInteger(byteLength, { min: 1 });
  const encodedLength = Math.ceil((byteLength * 8) / 6);
  assertBase64Url(value, { min: encodedLength, max: encodedLength });
  const remainder = byteLength % 3;
  if (remainder === 1 && !/[AQgw]$/.test(value)) fail();
  if (remainder === 2 && !/[AEIMQUYcgkosw048]$/.test(value)) fail();
  return value;
}

export function assertProtocolVersion(major, minor) {
  assertInteger(major, { min: 0, max: 65535 });
  assertInteger(minor, { min: 0, max: 65535 });
  if (major !== 1 || minor !== 0) fail("unsupported_protocol");
}
