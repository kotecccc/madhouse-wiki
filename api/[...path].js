import { readFileSync } from "node:fs";

const contract = JSON.parse(
  readFileSync(
    new URL("../public/api-docs/openapi.readonly.json", import.meta.url),
    "utf8",
  ),
);
const routes = Object.entries(contract.paths)
  .filter(([, operation]) => operation.get)
  .map(
    ([path]) =>
      new RegExp(
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
      ),
  );

export function createProxy(fetcher = fetch) {
  return async (request, response) => {
    response.setHeader("Cache-Control", "private, no-store, max-age=0");
    response.setHeader("CDN-Cache-Control", "no-store");
    response.setHeader("Vercel-CDN-Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    const fail = (status, message) => {
      response.statusCode = status;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.end(JSON.stringify({ error: message }));
    };
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET");
      return fail(405, "Only GET requests are supported");
    }
    // Reject ambiguous paths before URL normalization; no arbitrary destinations.
    const raw = request.url || "";
    if (
      !raw.startsWith("/api/") ||
      /[%\\#]/.test(raw.split("?")[0]) ||
      raw.length > 4096
    )
      return fail(404, "Unknown API route");
    const url = new URL(raw, "https://cargohustle.online");
    if (!routes.some((route) => route.test(url.pathname)))
      return fail(404, "Unknown API route");
    const authorization = request.headers.authorization;
    if (
      typeof authorization !== "string" ||
      !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization)
    )
      return fail(401, "A game session is required");
    try {
      const upstream = await fetcher(url.href, {
        method: "GET",
        headers: { Authorization: authorization, Accept: "application/json" },
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(20000),
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      if (body.length > 4 * 1024 * 1024)
        return fail(502, "Upstream response too large");
      response.statusCode = upstream.status;
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      if (upstream.status === 429) {
        const retry = upstream.headers.get("retry-after");
        if (retry && /^\d+$/.test(retry))
          response.setHeader("Retry-After", retry);
      }
      response.end(body);
    } catch {
      return fail(502, "Game API is temporarily unavailable");
    }
  };
}

export default createProxy();
