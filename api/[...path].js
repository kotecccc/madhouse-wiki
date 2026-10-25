import { readFileSync } from "node:fs";
import { listApiOperations } from "../scripts/api-operations.mjs";
import {
  API_MAX_REQUEST_BYTES,
  createProductionApi,
  routePattern,
} from "../scripts/deploy/production-api.mjs";

export const config = { api: { bodyParser: false } };

const contract = JSON.parse(
  readFileSync(
    new URL("../public/api-docs/openapi.json", import.meta.url),
    "utf8",
  ),
);
const operations = listApiOperations(contract);
const gamePaths = operations.map(({ path }) => routePattern(path));
export const isGameApiPath = (path) =>
  gamePaths.some((pattern) => pattern.test(path));
async function readIncomingBody(request) {
  const contentLength = Number(request.headers?.["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > API_MAX_REQUEST_BYTES) {
    request.resume?.();
    return false;
  }

  const chunks = [];
  let size = 0;
  if (typeof request[Symbol.asyncIterator] === "function") {
    for await (const chunk of request) {
      const buffer = Buffer.from(chunk);
      size += buffer.byteLength;
      if (size > API_MAX_REQUEST_BYTES) {
        request.resume?.();
        return false;
      }
      chunks.push(buffer);
    }
  } else if (request.body != null) {
    let buffer;
    if (Buffer.isBuffer(request.body)) buffer = request.body;
    else if (typeof request.body === "string")
      buffer = Buffer.from(request.body);
    else if (request.body instanceof Uint8Array)
      buffer = Buffer.from(request.body);
    else buffer = Buffer.from(JSON.stringify(request.body));
    if (buffer.byteLength > API_MAX_REQUEST_BYTES) return false;
    chunks.push(buffer);
  }
  return chunks.length ? Buffer.concat(chunks, size || undefined) : null;
}

function sendResult(response, result) {
  response.statusCode = result.status;
  for (const [key, value] of result.headers) response.setHeader(key, value);
  return result.arrayBuffer().then((body) => response.end(Buffer.from(body)));
}

export function createProxy(fetcher = fetch) {
  const transport = createProductionApi(operations, fetcher);
  return async (request, response) => {
    const raw = request.url || "";
    const url =
      raw.startsWith("/api/") &&
      !/[%\\#]/.test(raw.split("?")[0].replace(/%24/gi, "$"))
        ? raw
        : "/invalid";
    const method = (request.method || "GET").toUpperCase();
    let body = null;
    if (method !== "GET" && method !== "HEAD") {
      try {
        body = await readIncomingBody(request);
      } catch {
        const result = new Response(
          JSON.stringify({ error: "Invalid request body" }),
          {
            status: 400,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "private, no-store, max-age=0",
              "CDN-Cache-Control": "no-store",
              "Vercel-CDN-Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          },
        );
        return sendResult(response, result);
      }
      if (body === false) {
        const result = new Response(
          JSON.stringify({ error: "Request body too large" }),
          {
            status: 413,
            headers: {
              "Content-Type": "application/json; charset=utf-8",
              "Cache-Control": "private, no-store, max-age=0",
              "CDN-Cache-Control": "no-store",
              "Vercel-CDN-Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            },
          },
        );
        return sendResult(response, result);
      }
    }

    const headers = new Headers();
    for (const name of [
      "authorization",
      "content-type",
      "x-madhouse-allow-mutations",
      "x-madhouse-snapshot-only",
      "x-madhouse-snapshot-refresh",
      "x-cargohustle-dev-key",
    ]) {
      const value = request.headers?.[name];
      if (typeof value === "string") headers.set(name, value);
    }
    const result = await transport(
      new Request("https://wiki.invalid" + url, {
        method,
        headers,
        ...(body?.byteLength ? { body } : {}),
      }),
    );
    return sendResult(response, result);
  };
}

export default createProxy();
