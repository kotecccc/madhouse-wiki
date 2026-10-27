import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";

test("menu items use the shared menu variant and preserve warning and disabled states", async () => {
  const server = await createServer({
    configFile: false,
    plugins: [react()],
    server: { middlewareMode: true, hmr: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    appType: "custom",
  });
  try {
    const React = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { MenuItem } = await server.ssrLoadModule(
      "/src/components/ui/MenuItem/MenuItem.jsx",
    );
    const { BaseCard } = await server.ssrLoadModule(
      "/src/components/ui/BaseCard/BaseCard.jsx",
    );
    const selectedCard = renderToStaticMarkup(
      React.createElement(BaseCard, { state: "selected" }, "Выбрано"),
    );
    assert.match(selectedCard, /base-card--selected/);
    const normal = renderToStaticMarkup(
      React.createElement(MenuItem, { icon: "check" }, "Выбрать"),
    );
    assert.match(normal, /button-menu-item/);
    assert.match(normal, /tabler-icon-check/);
    assert.match(normal, /Выбрать/);
    const informational = renderToStaticMarkup(
      React.createElement(
        MenuItem,
        { informational: true, icon: "wrench" },
        "Прочность: 90 / 90",
      ),
    );
    assert.match(informational, /button-menu-item--informational/);
    assert.match(informational, /tabler-icon-tool/);
    assert.doesNotMatch(informational, /<button/);
    const warning = renderToStaticMarkup(
      React.createElement(
        MenuItem,
        { warning: true, disabled: true },
        "Точно?",
      ),
    );
    assert.match(warning, /button-warning/);
    assert.match(warning, /button-menu-item/);
    assert.match(warning, /disabled=""/);
  } finally {
    await server.close();
  }
});
