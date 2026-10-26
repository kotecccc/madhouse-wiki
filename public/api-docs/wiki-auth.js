import {
  authorizeRequest,
  readSession,
  formatExpiry,
  subscribeSession,
} from "/auth-session.js";

const status = document.getElementById("wiki-auth-status");
const mutationToggle = document.getElementById("api-mutations-enabled");
const update = () => {
  status.textContent = formatExpiry(readSession());
};
update();
subscribeSession(update);
setInterval(update, 1000);
window.ui = window.SwaggerUIBundle({
  url: "./openapi.swagger.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  displayRequestDuration: true,
  persistAuthorization: false,
  // Keep the interceptor's bearer token out of Swagger's rendered cURL.
  showMutatedRequest: false,
  tryItOutEnabled: false,
  supportedSubmitMethods: ["get", "post", "put", "patch", "delete"],
  defaultModelsExpandDepth: -1,
  validatorUrl: null,
  requestInterceptor(request) {
    const method = (request.method || "GET").toUpperCase();
    if (method !== "GET") {
      if (!mutationToggle.checked)
        throw new Error(
          "Включите переключатель над списком, чтобы отправить изменяющий запрос.",
        );
      request.headers = {
        ...request.headers,
        "X-Madhouse-Allow-Mutations": "true",
      };
    }
    const url = new URL(request.url, window.location.origin);
    if (
      url.pathname === "/api/auth/telegram" ||
      url.pathname === "/api/auth/dev-userid"
    )
      return request;
    return authorizeRequest(request);
  },
});
