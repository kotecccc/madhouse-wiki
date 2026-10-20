import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("shared modal uses one surface with a separate body and optional actions", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const { Modal } = await server.ssrLoadModule(
      "/src/components/ui/Modal/Modal.jsx",
    );
    const render = (footer) =>
      renderToStaticMarkup(
        createElement(
          Modal,
          { title: "Дроп", titleId: "drop-title", onClose() {}, footer },
          createElement("ul", null, createElement("li", null, "Предмет")),
        ),
      );
    const html = render();
    assert.equal((html.match(/<dialog\b/g) || []).length, 1);
    assert.match(html, /<dialog[^>]*base-card--modal/);
    assert.match(html, /aria-labelledby="drop-title"/);
    assert.match(html, /<header[^>]*>[\s\S]*<h2[^>]*id="drop-title"/);
    assert.match(html, /<\/header><div class="shared-modal-content"><ul>/);
    assert.ok(!html.includes("<section"));
    assert.ok(!html.includes("<footer"));
    assert.match(
      render(createElement("button", null, "Готово")),
      /<\/div><footer class="shared-modal-footer"><button>Готово<\/button><\/footer>/,
    );
  } finally {
    await server.close();
  }
});
