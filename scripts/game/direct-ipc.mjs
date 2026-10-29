import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";

const IPC_PATH = "/internal/game/direct";
const GAME_ORIGIN = "https://cargohustle.online";
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_REQUEST_ENVELOPE_BYTES = 3 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 16 * 1024;
const MAX_HEADER_COUNT = 32;
const MAX_CLOCK_SKEW_MS = 60_000;
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const REQUEST_HEADERS = new Set([
  "accept",
  "authorization",
  "content-type",
  "if-match",
  "if-none-match",
]);
const RESPONSE_HEADERS = new Set([
  "content-type",
  "retry-after",
  "etag",
  "last-modified",
  "cache-control",
]);
const FIXED_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const encoder = new TextEncoder();
const error = (code, dispatched = "unknown") =>
  Object.assign(new Error(code), {
    code,
    dispatched,
    ...(dispatched === "notDispatched" ? { notDispatched: true } : {}),
  });

function secretBytes(secret) {
  const bytes = Buffer.isBuffer(secret)
    ? Buffer.from(secret)
    : Buffer.from(String(secret ?? ""));
  if (bytes.length < 32) throw new TypeError("direct_ipc_secret_too_short");
  return bytes;
}

function signature(secret, timestamp, nonce, bytes) {
  return createHmac("sha256", secret)
    .update("madhouse-direct-game-ipc-v1\n")
    .update(timestamp)
    .update("\n")
    .update(nonce)
    .update("\n")
    .update(bytes)
    .digest("hex");
}

function safeEqualHex(actual, expected) {
  if (!/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(
    Buffer.from(actual, "hex"),
    Buffer.from(expected, "hex"),
  );
}

function validUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw error("invalid_game_url", "notDispatched");
  }
  const allowedRoute =
    (url.pathname === "/api/auth/telegram" && url.search === "") ||
    (url.pathname === "/api/me" && url.search === "");
  if (
    url.origin !== GAME_ORIGIN ||
    !allowedRoute ||
    url.username ||
    url.password ||
    url.hash
  )
    throw error("invalid_game_url", "notDispatched");
  return url.href;
}

function collectHeaders(input, allowlist) {
  const headers = new Headers(input);
  const output = [];
  let total = 0;
  for (const [name, value] of headers) {
    if (!allowlist.has(name))
      throw error("unsupported_game_header", "notDispatched");
    total += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
    output.push([name, value]);
  }
  if (output.length > MAX_HEADER_COUNT || total > MAX_HEADER_BYTES)
    throw error("game_headers_too_large", "notDispatched");
  return output;
}

async function readLimited(stream, maxBytes, dispatched = "unknown") {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw error("ipc_body_too_large", dispatched);
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, size);
  } catch (caught) {
    if (caught?.code) throw caught;
    throw error("ipc_body_read_failed", dispatched);
  }
}

function toFetchBody(body) {
  if (body == null) return null;
  if (typeof body === "string") return Buffer.from(body);
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array)
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw error("unsupported_game_body", "notDispatched");
}

function filterHeaders(input, allowlist) {
  const headers = new Headers(input);
  const output = [];
  let total = 0;
  for (const [name, value] of headers) {
    if (!allowlist.has(name)) continue;
    total += encoder.encode(name).byteLength + encoder.encode(value).byteLength;
    if (total > MAX_HEADER_BYTES) throw error("game_headers_too_large");
    output.push([name, value]);
  }
  return output;
}

function statusCanHaveBody(status) {
  return status !== 204 && status !== 205 && status !== 304;
}

// This is only a signed claim. The Wiki must also check and atomically claim
// the corresponding owner lease immediately before the physical request.
function validBootstrap(value, pathname, method, attempt, headers, body) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "attempt,credentialDigest,leaseId,owner,step" ||
    !/^[1-9][0-9]{0,15}$/.test(value.owner || "") ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.leaseId || "",
    ) ||
    value.attempt !== attempt
  )
    return false;
  if (value.step === "telegram_auth") {
    if (
      pathname !== "/api/auth/telegram" ||
      method !== "POST" ||
      attempt !== 1 ||
      value.credentialDigest !== null ||
      !body
    )
      return false;
    try {
      const parsed = JSON.parse(Buffer.from(body).toString("utf8"));
      if (
        !parsed ||
        Object.keys(parsed).join(",") !== "initData" ||
        typeof parsed.initData !== "string"
      )
        return false;
      const params = new URLSearchParams(parsed.initData);
      if (params.getAll("user").length !== 1) return false;
      const user = JSON.parse(params.get("user"));
      return Number.isSafeInteger(user?.id) && String(user.id) === value.owner;
    } catch {
      return false;
    }
  }
  const authorization = new Headers(headers).get("authorization");
  return (
    value.step === "profile" &&
    pathname === "/api/me" &&
    method === "GET" &&
    attempt >= 1 &&
    attempt <= 3 &&
    !body?.byteLength &&
    typeof authorization === "string" &&
    /^Bearer [A-Za-z0-9._~-]+$/.test(authorization) &&
    /^[a-f0-9]{64}$/.test(value.credentialDigest || "") &&
    createHash("sha256").update(authorization).digest("hex") ===
      value.credentialDigest
  );
}

/** Create a Fetch handler for the authenticated internal game executor endpoint. */
export function createDirectGameIpcHandler({
  execute,
  secret,
  now = Date.now,
} = {}) {
  if (typeof execute !== "function")
    throw new TypeError("direct_ipc_executor_required");
  const key = secretBytes(secret);
  const nonces = new Map();
  const reply = (status, body) =>
    new Response(Buffer.from(JSON.stringify(body)), {
      status,
      headers: FIXED_HEADERS,
    });

  return async (request) => {
    if (request.method !== "POST") return reply(404, { error: "not_found" });
    let endpoint;
    try {
      endpoint = new URL(request.url);
    } catch {
      return reply(404, { error: "not_found" });
    }
    if (endpoint.pathname !== IPC_PATH || endpoint.search || endpoint.hash)
      return reply(404, { error: "not_found" });

    const timestamp = request.headers.get("x-direct-ipc-time") || "";
    const nonce = request.headers.get("x-direct-ipc-nonce") || "";
    const auth = request.headers.get("x-direct-ipc-signature") || "";
    const parsedTimestamp = Number(timestamp);
    const current = now();
    if (
      !/^[0-9]{13}$/.test(timestamp) ||
      !Number.isSafeInteger(parsedTimestamp) ||
      !Number.isSafeInteger(current) ||
      Math.abs(current - parsedTimestamp) > MAX_CLOCK_SKEW_MS ||
      !/^[a-f0-9]{32}$/.test(nonce)
    )
      return reply(401, { error: "unauthorized" });
    let bytes;
    try {
      bytes = await readLimited(
        request.body,
        MAX_REQUEST_ENVELOPE_BYTES,
        "notDispatched",
      );
    } catch {
      return reply(413, { error: "invalid_request" });
    }
    if (!safeEqualHex(auth, signature(key, timestamp, nonce, bytes)))
      return reply(401, { error: "unauthorized" });

    for (const [storedNonce, expiry] of nonces)
      if (expiry <= current) nonces.delete(storedNonce);
    if (nonces.has(nonce)) return reply(409, { error: "request_replayed" });
    if (nonces.size >= 10000) return reply(503, { error: "ipc_unavailable" });
    nonces.set(nonce, parsedTimestamp + MAX_CLOCK_SKEW_MS);

    let payload;
    try {
      payload = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (!payload || typeof payload !== "object" || Array.isArray(payload))
        throw new Error();
      const keys = Object.keys(payload).sort().join(",");
      if (
        keys !== "attempt,binding,body,headers,method,redirect,url" &&
        keys !== "attempt,binding,body,bootstrap,headers,method,redirect,url"
      )
        throw new Error();
      const url = validUrl(payload.url);
      const method = payload.method;
      if (typeof method !== "string" || !METHODS.has(method)) throw new Error();
      const pathname = new URL(url).pathname;
      if (
        (pathname === "/api/me" && method !== "GET") ||
        (pathname === "/api/auth/telegram" && method !== "POST")
      )
        throw new Error();
      if (payload.redirect !== "manual" && payload.redirect !== "error")
        throw new Error();
      if (
        !Number.isSafeInteger(payload.attempt) ||
        payload.attempt < 1 ||
        payload.attempt > 10
      )
        throw new Error();
      const headers = collectHeaders(payload.headers, REQUEST_HEADERS);
      if (
        payload.binding !== null &&
        (!payload.binding ||
          Object.keys(payload.binding).sort().join(",") !==
            "accountPath,revision" ||
          !/^accounts\/[a-f0-9]{64}\.json$/.test(
            payload.binding.accountPath || "",
          ) ||
          !/^[a-f0-9-]{36}$/i.test(payload.binding.revision || "") ||
          pathname !== "/api/me")
      )
        throw new Error();
      if (typeof payload.body !== "string" && payload.body !== null)
        throw new Error();
      const requestBody =
        payload.body === null ? null : Buffer.from(payload.body, "base64");
      if (requestBody && requestBody.toString("base64") !== payload.body)
        throw new Error();
      if (requestBody?.byteLength > MAX_REQUEST_BYTES) throw new Error();
      if (method === "GET" && requestBody?.byteLength) throw new Error();
      if (
        payload.bootstrap != null &&
        !validBootstrap(
          payload.bootstrap,
          pathname,
          method,
          payload.attempt,
          headers,
          requestBody,
        )
      )
        throw new Error();
      const response = await execute(url, {
        method,
        headers,
        body: requestBody?.byteLength ? requestBody : undefined,
        redirect: payload.redirect,
        signal: request.signal,
        gameBinding: payload.binding,
        gameAttempt: payload.attempt,
        ...(payload.bootstrap ? { gameBootstrap: payload.bootstrap } : {}),
      });
      if (
        !response ||
        !Number.isInteger(response.status) ||
        response.status < 200 ||
        response.status > 599
      )
        throw error("game_executor_invalid_response");
      const responseHeaders = filterHeaders(response.headers, RESPONSE_HEADERS);
      const responseBody = statusCanHaveBody(response.status)
        ? await readLimited(response.body, MAX_RESPONSE_BYTES)
        : Buffer.alloc(0);
      return new Response(
        Buffer.from(
          JSON.stringify({
            status: response.status,
            headers: responseHeaders,
            body: responseBody.toString("base64"),
          }),
        ),
        { status: 200, headers: FIXED_HEADERS },
      );
    } catch (caught) {
      // An authenticated request may already have reached the game. Keep that ambiguity explicit.
      if (caught?.notDispatched === true)
        return reply(409, { error: "not_dispatched" });
      if (caught?.dispatched === "notDispatched")
        return reply(400, { error: "invalid_request" });
      return reply(502, { error: "game_result_unknown" });
    }
  };
}

/** Fetch-compatible client for the internal executor. It never retries or falls back locally. */
export function createDirectGameIpcClient({
  endpoint,
  secret,
  fetcher = fetch,
} = {}) {
  const key = secretBytes(secret);
  let endpointUrl;
  try {
    endpointUrl = new URL(endpoint);
  } catch {
    throw new TypeError("invalid_direct_ipc_endpoint");
  }
  if (
    endpointUrl.protocol !== "http:" ||
    endpointUrl.hostname !== "wiki" ||
    endpointUrl.port !== "9095" ||
    endpointUrl.username ||
    endpointUrl.password ||
    endpointUrl.search ||
    endpointUrl.hash ||
    endpointUrl.pathname !== IPC_PATH ||
    typeof fetcher !== "function"
  )
    throw new TypeError("invalid_direct_ipc_endpoint");

  return async function directGameFetch(input, init = {}) {
    const requestedUrl =
      typeof input === "string" || input instanceof URL ? input : input?.url;
    const url = validUrl(String(requestedUrl));
    const method = String(
      init.method ||
        (typeof input === "object" ? input.method : "GET") ||
        "GET",
    ).toUpperCase();
    if (!METHODS.has(method))
      throw error("unsupported_game_method", "notDispatched");
    const requestedPath = new URL(url).pathname;
    if (
      (requestedPath === "/api/me" && method !== "GET") ||
      (requestedPath === "/api/auth/telegram" && method !== "POST")
    )
      throw error("unsupported_game_operation", "notDispatched");
    const redirect = init.redirect || "manual";
    if (redirect !== "manual" && redirect !== "error")
      throw error("game_redirects_not_supported", "notDispatched");
    if (init.signal?.aborted)
      throw error("game_request_cancelled", "notDispatched");
    const headers = collectHeaders(
      init.headers || (typeof input === "object" ? input.headers : undefined),
      REQUEST_HEADERS,
    );
    const body = toFetchBody(init.body);
    if (method === "GET" && body?.byteLength)
      throw error("get_body_not_supported", "notDispatched");
    if (body?.byteLength > MAX_REQUEST_BYTES)
      throw error("game_request_too_large", "notDispatched");
    const attempt = init.gameAttempt || 1;
    if (
      init.gameBootstrap != null &&
      !validBootstrap(
        init.gameBootstrap,
        requestedPath,
        method,
        attempt,
        headers,
        body,
      )
    )
      throw error("invalid_game_bootstrap", "notDispatched");
    const payload = Buffer.from(
      JSON.stringify({
        url,
        method,
        headers,
        redirect,
        binding: init.gameBinding || null,
        attempt,
        ...(init.gameBootstrap ? { bootstrap: init.gameBootstrap } : {}),
        body: body?.byteLength ? body.toString("base64") : null,
      }),
    );
    if (payload.byteLength > MAX_REQUEST_ENVELOPE_BYTES)
      throw error("game_request_too_large", "notDispatched");
    const timestamp = String(Date.now());
    const nonce = Buffer.from(cryptoRandomBytes(16)).toString("hex");
    let response;
    try {
      response = await fetcher(endpointUrl, {
        method: "POST",
        redirect: "manual",
        signal: init.signal,
        headers: {
          "Content-Type": "application/json",
          "X-Direct-Ipc-Time": timestamp,
          "X-Direct-Ipc-Nonce": nonce,
          "X-Direct-Ipc-Signature": signature(key, timestamp, nonce, payload),
        },
        body: payload,
      });
    } catch {
      throw error("game_result_unknown");
    }
    if (response?.status === 409) {
      const failure = await response.json().catch(() => null);
      if (failure?.error === "not_dispatched")
        throw error("game_not_dispatched", "notDispatched");
    }
    if (!response || response.status !== 200)
      throw error("game_result_unknown");
    let envelope;
    try {
      const bytes = await readLimited(
        response.body,
        Math.ceil((MAX_RESPONSE_BYTES * 4) / 3) + MAX_HEADER_BYTES + 4096,
      );
      envelope = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (
        !envelope ||
        Object.keys(envelope).sort().join(",") !== "body,headers,status"
      )
        throw new Error();
      if (
        !Number.isInteger(envelope.status) ||
        envelope.status < 200 ||
        envelope.status > 599
      )
        throw new Error();
      if (typeof envelope.body !== "string") throw new Error();
      const responseBody = Buffer.from(envelope.body, "base64");
      if (
        responseBody.toString("base64") !== envelope.body ||
        responseBody.byteLength > MAX_RESPONSE_BYTES
      )
        throw new Error();
      const responseHeaders = filterHeaders(envelope.headers, RESPONSE_HEADERS);
      return new Response(
        statusCanHaveBody(envelope.status) ? responseBody : null,
        {
          status: envelope.status,
          headers: responseHeaders,
        },
      );
    } catch {
      throw error("game_result_unknown");
    }
  };
}

function cryptoRandomBytes(size) {
  return randomBytes(size);
}

/** Create a Node HTTP server; the caller owns binding it to an internal interface. */
export function createDirectGameIpcServer({ execute, secret } = {}) {
  const handler = createDirectGameIpcHandler({ execute, secret });
  return createServer(async (incoming, outgoing) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    incoming.once("aborted", abort);
    incoming.socket.once("close", abort);
    outgoing.once("close", () => {
      if (!outgoing.writableEnded) abort();
    });
    let size = 0;
    const chunks = [];
    try {
      for await (const chunk of incoming) {
        size += chunk.byteLength;
        if (size > MAX_REQUEST_ENVELOPE_BYTES) {
          outgoing.statusCode = 413;
          outgoing.end();
          incoming.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      if (controller.signal.aborted) return;
      const body = Buffer.concat(chunks, size);
      const request = new Request(`http://wiki${incoming.url || "/"}`, {
        method: incoming.method,
        headers: incoming.headers,
        body:
          incoming.method === "POST"
            ? Readable.toWeb(Readable.from([body]))
            : undefined,
        signal: controller.signal,
        duplex: incoming.method === "POST" ? "half" : undefined,
      });
      const response = await handler(request);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return outgoing.end();
      for await (const chunk of response.body) {
        if (!outgoing.write(chunk))
          await new Promise((resolve) => outgoing.once("drain", resolve));
      }
      outgoing.end();
    } catch {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.statusCode = 502;
        outgoing.end();
      } else if (!outgoing.destroyed) {
        outgoing.destroy();
      }
    }
  });
}
