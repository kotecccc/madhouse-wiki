import { readFileSync } from "node:fs";
import { createProductionApi } from "../scripts/deploy/production-api.mjs";
const contract = JSON.parse(
  readFileSync(
    new URL("../public/api-docs/openapi.readonly.json", import.meta.url),
    "utf8",
  ),
);
const paths = Object.keys(contract.paths).filter(
  (path) => contract.paths[path].get,
);
export function createProxy(fetcher = fetch) {
  const transport = createProductionApi(paths, fetcher);
  return async (request, response) => {
    const raw = request.url || "";
    const url =
      raw.startsWith("/api/") &&
      !/[%\\#]/.test(raw.split("?")[0].replace(/%24/gi, "$"))
        ? raw
        : "/invalid";
    const headers = new Headers();
    if (typeof request.headers.authorization === "string")
      headers.set("authorization", request.headers.authorization);
    const result = await transport(
      new Request("https://wiki.invalid" + url, {
        method: request.method,
        headers,
      }),
    );
    response.statusCode = result.status;
    for (const [key, value] of result.headers) response.setHeader(key, value);
    response.end(Buffer.from(await result.arrayBuffer()));
  };
}
export default createProxy();
