import { gunzipSync, brotliDecompressSync, inflateSync } from "node:zlib";
import { CatalogueStore, catalogueRoute } from "./store.mjs";

export function installCatalogueCapture(
  proxy,
  root,
  { createStore = (directory) => new CatalogueStore(directory) } = {},
) {
  // A long-lived WAL writer can retain stale shared-memory/file handles across
  // Docker Desktop bind-mount changes. Keep the connection local to a capture.
  let initialized = false;
  const capture = (path, status, value) => {
    let store;
    try {
      store = createStore(root);
      if (!initialized) {
        store.initialize();
        initialized = true;
      }
      store.capture(path, status, value);
    } catch {
      // Do not expose response bodies or exception messages in diagnostics.
      console.error("[catalogue] Reference capture failed:", path);
    } finally {
      store?.close();
    }
  };
  // Ordinary Wiki navigation captures only the requested reference projection.
  // Bulk import is an explicit operation, never a side effect of /api/floors.
  const onResponse = (upstream, request) => {
    if (request.method !== "GET") return;
    const path = catalogueRoute(request.url);
    if (!path) return;
    const status = upstream.statusCode ?? 0;
    if (status !== 200) {
      capture(path, status, null);
      return;
    }
    if (!String(upstream.headers["content-type"] ?? "").includes("json"))
      return;
    const chunks = [];
    let size = 0;
    const maxBytes = 16 * 1024 * 1024;
    upstream.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBytes) chunks.push(chunk);
    });
    upstream.on("end", () => {
      if (size > maxBytes) {
        capture(path, 413, null);
        return;
      }
      try {
        let data = Buffer.concat(chunks);
        const encoding = upstream.headers["content-encoding"];
        if (encoding === "gzip") data = gunzipSync(data);
        else if (encoding === "br") data = brotliDecompressSync(data);
        else if (encoding === "deflate") data = inflateSync(data);
        const value = JSON.parse(data.toString("utf8"));
        capture(path, status, value);
      } catch {
        // Never log response bodies or exception messages: both can contain account data.
        console.error("[catalogue] Reference capture failed:", path);
      }
    });
  };
  proxy.on("proxyRes", onResponse);
  return { close: () => proxy.off("proxyRes", onResponse) };
}
