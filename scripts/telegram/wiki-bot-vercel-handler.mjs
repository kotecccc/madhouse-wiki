const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};
const MAX_WEBHOOK_BODY_BYTES = 96 * 1024;

class PayloadTooLargeError extends Error {}

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

async function requestBody(request) {
  let body;
  try {
    body = request.body;
  } catch {
    body = undefined;
  }

  if (body != null) {
    const serialized =
      typeof body === "string"
        ? body
        : Buffer.isBuffer(body) || body instanceof Uint8Array
          ? Buffer.from(body).toString("utf8")
          : JSON.stringify(body);
    if (typeof serialized === "string") {
      if (Buffer.byteLength(serialized, "utf8") > MAX_WEBHOOK_BODY_BYTES) {
        throw new PayloadTooLargeError();
      }
      return serialized;
    }
  }

  if (typeof request?.[Symbol.asyncIterator] !== "function") return undefined;

  const chunks = [];
  let size = 0;
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.byteLength;
    if (size > MAX_WEBHOOK_BODY_BYTES) throw new PayloadTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createWikiBotVercelHandler(api) {
  return async (request, response) => {
    let result;
    try {
      const headers = new Headers();
      const secret = headerValue(
        request.headers,
        "x-telegram-bot-api-secret-token",
      );
      if (secret) headers.set("x-telegram-bot-api-secret-token", secret);
      const contentType = headerValue(request.headers, "content-type");
      if (contentType) headers.set("content-type", contentType);

      const body = await requestBody(request);
      result = await api(
        new Request(
          new URL(
            request.url || "/api/telegram/bot-webhook",
            "https://wiki.invalid",
          ),
          {
            method: request.method || "GET",
            headers,
            ...(body !== undefined ? { body } : {}),
          },
        ),
      );
    } catch (error) {
      result = new Response(
        error instanceof PayloadTooLargeError
          ? "payload_too_large"
          : "bot_api_unavailable",
        {
          status: error instanceof PayloadTooLargeError ? 413 : 503,
          headers: PRIVATE_HEADERS,
        },
      );
    }

    response.statusCode = result.status;
    for (const [key, value] of result.headers) response.setHeader(key, value);
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}
