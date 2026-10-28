import { isIP } from "node:net";

const allowed = new Set(["/api/bridge/device", "/api/bridge/redeem"]);
const maxBody = 8192;

/** Node HTTP adapter; uses the socket peer only, never forwarded client headers. */
export function createBridgeNodeAdapter({ runtime, origin } = {}) {
  if (
    typeof runtime?.handle !== "function" ||
    typeof runtime?.upgrade !== "function"
  )
    throw new TypeError("bridge_runtime_required");
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin)
    throw new TypeError("invalid_bridge_origin");

  async function handle(request, response) {
    try {
      if (!allowed.has(request.url)) {
        response.writeHead(404, { "Cache-Control": "no-store" });
        response.end();
        return;
      }
      const peer = request.socket.remoteAddress || "";
      if (!isIP(peer)) throw new Error("invalid_peer");
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > maxBody) {
          response.writeHead(413, { "Cache-Control": "no-store" });
          response.end();
          return;
        }
        chunks.push(chunk);
      }
      const headers = new Headers();
      for (const name of ["content-type", "origin"]) {
        const value = request.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const method = request.method || "GET";
      const result = await runtime.handle(
        new Request(origin + request.url, {
          method,
          headers,
          ...(!["GET", "HEAD"].includes(method)
            ? { body: Buffer.concat(chunks) }
            : {}),
        }),
        peer,
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
  }
  function upgrade(request, socket, head) {
    const peer = request.socket.remoteAddress || "";
    if (request.url !== "/bridge/data" || !isIP(peer)) {
      socket.destroy();
      return;
    }
    void runtime.upgrade(request, socket, head, peer);
  }
  return Object.freeze({ handle, upgrade });
}
