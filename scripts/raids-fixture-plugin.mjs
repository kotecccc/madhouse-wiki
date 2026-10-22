import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseRaidPageQuery,
  raidFeedPage,
} from "./telegram/raid-feed-page.mjs";

// Use an available local fixture for development. Never bundle it into the client.
// MADHOUSE_RAIDS_FIXTURE=0 opts out; =1 requires the fixture to exist.
export function raidsFixturePlugin(root) {
  return {
    name: "local-raids-fixture",
    apply: "serve",
    configureServer(server) {
      if (process.env.MADHOUSE_RAIDS_FIXTURE === "0") return;
      const file = resolve(root, "artifacts/development/raids-production.json");
      if (!existsSync(file) && process.env.MADHOUSE_RAIDS_FIXTURE !== "1")
        return;
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (!Array.isArray(data.posts))
        throw new Error("Invalid local raid fixture");
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== "/api/raids") return next();
        let result;
        try {
          const query = parseRaidPageQuery(
            new URL(request.url, "http://localhost"),
          );
          result = query ? raidFeedPage(data.posts, query) : data;
        } catch {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ error: "invalid_request" }));
          return;
        }
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Madhouse-Data-Source": "local-production-fixture",
        });
        response.end(JSON.stringify(result));
      });
    },
  };
}
