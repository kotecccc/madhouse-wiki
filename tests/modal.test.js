import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("shared page uses a labelled surface with a separate body and optional actions", async () => {
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
    const render = (footer, footerNote, footerStart) =>
      renderToStaticMarkup(
        createElement(
          Modal,
          {
            title: "Дроп",
            titleId: "drop-title",
            onClose() {},
            footer,
            footerNote,
            footerStart,
          },
          createElement("ul", null, createElement("li", null, "Предмет")),
        ),
      );
    const html = render();
    assert.equal((html.match(/<section\b/g) || []).length, 1);
    assert.doesNotMatch(html, /<dialog\b/);
    assert.match(html, /aria-labelledby="drop-title"/);
    assert.match(html, /<header[^>]*>[\s\S]*<h2[^>]*id="drop-title"/);
    assert.match(html, /<\/header><div class="shared-modal-content"><ul>/);
    assert.match(html, /aria-label="Назад"/);
    assert.doesNotMatch(html, /shared-modal-toast-anchor|ui-toast-stack/);
    assert.match(
      html,
      /<footer class="shared-modal-footer shared-modal-mobile-footer"><button[^>]*>Назад<\/button><\/footer>/,
    );
    assert.match(
      render(createElement("button", null, "Готово")),
      /<\/div><footer class="shared-modal-footer"><button>Готово<\/button><\/footer>/,
    );
    const withNote = render(undefined, "Обновлено недавно");
    const footerMarkup = withNote.slice(withNote.indexOf("<footer"));
    assert.match(footerMarkup, /Обновлено недавно/);
    assert.match(footerMarkup, /Назад/);
    assert.doesNotMatch(footerMarkup, /shared-modal-mobile-footer/);
    const split = render(
      undefined,
      "Последнее обновление",
      createElement("button", null, "Обновить"),
    );
    const splitFooter = split.slice(split.indexOf("<footer"));
    assert.match(splitFooter, /shared-modal-footer--split/);
    assert.match(splitFooter, /shared-modal-footer-note--center/);
    assert.ok(
      splitFooter.indexOf("Обновить") <
        splitFooter.indexOf("Последнее обновление"),
    );
    assert.ok(
      splitFooter.indexOf("Последнее обновление") <
        splitFooter.indexOf("Назад"),
    );
  } finally {
    await server.close();
  }
});
