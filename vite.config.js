import {
  devServerOptions,
  dockerSourceHmrPlugin,
} from "./scripts/dev/vite-server.mjs";
import { automationPlugin } from "./scripts/automation/runtime.mjs";
import { authSessionPlugin } from "./scripts/auth-session-plugin.mjs";
import { cataloguePlugin } from "./scripts/catalogue/vite-plugin.mjs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { installCatalogueCapture } from "./scripts/catalogue/proxy-capture.mjs";
import { raidsFixturePlugin } from "./scripts/raids-fixture-plugin.mjs";
import { catalogueSyncPlugin } from "./scripts/catalogue/dev-sync-plugin.mjs";
import { inlineCardsPlugin } from "./scripts/telegram/inline-cards-vite-plugin.mjs";
import { apiDocsProxyGuard } from "./scripts/api-docs-proxy-guard.mjs";

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
    dockerSourceHmrPlugin(),
    react(),
    raidsFixturePlugin(fileURLToPath(new URL(".", import.meta.url))),
    authSessionPlugin(),
    automationPlugin(fileURLToPath(new URL(".", import.meta.url))),
    catalogueSyncPlugin(fileURLToPath(new URL(".", import.meta.url))),
    cataloguePlugin(fileURLToPath(new URL(".", import.meta.url))),
    inlineCardsPlugin(fileURLToPath(new URL(".", import.meta.url))),
    apiDocsProxyGuard(),
    {
      name: "api-docs-entry",
      configureServer: redirectApiDocs,
      configurePreviewServer: redirectApiDocs,
    },
  ],
  server: {
    ...devServerOptions(4174),
    proxy: {
      "^/api/": {
        target: "https://cargohustle.online",
        changeOrigin: true,
        secure: true,
        configure(proxy) {
          installCatalogueCapture(
            proxy,
            fileURLToPath(new URL(".", import.meta.url)),
          );
          proxy.on("proxyReq", (proxyRequest) => {
            proxyRequest.removeHeader("x-madhouse-allow-mutations");
          });
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
