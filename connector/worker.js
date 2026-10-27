import { createConnectorApi } from "./game-auth-api.js";

export const TELEGRAM_WEBSOCKETS = [
  "pluto",
  "venus",
  "aurora",
  "vesta",
  "flora",
].map((host) => `wss://${host}.web.telegram.org`);

export function connectorHeaders(wikiOrigins) {
  return {
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self'",
      "img-src 'self' data:",
      "font-src 'self'",
      "connect-src 'self' " + TELEGRAM_WEBSOCKETS.join(" "),
      "base-uri 'none'",
      "form-action 'self'",
      "object-src 'none'",
      "worker-src 'none'",
      // Telegram Web is an ancestor, never a source of connector commands.
      "frame-ancestors " +
        [...wikiOrigins, "https://web.telegram.org"].join(" "),
    ].join("; "),
  };
}

export function createConnectorWorker(assets, wikiOrigins) {
  const security = connectorHeaders(wikiOrigins);
  return {
    async fetch(request, env = {}) {
      let response;
      try {
        const url = new URL(request.url);
        if (url.pathname.startsWith("/api/")) {
          const api = createConnectorApi({
            appParams: () => ({
              apiId: env.TELEGRAM_API_ID,
              apiHash: env.TELEGRAM_API_HASH,
            }),
            wikiOrigins,
            wikiVerificationKey: env.WIKI_INITDATA_KEY,
          });
          response = await api(request);
        } else if (!["GET", "HEAD"].includes(request.method))
          response = new Response("Method not allowed", { status: 405 });
        else {
          const file =
            assets[url.pathname === "/" ? "/index.html" : url.pathname];
          response = file
            ? new Response(
                request.method === "HEAD"
                  ? null
                  : Uint8Array.from(atob(file.body), (character) =>
                      character.charCodeAt(0),
                    ),
                {
                  headers: {
                    "Content-Type": file.type,
                    "Cache-Control": url.pathname.startsWith("/assets/")
                      ? "public, max-age=31536000, immutable"
                      : "no-cache",
                  },
                },
              )
            : new Response("Not found", { status: 404 });
        }
      } catch {
        response = new Response('{"error":"connection_unavailable"}', {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          },
        });
      }
      const headers = new Headers(response.headers);
      for (const [key, value] of Object.entries(security))
        headers.set(key, value);
      return new Response(response.body, { status: response.status, headers });
    },
  };
}
