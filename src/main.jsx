import "./styles/tokens.css";
import "./styles/global.css";
import { createRoot } from "react-dom/client";
import { App } from "./app/App/App.jsx";
const root = createRoot(document.getElementById("root"));
if (
  import.meta.env.DEV &&
  window.location.pathname.replace(/\/$/, "") === "/ui"
) {
  import("./app/UIKitPage/UIKitPage.jsx")
    .then(({ UIKitPage }) => root.render(<UIKitPage />))
    .catch((error) => {
      root.render(
        <pre
          style={{
            color: "var(--text-primary)",
            whiteSpace: "pre-wrap",
            padding: "var(--space-24)",
          }}
        >
          Не удалось загрузить UI-кит: {String(error?.stack || error)}
        </pre>,
      );
    });
} else {
  root.render(<App />);
}
