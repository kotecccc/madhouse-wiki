import {
  authorizeRequest,
  readSession,
  formatExpiry,
  subscribeSession,
} from "/auth-session.js";

const status = document.getElementById("wiki-auth-status");
const update = () => {
  status.textContent = formatExpiry(readSession());
};
update();
subscribeSession(update);
setInterval(update, 1000);
window.ui = window.SwaggerUIBundle({
  url: "./openapi.readonly.json",
  dom_id: "#swagger-ui",
  deepLinking: true,
  displayRequestDuration: true,
  persistAuthorization: false,
  tryItOutEnabled: false,
  supportedSubmitMethods: ["get"],
  defaultModelsExpandDepth: -1,
  validatorUrl: null,
  requestInterceptor(request) {
    if ((request.method || "GET").toUpperCase() !== "GET")
      throw new Error(
        "В этом Swagger разрешены только запросы на чтение (GET).",
      );
    return authorizeRequest(request);
  },
});
