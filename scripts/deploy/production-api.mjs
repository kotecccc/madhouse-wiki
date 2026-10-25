// Shared Vercel/Sites transport; only documented routes reach the fixed origin.
export const API_MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function routePattern(path) {
  return new RegExp(
    "^" +
      path
        .split(/(\{[^}]+\})/)
        .map((part) =>
          part.startsWith("{")
            ? "[A-Za-z0-9_$-]+"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("") +
      "$",
  );
}

function normalizeOperations(operations) {
  return operations.map((operation) => {
    // Keep the original string form as a GET-only compatibility path for
    // small consumers that construct the transport directly.
    const route =
      typeof operation === "string"
        ? { method: "GET", path: operation, requiresAuth: true }
        : operation;
    return {
      method: String(route.method || "GET").toUpperCase(),
      path: route.path,
      requiresAuth: route.requiresAuth !== false,
      allowsDevKey: route.allowsDevKey === true,
      regex: routePattern(route.path),
    };
  });
}

async function readLimitedBody(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > API_MAX_REQUEST_BYTES) {
      await reader.cancel();
      return false;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function createProductionApi(operations, fetcher = fetch) {
  const routes = normalizeOperations(operations);
  return async (request) => {
    const headers = {
      "Cache-Control": "private, no-store, max-age=0",
      "CDN-Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Type": "application/json; charset=utf-8",
    };
    const fail = (status, error, extra = {}) =>
      new Response(JSON.stringify({ error }), {
        status,
        headers: { ...headers, ...extra },
      });

    const method = (request.method || "GET").toUpperCase();
    const url = new URL(request.url);
    if (
      /[%\\#]/.test(url.pathname.replace(/%24/gi, "$")) ||
      url.href.length > 4096
    )
      return fail(404, "Unknown API route");

    const path = url.pathname.replace(/%24/gi, "$");
    const matchingPath = routes.filter((route) => route.regex.test(path));
    if (!matchingPath.length) return fail(404, "Unknown API route");
    const matchingRoute = matchingPath.find((route) => route.method === method);
    if (!matchingRoute) {
      const allowed = [...new Set(matchingPath.map((route) => route.method))]
        .sort()
        .join(", ");
      return fail(405, "Method is not documented for this route", {
        Allow: allowed,
      });
    }

    if (
      MUTATION_METHODS.has(method) &&
      request.headers.get("x-madhouse-allow-mutations") !== "true"
    )
      return fail(
        403,
        "State-changing requests require X-Madhouse-Allow-Mutations: true",
      );

    const authorization = request.headers.get("authorization");
    if (
      matchingRoute.requiresAuth &&
      (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))
    )
      return fail(401, "A game session is required");
    if (
      !matchingRoute.requiresAuth &&
      authorization &&
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return fail(401, "Invalid game session");

    let body = null;
    if (method !== "GET" && method !== "HEAD") {
      const contentLength = Number(request.headers.get("content-length"));
      if (
        Number.isFinite(contentLength) &&
        contentLength > API_MAX_REQUEST_BYTES
      )
        return fail(413, "Request body too large");
      try {
        body = await readLimitedBody(request);
      } catch {
        return fail(400, "Invalid request body");
      }
      if (body === false) return fail(413, "Request body too large");
      if (
        body?.byteLength &&
        !/^application\/json(?:\s*;|$)/i.test(
          request.headers.get("content-type") || "",
        )
      )
        return fail(415, "Only JSON request bodies are supported");
    }

    const upstreamHeaders = { Accept: "application/json" };
    if (authorization) upstreamHeaders.Authorization = authorization;
    if (body?.byteLength) upstreamHeaders["Content-Type"] = "application/json";
    if (matchingRoute.allowsDevKey) {
      const devKey = request.headers.get("x-cargohustle-dev-key");
      if (devKey) upstreamHeaders["X-CargoHustle-Dev-Key"] = devKey;
    }

    try {
      const upstream = await fetcher(
        "https://cargohustle.online" + url.pathname + url.search,
        {
          method,
          headers: upstreamHeaders,
          ...(body?.byteLength ? { body } : {}),
          redirect: "manual",
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
        },
      );
      if (upstream.status >= 300 && upstream.status < 400) {
        let redirectClass = "unclassified";
        try {
          const target = new URL(
            upstream.headers.get("location"),
            "https://cargohustle.online",
          );
          redirectClass =
            target.hostname === "cargohustle.online"
              ? "same-origin"
              : /(^|\.)ddos-guard\.(net|com|ru)$/.test(target.hostname)
                ? "ddos-protection"
                : "external-origin";
        } catch {
          /* No untrusted redirect text leaves this scope. */
        }
        // Manual mode NEVER follows a redirect or sends Bearer to its target.
        console.warn(
          "madhouse-api-transport",
          "upstream-redirect-rejected",
          redirectClass,
        );
        return fail(502, "Game API redirect rejected", {
          "X-Madhouse-Transport-Error": "upstream-redirect-rejected",
          "X-Madhouse-Redirect-Class": redirectClass,
          "X-Madhouse-Upstream-Status": String(upstream.status),
        });
      }
      for (const name of [
        "X-Madhouse-Game-Status",
        "X-Madhouse-Last-Success",
        "X-Madhouse-Section-Updated",
        "X-Madhouse-Snapshot",
      ]) {
        const value = upstream.headers.get(name);
        if (value) headers[name] = value;
      }
      const responseBody = await upstream.arrayBuffer();
      if (responseBody.byteLength > MAX_RESPONSE_BYTES)
        return fail(502, "Upstream response too large");
      if (upstream.status === 429) {
        const retry = upstream.headers.get("retry-after");
        if (retry && /^\d+$/.test(retry)) headers["Retry-After"] = retry;
      }
      return new Response(
        [204, 205, 304].includes(upstream.status) ? null : responseBody,
        { status: upstream.status, headers },
      );
    } catch (error) {
      // Log a fixed diagnostic enum only: never requests, tokens, URLs, bodies
      // or exception messages. This distinguishes runtime config from outage.
      const message = typeof error?.message === "string" ? error.message : "";
      const category = /cache|RequestInitializer/i.test(message)
        ? "unsupported-cache-option"
        : /AbortSignal|timeout.*not.*function/i.test(message)
          ? "unsupported-timeout-api"
          : ["TimeoutError", "AbortError"].includes(error?.name)
            ? "upstream-timeout"
            : /redirect/i.test(message)
              ? "upstream-redirect-rejected"
              : "upstream-network-failure";
      console.warn("madhouse-api-transport", category);
      return fail(502, "Game API is temporarily unavailable", {
        "X-Madhouse-Transport-Error": category,
      });
    }
  };
}
