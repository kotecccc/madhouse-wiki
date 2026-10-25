const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

export function listApiOperations(contract) {
  return Object.entries(contract.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) => HTTP_METHODS.has(method))
      .map(([method, operation]) => {
        const security = Object.hasOwn(operation, "security")
          ? operation.security
          : contract.security;
        return {
          path,
          method,
          requiresAuth: !Array.isArray(security) || security.length > 0,
          allowsDevKey: path === "/api/auth/dev-userid" && method === "post",
        };
      }),
  );
}
