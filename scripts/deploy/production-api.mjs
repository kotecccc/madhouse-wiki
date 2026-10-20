// Shared Fetch API transport for Vercel and the Sites Worker. No disk, sessions,
// response logging, arbitrary origins, cookies, writes or private cache entries.
export function createProductionApi(paths, fetcher = fetch) {
  const routes = paths.map(
    (path) =>
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
    if (request.method !== "GET")
      return fail(405, "Only GET requests are supported", { Allow: "GET" });
    const url = new URL(request.url);
    if (
      /[%\\#]/.test(url.pathname.replace(/%24/gi, "$")) ||
      url.href.length > 4096 ||
      !routes.some((route) => route.test(url.pathname.replace(/%24/gi, "$")))
    )
      return fail(404, "Unknown API route");
    const authorization = request.headers.get("authorization");
    if (!authorization || !/^Bearer [A-Za-z0-9._~-]+$/.test(authorization))
      return fail(401, "A game session is required");
    try {
      const upstream = await fetcher(
        "https://cargohustle.online" + url.pathname + url.search,
        {
          method: "GET",
          headers: { Authorization: authorization, Accept: "application/json" },
          redirect: "error",
          cache: "no-store",
          signal: AbortSignal.timeout(20000),
        },
      );
      const body = await upstream.arrayBuffer();
      if (body.byteLength > 4 * 1024 * 1024)
        return fail(502, "Upstream response too large");
      if (upstream.status === 429) {
        const retry = upstream.headers.get("retry-after");
        if (retry && /^\d+$/.test(retry)) headers["Retry-After"] = retry;
      }
      return new Response(
        [204, 205, 304].includes(upstream.status) ? null : body,
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
