import { readFileSync } from "node:fs";
const source = () =>
  readFileSync(new URL("../shared/auth-session.js", import.meta.url), "utf8");
export function authSessionPlugin() {
  let connector = null;
  return {
    name: "shared-wiki-auth",
    configResolved(config) {
      connector = config.env.VITE_TELEGRAM_CONNECTOR_ORIGIN || null;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/auth-session.js") return next();
        response.setHeader("Content-Type", "application/javascript");
        response.setHeader("Cache-Control", "no-store");
        response.end(source());
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "connection-config.json",
        source: JSON.stringify({ origin: connector, protocolVersion: 1 }),
      });
      this.emitFile({
        type: "asset",
        fileName: "auth-session.js",
        source: source(),
      });
    },
  };
}
