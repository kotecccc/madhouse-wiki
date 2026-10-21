import { readFileSync } from "node:fs";
const source = (name = "auth-session.js") =>
  readFileSync(new URL("../shared/" + name, import.meta.url), "utf8");
export function authSessionPlugin() {
  let connector = null;
  return {
    name: "shared-wiki-auth",
    configResolved(config) {
      connector = config.env.VITE_TELEGRAM_CONNECTOR_ORIGIN || null;
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const name = request.url?.split("?")[0]?.slice(1);
        if (!["auth-session.js", "telegram-context.js"].includes(name))
          return next();
        response.setHeader("Content-Type", "application/javascript");
        response.setHeader("Cache-Control", "no-store");
        response.end(source(name));
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "connection-config.json",
        source: JSON.stringify({ origin: connector, protocolVersion: 1 }),
      });
      for (const name of ["auth-session.js", "telegram-context.js"])
        this.emitFile({
          type: "asset",
          fileName: name,
          source: source(name),
        });
    },
  };
}
