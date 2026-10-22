const MAX_JSON_BODY_BYTES = 3 * 1024 * 1024;
const PRIVATE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff",
};

function getHeader(headers, name) {
  const value = headers?.[name] ?? headers?.[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function serializeBody(body) {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (Buffer.isBuffer(body) || body instanceof Uint8Array)
    return Buffer.from(body).toString("utf8");
  try {
    return JSON.stringify(body);
  } catch {
    return undefined;
  }
}

async function readStreamedBody(request) {
  if (typeof request[Symbol.asyncIterator] !== "function") return undefined;
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string"
        ? Buffer.from(chunk)
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk)
          : null;
    if (!bytes) throw new Error("unsupported_request_body_chunk");
    size += bytes.byteLength;
    if (size > MAX_JSON_BODY_BYTES) return null;
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

export function createWikiApiVercelHandler(api) {
  return async (request, response) => {
    let result;
    try {
      const method = request.method || "GET";
      let body = serializeBody(request.body);
      if (body === undefined && !["GET", "HEAD"].includes(method))
        body = await readStreamedBody(request);
      if (
        body === null ||
        (body !== undefined &&
          Buffer.byteLength(body, "utf8") > MAX_JSON_BODY_BYTES)
      ) {
        result = Response.json(
          { error: "payload_too_large" },
          { status: 413, headers: PRIVATE_HEADERS },
        );
      } else {
        const headers = new Headers();
        const contentType = getHeader(request.headers, "content-type");
        const authorization = getHeader(request.headers, "authorization");
        if (contentType) headers.set("content-type", contentType);
        if (authorization) headers.set("authorization", authorization);
        result = await api(
          new Request(new URL(request.url || "/", "https://wiki.invalid"), {
            method,
            headers,
            ...(body !== undefined && !["GET", "HEAD"].includes(method)
              ? { body }
              : {}),
          }),
        );
      }
    } catch {
      result = Response.json(
        { error: "service_unavailable" },
        { status: 503, headers: PRIVATE_HEADERS },
      );
    }

    response.statusCode = result.status;
    for (const [key, value] of result.headers) response.setHeader(key, value);
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}

export function createWikiCleanupVercelHandler(api) {
  return async (request, response) => {
    let result;
    try {
      const headers = new Headers();
      const authorization = getHeader(request.headers, "authorization");
      if (authorization) headers.set("authorization", authorization);
      result = await api(
        new Request(new URL(request.url || "/", "https://wiki.invalid"), {
          method: request.method || "GET",
          headers,
        }),
      );
    } catch {
      result = Response.json(
        { error: "cleanup_unavailable" },
        { status: 503, headers: PRIVATE_HEADERS },
      );
    }
    response.statusCode = result.status;
    for (const [key, value] of result.headers) response.setHeader(key, value);
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}
