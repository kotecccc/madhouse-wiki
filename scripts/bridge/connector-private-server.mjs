import { createServer } from "node:http";

/**
 * Dedicated container-network listener; never publish this port or proxy it from
 * public Nginx. `handle` authenticates each request with the private IPC key.
 */
export function createConnectorPrivateServer({ handle } = {}) {
  if (typeof handle !== "function")
    throw new TypeError("connector_ipc_handler_required");
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== "POST" ||
        request.url !== "/internal/bridge/connector-lease"
      ) {
        response.writeHead(404, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const part of request) {
        size += part.length;
        if (size > 2048) {
          response.writeHead(413);
          response.end();
          return;
        }
        chunks.push(part);
      }
      const headers = new Headers();
      for (const name of [
        "content-type",
        "x-bridge-time",
        "x-bridge-nonce",
        "x-bridge-signature",
      ]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const result = await handle(
        new Request("http://wiki:9094/internal/bridge/connector-lease", {
          method: "POST",
          headers,
          body: Buffer.concat(chunks),
        }),
        true,
      );
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      if (response.headersSent) response.destroy();
      else {
        response.writeHead(503, { "Cache-Control": "no-store" });
        response.end();
      }
    }
  });
  server.requestTimeout = 10_000;
  server.headersTimeout = 5_000;
  return server;
}
