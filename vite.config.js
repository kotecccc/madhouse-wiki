import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { installCatalogueCapture } from "./scripts/catalogue/proxy-capture.mjs";

function redirectApiDocs(server) {
  server.middlewares.use((request, response, next) => {
    const [path, query] = (request.url || "").split("?");
    if (path !== "/api-docs" && path !== "/api-docs/") return next();
    response.writeHead(302, {
      Location: `/api-docs/index.html${query ? `?${query}` : ""}`,
    });
    response.end();
  });
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "api-docs-entry",
      configureServer: redirectApiDocs,
      configurePreviewServer: redirectApiDocs,
    },
  ],
  server: {
    // Keep the dev URL stable so the browser's HMR WebSocket uses this origin.
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
    proxy: {
      "^/api/": {
        target: "https://cargohustle.online",
        changeOrigin: true,
        secure: true,
        configure(proxy) {
          installCatalogueCapture(proxy, fileURLToPath(new URL(".", import.meta.url)));
        },
      },
    },
  },
  // Preview serves the built output and intentionally has no HMR.
  preview: {
    host: "127.0.0.1",
    port: 4175,
    strictPort: true,
  },
});
