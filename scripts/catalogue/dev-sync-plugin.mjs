import { resolve } from "node:path";
import { createCatalogueSyncApi } from "./sync-api.mjs";

export function catalogueSyncPlugin(root) {
  const database = resolve(root, "local-data/madhouse.sqlite");
  const storeBlob = {
    async download() {
      return { directory: null, file: database, etag: "local", mutable: true };
    },
    async upload() {},
  };
  const api = createCatalogueSyncApi({ root, storeBlob });
  const middleware = (request, response, next) => {
    const path = (request.url || "").split("?")[0];
    if (path !== "/api/catalogue") return next();
    (async () => {
      const method = request.method || "GET";
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, value] of Object.entries(request.headers))
        if (typeof value === "string") headers.set(key, value);
      const input = new Request(new URL(request.url, "http://localhost"), {
        method,
        headers,
        ...(chunks.length && method !== "GET"
          ? { body: Buffer.concat(chunks) }
          : {}),
      });
      const result = await api(input);
      response.statusCode = result.status;
      for (const [key, value] of result.headers) response.setHeader(key, value);
      response.end(Buffer.from(await result.arrayBuffer()));
    })().catch(() => {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "catalogue_sync_unavailable" }));
    });
  };
  return {
    name: "catalogue-session-sync",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
