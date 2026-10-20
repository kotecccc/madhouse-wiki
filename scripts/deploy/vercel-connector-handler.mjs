import { createConnectorApi } from "../../connector/game-auth-api.js";
import { connectorHeaders } from "../../connector/worker.js";

// Node transport only; the shared API owns validation and auth behavior.
export function createVercelConnectorHandler({
  wikiOrigin,
  connectorOrigin,
  endpoint,
  appParams = () => ({
    apiId: process.env.TELEGRAM_API_ID,
    apiHash: process.env.TELEGRAM_API_HASH,
  }),
  fetcher = fetch,
}) {
  const security = connectorHeaders([wikiOrigin]);
  const api = createConnectorApi({
    appParams,
    wikiOrigins: [wikiOrigin],
    fetcher,
  });
  return async (request, response) => {
    let result;
    try {
      const query = new URL(request.url || "/", connectorOrigin).search;
      const headers = new Headers();
      for (const name of ["content-type", "origin"])
        if (typeof request.headers[name] === "string")
          headers.set(name, request.headers[name]);
      let body;
      if (!["GET", "HEAD"].includes(request.method)) {
        if (request.body !== undefined) {
          body =
            typeof request.body === "string" || Buffer.isBuffer(request.body)
              ? request.body
              : JSON.stringify(request.body);
        } else {
          const chunks = [];
          let size = 0;
          for await (const chunk of request) {
            size += Buffer.byteLength(chunk);
            if (size > 16384) throw new RangeError("request-too-large");
            chunks.push(Buffer.from(chunk));
          }
          body = Buffer.concat(chunks);
        }
        if (Buffer.byteLength(body) > 16384)
          throw new RangeError("request-too-large");
      }
      result = await api(
        new Request(connectorOrigin + endpoint + query, {
          method: request.method,
          headers,
          body,
        }),
      );
    } catch (error) {
      result = new Response(
        JSON.stringify({
          error:
            error instanceof RangeError
              ? "invalid_request"
              : "connection_unavailable",
        }),
        {
          status: error instanceof RangeError ? 400 : 503,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "private, no-store, max-age=0",
            "CDN-Cache-Control": "no-store",
          },
        },
      );
    }
    response.statusCode = result.status;
    for (const [key, value] of result.headers) response.setHeader(key, value);
    for (const [key, value] of Object.entries(security))
      response.setHeader(key, value);
    response.setHeader("Vercel-CDN-Cache-Control", "no-store");
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}
