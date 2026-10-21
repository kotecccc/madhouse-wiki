const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "text/plain; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function headerValue(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function requestBody(request) {
  const body = request.body;
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body)) return body.toString("utf8");
  return JSON.stringify(body);
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

      const body = requestBody(request);
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
    } catch {
      result = new Response("bot_api_unavailable", {
        status: 503,
        headers: PRIVATE_HEADERS,
      });
    }

    response.statusCode = result.status;
    for (const [key, value] of result.headers) response.setHeader(key, value);
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}
