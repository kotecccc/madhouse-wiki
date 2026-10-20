import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createConnectorApi } from "./game-auth-api.js";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  cacheDir: fileURLToPath(new URL("node_modules/.vite", import.meta.url)),
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [
    react(),
    {
      name: "isolated-connection-api",
      configureServer(server) {
        const api = createConnectorApi({
          appParams: async () =>
            process.env.MADHOUSE_TELEGRAM_APP_FILE
              ? JSON.parse(
                  await readFile(
                    process.env.MADHOUSE_TELEGRAM_APP_FILE,
                    "utf8",
                  ),
                )
              : {},
          wikiOrigins: ["http://127.0.0.1:4174"],
        });
        server.middlewares.use(async (req, res, next) => {
          if (!req.url?.startsWith("/api/")) return next();
          try {
            const parts = [];
            let size = 0;
            for await (const part of req) {
              size += part.length;
              if (size > 16384) {
                res.statusCode = 413;
                res.end();
                return;
              }
              parts.push(part);
            }
            const response = await api(
              new Request("http://127.0.0.1:4199" + req.url, {
                method: req.method,
                headers: req.headers,
                body: ["GET", "HEAD"].includes(req.method)
                  ? undefined
                  : Buffer.concat(parts),
              }),
            );
            res.writeHead(
              response.status,
              Object.fromEntries(response.headers),
            );
            res.end(Buffer.from(await response.arrayBuffer()));
          } catch {
            res.statusCode = 503;
            res.setHeader("Cache-Control", "no-store");
            res.end('{"error":"connection_unavailable"}');
          }
        });
      },
    },
  ],
  optimizeDeps: { exclude: ["@mtcute/wasm"] },
  server: {
    host: "127.0.0.1",
    port: 4199,
    strictPort: true,
    fs: { allow: [fileURLToPath(new URL("..", import.meta.url))] },
  },
  build: { outDir: "dist", emptyOutDir: true },
});
