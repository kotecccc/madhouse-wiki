import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

const readJson = async (path) =>
  JSON.parse(await readFile(new URL(path, import.meta.url), "utf8"));
const spec = await readJson("../public/api-docs/openapi.json");
const collection = await readJson(
  "../docs/postman/madhouse.postman_collection.json",
);
const environment = await readJson(
  "../docs/postman/madhouse.postman_environment.json",
);
const coverage = await readJson("../docs/api-response-coverage.json");
const readonly = await readJson("../public/api-docs/openapi.readonly.json");
const swagger = await readJson("../public/api-docs/openapi.swagger.json");
const methods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
]);
const normalize = (path) => path.replace(/\{[^}]+\}/g, "{}");
const operations = new Map();
for (const [path, item] of Object.entries(spec.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    if (!methods.has(method)) continue;
    const key = `${method.toUpperCase()} ${normalize(path)}`;
    assert(!operations.has(key), `Duplicate operation: ${key}`);
    operations.set(key, operation);
    assert(
      Object.keys(operation.responses).length,
      `Missing responses: ${key}`,
    );
    for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map(
      (match) => match[1],
    )) {
      assert(
        operation.parameters?.some(
          (p) => p.in === "path" && p.name === name && p.required,
        ),
        `Missing path parameter ${name}: ${key}`,
      );
    }
  }
}
function* requests(items) {
  for (const item of items) {
    if (item.item) yield* requests(item.item);
    else yield item;
  }
}
const seen = new Set();
for (const item of requests(collection.item)) {
  const path = item.request.url.raw
    .replace(/^\{\{baseUrl\}\}/, "")
    .split("?")[0]
    .replace(/\{\{([^}]+)\}\}/g, "{$1}");
  const key = `${item.request.method} ${normalize(path)}`;
  assert(operations.has(key), `Postman operation absent in OpenAPI: ${key}`);
  assert(!seen.has(key), `Duplicate Postman operation: ${key}`);
  seen.add(key);
  const operation = operations.get(key);
  const query = operation.parameters?.filter((p) => p.in === "query") ?? [];
  assert.deepEqual(
    (item.request.url.query ?? []).map((p) => p.key).sort(),
    query.map((p) => p.name).sort(),
    `Postman query parameters differ: ${key}`,
  );
  for (const parameter of query.filter((p) => p.required)) {
    assert(
      !item.request.url.query.find((p) => p.key === parameter.name).disabled,
      `Required query parameter disabled: ${key} ${parameter.name}`,
    );
  }
  const schema = operation.requestBody?.content?.["application/json"]?.schema;
  assert.equal(
    Boolean(item.request.body),
    Boolean(schema),
    `Postman request body presence differs: ${key}`,
  );
  if (schema?.properties) {
    const raw = item.request.body.raw;
    const substituted = raw.replace(/\{\{([^}]+)\}\}/g, (_, name) => {
      const type = schema.properties[name]?.type;
      if (type === "array") return "[]";
      if (type === "object") return "{}";
      if (type === "boolean") return "false";
      return "1";
    });
    const body = JSON.parse(substituted);
    for (const name of schema.required ?? []) {
      assert(
        Object.hasOwn(body, name),
        `Missing Postman body field: ${key} ${name}`,
      );
    }
    for (const [name, property] of Object.entries(schema.properties)) {
      if (!Object.hasOwn(body, name) || !property.type) continue;
      const types = Array.isArray(property.type)
        ? property.type
        : [property.type];
      const value = body[name];
      const actual = Array.isArray(value)
        ? "array"
        : value === null
          ? "null"
          : typeof value;
      assert(
        types.includes(actual) ||
          (actual === "number" &&
            types.includes("integer") &&
            Number.isInteger(value)),
        `Postman body placeholder has wrong JSON type: ${key} ${name}`,
      );
    }
  }
}
assert.equal(
  seen.size,
  operations.size,
  "Postman/OpenAPI operation count differs",
);
const variables = new Map(
  environment.values.map((item) => [item.key, item.value]),
);
assert.equal(
  variables.size,
  environment.values.length,
  "Duplicate environment variable",
);
assert.equal(
  variables.get("accessToken"),
  "",
  "Environment must not retain credentials",
);
assert.equal(
  String(variables.get("allowMutations")),
  "false",
  "Mutations must default to disabled",
);
const observed = new Set();
for (const entry of coverage) {
  const operation = spec.paths[entry.path]?.[entry.method.toLowerCase()];
  assert(operation, `Unknown coverage route: ${entry.path}`);
  assert.equal(
    operation.responses[entry.status]?.["x-evidence"],
    "network-response-shape",
  );
  assert.equal(
    operation.responses[entry.status]?.["x-sample-count"],
    entry.samples,
  );
  observed.add(`${entry.method} ${entry.path}`);
}
for (const [key, operation] of operations) {
  for (const status of operation["x-observed-response-statuses"] ?? []) {
    assert.equal(
      operation.responses[status]?.["x-evidence"],
      "network-response-shape",
      `Missing response evidence: ${key}`,
    );
  }
}
const getPaths = Object.entries(spec.paths)
  .filter(([, item]) => item.get)
  .map(([path]) => path)
  .sort();
assert.deepEqual(Object.keys(readonly.paths).sort(), getPaths);
for (const [path, item] of Object.entries(readonly.paths)) {
  assert.deepEqual(
    Object.keys(item),
    ["get"],
    `Non-GET operation exposed: ${path}`,
  );
  assert(
    /[А-Яа-яЁё]/.test(item.get.summary),
    `Missing Russian summary: ${path}`,
  );
  assert(
    /[А-Яа-яЁё]/.test(item.get.description),
    `Missing Russian description: ${path}`,
  );
  assert(
    !item.get.requestBody,
    `Request body exposed in read-only method: ${path}`,
  );
  for (const parameter of item.get.parameters ?? []) {
    assert(
      /[А-Яа-яЁё]/.test(parameter.description),
      `Missing Russian parameter: ${path} ${parameter.name}`,
    );
  }
}
assert.deepEqual(
  Object.keys(swagger.paths).sort(),
  Object.keys(spec.paths).sort(),
  "Swagger path inventory differs from the full source specification",
);
const swaggerOperations = new Map();
for (const [path, item] of Object.entries(swagger.paths)) {
  for (const [method, operation] of Object.entries(item)) {
    const key = `${method.toUpperCase()} ${normalize(path)}`;
    assert(operations.has(key), `Swagger operation absent from source: ${key}`);
    swaggerOperations.set(key, operation);
    if (method !== "get")
      assert.equal(
        operation["x-madhouse-mutation-gate"],
        "X-Madhouse-Allow-Mutations: true",
        `Missing mutation gate declaration: ${key}`,
      );
  }
}
assert.equal(
  swaggerOperations.size,
  operations.size,
  "Swagger operation inventory differs from the full source specification",
);
assert.deepEqual(
  swagger.servers.map((server) => server.url),
  ["/"],
);
const html = await readFile(
  new URL("../public/api-docs/index.html", import.meta.url),
  "utf8",
);
assert(html.includes('src="./wiki-auth.js"'));
assert(html.includes('id="api-mutations-enabled"'));
assert(html.includes('href="./realtime.json"'));
const authScript = await readFile(
  new URL("../public/api-docs/wiki-auth.js", import.meta.url),
  "utf8",
);
let swaggerConfig;
let authorized = false;
const mutationToggle = { checked: false, addEventListener() {} };
runInNewContext(authScript.replace(/^import[\s\S]*?;\n/, ""), {
  URL,
  window: {
    location: { origin: "https://wiki.invalid" },
    SwaggerUIBundle(config) {
      swaggerConfig = config;
    },
  },
  document: {
    getElementById(id) {
      return id === "api-mutations-enabled"
        ? mutationToggle
        : { textContent: "" };
    },
  },
  readSession() {
    return { status: "empty" };
  },
  formatExpiry() {
    return "Токен не добавлен";
  },
  subscribeSession() {},
  setInterval() {},
  authorizeRequest(request) {
    authorized = true;
    return request;
  },
});
assert.equal(swaggerConfig.url, "./openapi.swagger.json");
assert.equal(
  Array.from(swaggerConfig.supportedSubmitMethods).join(","),
  "get,post,put,patch,delete",
);
const blockedMutation = {
  method: "POST",
  url: "/api/works/tasks/perform",
  headers: {},
};
assert.throws(
  () => swaggerConfig.requestInterceptor(blockedMutation),
  /переключатель/,
);
mutationToggle.checked = true;
const allowedMutation = {
  method: "POST",
  url: "/api/works/tasks/perform",
  headers: {},
};
assert.equal(
  swaggerConfig.requestInterceptor(allowedMutation),
  allowedMutation,
);
assert.equal(allowedMutation.headers["X-Madhouse-Allow-Mutations"], "true");
const getRequest = { method: "GET", url: "/api/me", headers: {} };
assert.equal(swaggerConfig.requestInterceptor(getRequest), getRequest);
assert(authorized, "Swagger must use the shared Wiki JWT interceptor");
const unauthenticatedRequest = {
  method: "POST",
  url: "/api/auth/telegram",
  headers: {},
};
assert.equal(
  swaggerConfig.requestInterceptor(unauthenticatedRequest),
  unauthenticatedRequest,
);
console.log(
  `${Object.keys(spec.paths).length} paths; ${operations.size}/${seen.size} OpenAPI/Postman operations; ${observed.size} operations with captured JSON response structures.`,
);
console.log(
  `${getPaths.length} Russian GET methods; ${swaggerOperations.size} Swagger operations; mutations require the page toggle.`,
);
console.log(
  "Structural consistency passed. This does not establish completeness of the server contract.",
);
