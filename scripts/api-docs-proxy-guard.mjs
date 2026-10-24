import { readFileSync } from "node:fs";
import { listApiOperations } from "./api-operations.mjs";

const source = JSON.parse(
  readFileSync(
    new URL("../public/api-docs/openapi.json", import.meta.url),
    "utf8",
  ),
);
const routes = listApiOperations(source).map(({ path, method }) => {
  const pattern = new RegExp(
    "^" +
      path
        .split(/(\{[^}]+\})/)
        .map((part) =>
          part.startsWith("{")
            ? "[A-Za-z0-9_$-]+"
            : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        )
        .join("") +
      "$",
  );
  return { pattern, method: method.toUpperCase() };
});

export function apiDocsProxyGuard() {
  return {
    name: "documented-api-mutation-guard",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const method = (request.method || "GET").toUpperCase();
        const pathname = new URL(
          request.url || "/",
          "http://localhost",
        ).pathname.replace(/%24/gi, "$");
        const pathRoutes = routes.filter((route) =>
          route.pattern.test(pathname),
        );
        if (!pathRoutes.length) return next();
        const route = pathRoutes.find(
          (candidate) => candidate.method === method,
        );
        if (!route) {
          response.writeHead(405, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-store, max-age=0",
            Allow: [...new Set(pathRoutes.map((candidate) => candidate.method))]
              .sort()
              .join(", "),
          });
          response.end(
            JSON.stringify({
              error: "Method is not documented for this route",
            }),
          );
          return;
        }
        if (
          method !== "GET" &&
          request.headers["x-madhouse-allow-mutations"] !== "true"
        ) {
          response.writeHead(403, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "private, no-store, max-age=0",
          });
          response.end(
            JSON.stringify({
              error:
                "State-changing requests require X-Madhouse-Allow-Mutations: true",
            }),
          );
          return;
        }
        next();
      });
    },
  };
}
